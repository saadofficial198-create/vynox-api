import express from 'express';
import Site from '../models/Site.js';
import Snapshot from '../models/Snapshot.js';
import Alert from '../models/Alert.js';

const router = express.Router();

function startsYes(v) { return typeof v === 'string' && /^yes/i.test(v); }

function hostFromUrl(url) {
  try { const u = new URL(url); return u.hostname + (u.pathname.length > 1 ? u.pathname.replace(/\/$/, '') : ''); }
  catch { return url; }
}

// deriveAlerts(site, snap) — unchanged. Produces the "currently detected"
// alert list straight from a snapshot's raw payload.
function deriveAlerts(site, snap) {
  if (!snap || !snap.ok || !snap.data) return [];
  const d = snap.data;
  const sec     = d.security || {};
  const malware = d.malware  || {};
  const updates = d.updates  || {};
  const health  = d.health?.tests || {};
  const disk    = d.disk     || {};
  const backups = d.backups  || {};
  const logins  = d.logins   || {};

  const at = snap.fetchedAt || new Date();
  const host = hostFromUrl(site.url);
  const out = [];

  const push = (key, name, desc, type, severity) => {
    out.push({
      id: `${site._id}-${key}`,
      key,
      siteId: String(site._id),
      siteUrl: site.url,
      site: host,
      siteLabel: site.name,
      name, desc, type, severity,
      sevLabel:   severity === 'high' ? 'High' : severity === 'medium' ? 'Medium' : 'Low',
      sevCls:     severity === 'high' ? 'sev-high' : severity === 'medium' ? 'sev-med' : 'sev-low',
      first: at, last: at,
      status: 'active',
    });
  };

  if (malware.suspicious_count > 0) {
    push('malware', 'Malware Detected', `${malware.suspicious_count} suspicious file(s) found in uploads`, 'Malware', 'high');
  } else if (malware.php_files_count > 0) {
    push('uploads-php', 'PHP Files in Uploads', `${malware.php_files_count} PHP file(s) in uploads directory — should only contain media`, 'Malware', 'medium');
  }

  if (updates.core_update_available === 'yes') {
    push('core-update', 'WordPress Core Update Available', `New version ${updates.core_new_version || ''} available`, 'Core Update', 'medium');
  }
  (updates.plugin_list || []).forEach((p, i) => {
    push('plugin-' + i, `Plugin Update: ${p.name}`, `${p.current} → ${p.latest}`, 'Plugin', 'medium');
  });
  (updates.theme_list || []).forEach((t, i) => {
    push('theme-' + i, `Theme Update: ${t.name}`, `${t.current} → ${t.latest}`, 'Plugin', 'medium');
  });

  if (startsYes(sec.file_editor_enabled)) {
    push('file-editor', 'File Editor Enabled', 'Anyone with admin access can edit theme/plugin code from WP admin. Set DISALLOW_FILE_EDIT in wp-config.php', 'Server', 'medium');
  }
  if (startsYes(sec.admin_path_default)) {
    push('admin-path', 'Default Login Path', 'wp-login.php is at the default path — easy target for brute-force attacks', 'Login Security', 'low');
  }
  if (/^no/i.test(sec.ssl_enabled || '')) {
    push('ssl', 'SSL Not Enabled', 'Site is not served over HTTPS', 'SSL', 'high');
  }

  Object.entries(health).forEach(([k, t]) => {
    if (!t || !t.status) return;
    const label = t.label || k;
    const badge = t.badge ? `Site Health · ${t.badge}` : 'Site Health';
    if (t.status === 'critical')         push('health-' + k, label, badge, 'Server', 'high');
    else if (t.status === 'recommended') push('health-' + k, label, badge, 'Server', 'low');
  });

  if (typeof disk.disk_used_percent === 'string') {
    const pct = parseFloat(disk.disk_used_percent);
    if (pct > 90)      push('disk', 'Low Disk Space',  `Disk ${disk.disk_used_percent} used`, 'Server', 'high');
    else if (pct > 80) push('disk', 'High Disk Usage', `Disk ${disk.disk_used_percent} used`, 'Server', 'medium');
  }

  if (backups.wpvivid_active === false) {
    push('no-backup', 'No Backup Plugin', 'No WPvivid backup plugin detected on this site', 'Server', 'medium');
  } else if (backups.backup_count === 0) {
    push('no-backups', 'No Backups Found', 'WPvivid is active but no backups exist yet', 'Server', 'medium');
  }

  if (logins.failed_last_24h > 10) {
    push('failed-logins', 'Multiple Failed Logins', `${logins.failed_last_24h} failed login attempts in last 24h`, 'Login Security', 'high');
  }

  // Page-selection health — these don't come from the snapshot's connector
  // payload (they're about OUR monitoring config, not the site's own
  // security), but deriveAlerts is the one place that already produces
  // "currently detected" alerts each scan, so it's the natural spot for
  // them. See models/Site.js's pagesConfigured + MonitoredPageSchema.
  if (!site.pagesConfigured) {
    push(
      'pages-not-configured',
      'Monitored Pages Not Configured',
      'This site was registered but no pages have been selected for screenshots/PageSpeed yet. Open Settings and choose which pages to monitor — captures are paused until then.',
      'Configuration',
      'medium'
    );
  } else {
    (site.monitoredPages || []).forEach((p) => {
      if (p.enabled !== false && p.matchStatus === 'mismatch') {
        push(
          `page-mismatch-${p.label}`,
          `Page Slug Changed: ${p.label}`,
          `"${p.label}" (${p.path}) was not found in the site's sitemap during the last scan — the page may have been renamed or removed. Screenshot/PageSpeed capture for this page is paused. Re-select the correct page in Settings.`,
          'Configuration',
          'medium'
        );
      }
    });
  }

  return out;
}

const SEV_RANK = { high: 0, medium: 1, low: 2 };

function toResponseShape(doc, site) {
  const host = site ? hostFromUrl(site.url) : '';
  return {
    id: `${doc.site}-${doc.key}`,
    siteId: String(doc.site),
    siteUrl: site?.url || '',
    site: host,
    siteLabel: site?.name || 'Unknown site',
    name: doc.name,
    desc: doc.desc,
    type: doc.type,
    severity: doc.severity,
    sevLabel: doc.severity === 'high' ? 'High' : doc.severity === 'medium' ? 'Medium' : 'Low',
    sevCls:   doc.severity === 'high' ? 'sev-high' : doc.severity === 'medium' ? 'sev-med' : 'sev-low',
    first: doc.firstSeenAt,
    last: doc.lastSeenAt,
    status: doc.status,
  };
}

// syncAlertsForSite(site, snap) — upserts the derived alert list for one site
// into the Alert collection, and resolves any previously-active alerts that
// are no longer detected. Also folds in the synthetic "site is down" alert
// (key 'site-down') so it persists/resolves through the same mechanism.
//
// Returns { created: [...AlertDocs], resolved: [...AlertDocs] } so callers
// (the daily scan job) can decide whether to fire emails — e.g. a brand new
// 'high' severity alert, or a fresh site-down.
async function syncAlertsForSite(site, snap) {
  const derived = deriveAlerts(site, snap);

  // Fold the site-down case into the same key-based scheme.
  if (site.status === 'offline') {
    const host = hostFromUrl(site.url);
    derived.push({
      key: 'site-down',
      name: 'Site is Down',
      desc: `${site.name || host} is not responding — checked at ${site.lastCheckedAt ? new Date(site.lastCheckedAt).toLocaleString() : 'unknown'}`,
      type: 'Uptime',
      severity: 'high',
    });
  }

  const now = new Date();
  const seenKeys = derived.map(a => a.key);
  const created = [];
  const touched = [];

  for (const a of derived) {
    const before = await Alert.findOne({ site: site._id, key: a.key }).lean();
    const doc = await Alert.findOneAndUpdate(
      { site: site._id, key: a.key },
      {
        $set: {
          name: a.name,
          desc: a.desc,
          type: a.type,
          severity: a.severity,
          status: 'active',
          lastSeenAt: now,
          resolvedAt: null,
        },
        $setOnInsert: { firstSeenAt: now },
      },
      { upsert: true, new: true }
    );
    touched.push(doc);
    if (!before) created.push(doc);
  }

  // Resolve anything previously active for this site that's no longer detected.
  const resolvedResult = await Alert.find({
    site: site._id,
    status: 'active',
    key: { $nin: seenKeys },
  });
  if (resolvedResult.length) {
    await Alert.updateMany(
      { _id: { $in: resolvedResult.map(r => r._id) } },
      { $set: { status: 'resolved', resolvedAt: now } }
    );
  }

  return { created, resolved: resolvedResult };
}

// GET /api/alerts — all active alerts across all sites, read from the
// persisted Alert collection. We opportunistically re-sync any site whose
// latest snapshot is newer than the alert rows we have, so the list stays
// fresh without needing a separate cron just for this.
router.get('/', async (_req, res) => {
  const sites = await Site.find().lean();
  const siteMap = new Map(sites.map(s => [String(s._id), s]));

  for (const site of sites) {
    const snap = await Snapshot.findOne({ site: site._id, ok: true }).sort({ fetchedAt: -1 }).lean();
    const latestAlert = await Alert.findOne({ site: site._id }).sort({ updatedAt: -1 }).lean();
    const snapTime = snap?.fetchedAt ? new Date(snap.fetchedAt).getTime() : 0;
    const alertTime = latestAlert?.updatedAt ? new Date(latestAlert.updatedAt).getTime() : 0;

    // Re-sync if we have a newer snapshot than our last alert sync, OR the
    // site is offline and we haven't recorded a site-down alert yet (so the
    // offline state shows up immediately even without a fresh snapshot).
    const offlineNeedsSync = site.status === 'offline' &&
      !(await Alert.exists({ site: site._id, key: 'site-down', status: 'active' }));

    if (snap && snapTime > alertTime) {
      await syncAlertsForSite(site, snap);
    } else if (offlineNeedsSync) {
      await syncAlertsForSite(site, snap);
    }
  }

  const active = await Alert.find({ status: 'active' }).lean();
  active.sort((a, b) => {
    const rank = (SEV_RANK[a.severity] ?? 3) - (SEV_RANK[b.severity] ?? 3);
    if (rank !== 0) return rank;
    return new Date(b.lastSeenAt || 0) - new Date(a.lastSeenAt || 0);
  });

  const alerts = active.map(doc => toResponseShape(doc, siteMap.get(String(doc.site))));
  res.json({ ok: true, alerts });
});

export default router;
export { deriveAlerts, syncAlertsForSite };
