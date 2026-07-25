import express from 'express';
import axios from 'axios';
import Site from '../models/Site.js';
import Snapshot from '../models/Snapshot.js';
import { detectMonitoredPages } from '../services/sitemapDetect.js';
import { deriveHealthStatus } from '../services/healthStatus.js';

const router = express.Router();

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

// POST /api/sites/test — call /ping on a candidate site BEFORE saving
router.post('/test', async (req, res) => {
  const { url, apiKey } = req.body || {};
  if (!url || !apiKey) {
    return res.status(400).json({ ok: false, error: 'url and apiKey are required' });
  }
  try {
    const r = await callConnector(url, apiKey, '/ping');
    if (r.status === 200 && r.data?.ok) {
      return res.json({ ok: true, ping: r.data });
    }
    return res.status(r.status >= 400 ? r.status : 502).json({
      ok: false,
      error: r.data?.message || `Unexpected status ${r.status}`,
      status: r.status,
      raw: r.data,
    });
  } catch (e) {
    return res.status(502).json({
      ok: false,
      error: e.code === 'ECONNABORTED' ? 'Request timed out' : (e.message || 'Connection failed'),
    });
  }
});

// POST /api/sites/register — plugin self-registration (no manual copy/paste).
// Plugin sends { url, apiKey, secret }. We verify the shared enrollment secret,
// confirm the key works via /ping, then upsert the site (re-registering is safe).
router.post('/register', async (req, res) => {
  const { url, apiKey, secret, name } = req.body || {};
  const expected = process.env.VYNOX_ENROLL_SECRET;

  if (!expected) {
    return res.status(500).json({ ok: false, error: 'Server enrollment secret not configured' });
  }
  if (!secret || secret !== expected) {
    return res.status(401).json({ ok: false, error: 'Invalid enrollment secret' });
  }
  if (!url || !apiKey) {
    return res.status(400).json({ ok: false, error: 'url and apiKey are required' });
  }

  const cleaned = cleanUrl(url);
  try {
    // Pure instant DB write — the shared secret already proves authenticity.
    // No network call here, so the plugin always gets a fast 200 (no timeouts).
    const site = await Site.findOneAndUpdate(
      { url: cleaned },
      {
        $set: { apiKey, status: 'unknown', lastCheckedAt: new Date() },
        $setOnInsert: { name: name || cleaned, tags: [], notes: '' },
      },
      { new: true, upsert: true }
    );

    res.json({ ok: true, site });

    // Everything network-bound happens in the BACKGROUND, after the reply:
    // ping (mark online + versions) then full data pull (snapshot + summary).
    (async () => {
      try {
        const ping = await callConnector(cleaned, apiKey, '/ping');
        if (ping.status === 200 && ping.data?.ok) {
          site.status = 'online';
          site.lastCheckedAt = new Date();
          site.connectorVersion = ping.data.connector_version || null;
          site.wpVersion = ping.data.wp_version || null;
          if (ping.data.site_name && site.name === cleaned) site.name = ping.data.site_name;
          await site.save();
        }
        const r = await callConnector(cleaned, apiKey, '/data', 30000);
        if (r.status === 200) {
          await Snapshot.create({ site: site._id, ok: true, data: r.data });
          site.status = 'online';
          site.lastSyncedAt = new Date();
          site.latest = deriveHealthStatus(r.data);
          site.markModified('latest');
          await site.save();
        }
      } catch { /* registration already succeeded; ignore background errors */ }

      // Best-effort: scan the site's sitemap for the real Shop/Contact Us/
      // Track Order slugs so PageSpeed + screenshots hit the right pages
      // instead of the hardcoded guesses. Never blocks registration.
      try {
        const { pages, source } = await detectMonitoredPages(cleaned);
        site.monitoredPages = pages;
        site.markModified('monitoredPages');
        await site.save();
        console.log(`[sitemap] ${cleaned}: pages detected via ${source}`);
      } catch (e) {
        console.log(`[sitemap] ${cleaned}: detection failed — ${e.message}`);
      }
    })();
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// GET /api/sites — list all
router.get('/', async (_req, res) => {
  const sites = await Site.find().sort({ createdAt: -1 }).lean();
  res.json({ ok: true, sites });
});

// POST /api/sites — add new site (tests connection first, then saves)
router.post('/', async (req, res) => {
  const { name, url, apiKey, tags, notes } = req.body || {};
  if (!url || !apiKey) {
    return res.status(400).json({ ok: false, error: 'url and apiKey are required' });
  }
  const cleaned = cleanUrl(url);
  try {
    const r = await callConnector(cleaned, apiKey, '/ping');
    if (r.status !== 200 || !r.data?.ok) {
      return res.status(400).json({
        ok: false,
        error: 'Connection test failed — site not added',
        status: r.status,
        raw: r.data,
      });
    }
    const site = await Site.create({
      name: name || r.data.site_name || cleaned,
      url: cleaned,
      apiKey,
      status: 'online',
      lastCheckedAt: new Date(),
      connectorVersion: r.data.connector_version || null,
      wpVersion: r.data.wp_version || null,
      tags: Array.isArray(tags) ? tags : [],
      notes: notes || '',
    });
    res.json({ ok: true, site });

    // Best-effort, after responding: scan sitemap for real page slugs.
    (async () => {
      try {
        const { pages, source } = await detectMonitoredPages(cleaned);
        site.monitoredPages = pages;
        site.markModified('monitoredPages');
        await site.save();
        console.log(`[sitemap] ${cleaned}: pages detected via ${source}`);
      } catch (e) {
        console.log(`[sitemap] ${cleaned}: detection failed — ${e.message}`);
      }
    })();
  } catch (e) {
    if (e.code === 11000) {
      return res.status(409).json({ ok: false, error: 'Site already exists at that URL' });
    }
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/sites/:id/detect-pages — re-scan the sitemap for Shop/Contact Us/
// Track Order slugs. Use this any time a site's page URLs change (theme
// change, permalink change, new page builder, etc.) instead of re-adding
// the whole site. Overwrites monitoredPages with the fresh detection.
router.post('/:id/detect-pages', async (req, res) => {
  const site = await Site.findById(req.params.id);
  if (!site) return res.status(404).json({ ok: false, error: 'Not found' });
  try {
    const { pages, source } = await detectMonitoredPages(site.url);
    site.monitoredPages = pages;
    site.markModified('monitoredPages');
    await site.save();
    res.json({ ok: true, monitoredPages: pages, source });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// GET /api/sites/:id — single site
router.get('/:id', async (req, res) => {
  const site = await Site.findById(req.params.id).lean();
  if (!site) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true, site });
});

// DELETE /api/sites/:id
router.delete('/:id', async (req, res) => {
  const site = await Site.findByIdAndDelete(req.params.id);
  if (!site) return res.status(404).json({ ok: false, error: 'Not found' });
  await Snapshot.deleteMany({ site: site._id });
  res.json({ ok: true });
});

// NOTE: the old manual "POST /:id/sync" + "GET /:id/sync/status" endpoints
// (and the syncJobs in-memory tracker) are gone. Security-data syncing is no
// longer a manually-triggered, per-site action — it now runs automatically
// once a day for every site via services/scanAllSites.js, triggered by the
// GitHub Actions workflow .github/workflows/daily-scan.yml hitting the
// protected POST /api/scan/run-all endpoint (see routes/scan.js).

// GET /api/sites/:id/latest — most recent snapshot
router.get('/:id/latest', async (req, res) => {
  const snap = await Snapshot.findOne({ site: req.params.id }).sort({ fetchedAt: -1 }).lean();
  if (!snap) return res.status(404).json({ ok: false, error: 'No snapshots yet' });
  res.json({ ok: true, snapshot: snap });
});

// GET /api/sites/:id/history?days=7 — Site Health point history for chart.
// No numeric score anymore — returns the raw good/recommended/critical
// counts per snapshot so the frontend can chart those directly.
router.get('/:id/history', async (req, res) => {
  const days = Math.min(parseInt(req.query.days || '7', 10), 90);
  const since = new Date(Date.now() - days * 86400000);
  const snaps = await Snapshot.find({ site: req.params.id, fetchedAt: { $gte: since }, ok: true })
    .sort({ fetchedAt: 1 })
    .select('fetchedAt data')
    .lean();
  const points = snaps.map(s => {
    const health = s.data?.health?.summary;
    if (!health) return null;
    return {
      date: s.fetchedAt,
      critical: health.critical || 0,
      recommended: health.recommended || 0,
      good: health.good || 0,
    };
  }).filter(Boolean);
  res.json({ ok: true, points });
});

export default router;
