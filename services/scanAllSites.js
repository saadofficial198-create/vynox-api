import axios from 'axios';
import Site from '../models/Site.js';
import Snapshot from '../models/Snapshot.js';
import { deriveHealthStatus } from './healthStatus.js';
import { syncAlertsForSite } from '../routes/alerts.js';
import { sendAlertEmail } from './email.js';
import { refreshPageMatchStatus } from './sitemapDetect.js';

// Same connector-call helper as routes/sites.js (kept local — small enough
// not to be worth its own shared module).
function cleanUrl(url) {
  return String(url || '').trim().replace(/\/$/, '');
}

async function callConnector(url, apiKey, path, timeoutMs = 10000) {
  return axios.get(`${cleanUrl(url)}/wp-json/vynox/v1${path}`, {
    headers: { 'X-Vynox-Key': apiKey },
    timeout: timeoutMs,
    validateStatus: () => true,
  });
}

function hostFromUrl(url) {
  try { const u = new URL(url); return u.hostname + (u.pathname.length > 1 ? u.pathname.replace(/\/$/, '') : ''); }
  catch { return url; }
}

// scanOneSite(site) — pulls /wp-json/vynox/v1/data for one site, stores a
// Snapshot, and updates Site.latest/status. This replaces what the old
// POST /:id/sync HTTP endpoint used to do, minus the manual-trigger part.
// Returns { site, snap, wentOffline } so the caller can decide about emails.
async function scanOneSite(site) {
  const wasOnline = site.status === 'online' || site.status === 'unknown';
  let snap = null;
  let wentOffline = false;

  try {
    const r = await callConnector(site.url, site.apiKey, '/data', 60000);
    if (r.status !== 200) {
      snap = await Snapshot.create({ site: site._id, ok: false, error: `HTTP ${r.status}`, data: r.data });
      await Site.findByIdAndUpdate(site._id, { status: 'offline', lastCheckedAt: new Date() });
      wentOffline = wasOnline;
      return { site, snap, wentOffline };
    }

    snap = await Snapshot.create({ site: site._id, ok: true, data: r.data });
    const latest = deriveHealthStatus(r.data);
    await Site.findByIdAndUpdate(site._id, {
      $set: {
        status: 'online',
        lastCheckedAt: new Date(),
        lastSyncedAt: new Date(),
        latest,
        ...(r.data?.site?.wp_version ? { wpVersion: r.data.site.wp_version } : {}),
      },
    });
    return { site, snap, wentOffline: false };
  } catch (e) {
    snap = await Snapshot.create({ site: site._id, ok: false, error: e.message }).catch(() => null);
    await Site.findByIdAndUpdate(site._id, { status: 'offline', lastCheckedAt: new Date() }).catch(() => {});
    wentOffline = wasOnline;
    return { site, snap, wentOffline };
  }
}

function siteDownEmail(site) {
  const host = hostFromUrl(site.url);
  return sendAlertEmail({
    subject: `[Vynox] Site Down: ${site.name || host}`,
    text: `${site.name || host} (${site.url}) failed to respond during the daily security scan and has been marked offline.`,
    html: `<p><strong>${site.name || host}</strong> (${site.url}) failed to respond during the daily security scan and has been marked offline.</p>`,
  });
}

function newHighAlertEmail(site, alertDoc) {
  const host = hostFromUrl(site.url);
  return sendAlertEmail({
    subject: `[Vynox] New High-Severity Alert: ${site.name || host} — ${alertDoc.name}`,
    text: `A new high-severity alert was detected on ${site.name || host} (${site.url}):\n\n${alertDoc.name}\n${alertDoc.desc || ''}`,
    html: `<p>A new <strong>high-severity</strong> alert was detected on <strong>${site.name || host}</strong> (${site.url}):</p><p><strong>${alertDoc.name}</strong><br/>${alertDoc.desc || ''}</p>`,
  });
}

// scanAllSites() — the daily job. Loops every Site, pulls fresh data,
// stores a Snapshot, updates Site.latest, syncs the persisted Alert
// collection, and fires emails for newly-offline sites or brand new
// high-severity alerts. Returns a small summary object for logging.
export async function scanAllSites() {
  const sites = await Site.find().lean();
  const summary = { total: sites.length, ok: 0, failed: 0, newHighAlerts: 0, wentOffline: 0 };

  for (const site of sites) {
    try {
      const { snap, wentOffline } = await scanOneSite(site);
      if (snap?.ok) summary.ok++; else summary.failed++;

      // Re-fetch the site doc since scanOneSite updated status/latest in Mongo.
      const freshSite = await Site.findById(site._id).lean();

      const { created } = await syncAlertsForSite(freshSite, snap);
      const newHighs = created.filter(a => a.severity === 'high' && a.key !== 'site-down');
      summary.newHighAlerts += newHighs.length;

      if (wentOffline) {
        summary.wentOffline++;
        await siteDownEmail(freshSite).catch(e => console.error('[scan] site-down email failed:', e.message));
      }
      for (const alertDoc of newHighs) {
        await newHighAlertEmail(freshSite, alertDoc).catch(e => console.error('[scan] high-alert email failed:', e.message));
      }

      // Re-check the user's SAVED monitored pages against a fresh sitemap
      // scan, updating each page's matchStatus (ok/mismatch) in place — this
      // does NOT replace the page list itself (that would silently discard
      // the user's own selection, which is exactly the bug this replaced;
      // see services/sitemapDetect.js's refreshPageMatchStatus for the full
      // reasoning). Only runs for sites where the user has actually
      // configured pages (pagesConfigured) — skipping this for
      // unconfigured sites avoids generating "mismatch" noise for pages
      // nobody asked to monitor yet. Never blocks the scan if the sitemap
      // is unreachable; screenshots/PageSpeed just keep using the last
      // known matchStatus either way.
      if (!wentOffline && snap?.ok && freshSite.pagesConfigured) {
        try {
          const { pages, scanOk } = await refreshPageMatchStatus(freshSite);
          if (scanOk) {
            await Site.findByIdAndUpdate(freshSite._id, { $set: { monitoredPages: pages } });
            const mismatched = pages.filter(p => p.matchStatus === 'mismatch');
            if (mismatched.length) {
              console.log(`[scan] ${freshSite.url}: ${mismatched.length} page(s) no longer match the sitemap: ${mismatched.map(p => p.label).join(', ')}`);
            }
          }
        } catch (e) {
          console.log(`[scan] ${freshSite.url}: page match-status refresh failed — ${e.message}`);
        }
      }
    } catch (e) {
      console.error(`[scan] site ${site._id} (${site.url}) failed:`, e.message);
      summary.failed++;
    }
  }

  return summary;
}
