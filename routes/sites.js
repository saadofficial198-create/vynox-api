import express from 'express';
import axios from 'axios';
import Site from '../models/Site.js';
import Snapshot from '../models/Snapshot.js';
import { detectMonitoredPages } from '../services/sitemapDetect.js';

const router = express.Router();

// In-memory sync job tracker (survives as long as the Node process is alive)
// Map<siteId, { status: 'running'|'done'|'error', startedAt, finishedAt, error }>
const syncJobs = new Map();

function cleanUrl(url) {
  return String(url || '').trim().replace(/\/$/, '');
}

function startsYes(v) { return typeof v === 'string' && /^yes/i.test(v); }

function computeSummary(data) {
  if (!data) return null;
  const sec     = data.security || {};
  const health  = data.health?.summary || { good: 0, recommended: 0, critical: 0 };
  const updates = data.updates  || {};
  const malware = data.malware  || {};

  let score = 100;
  score -= (health.critical    || 0) * 15;
  score -= (health.recommended || 0) * 5;
  score -= updates.core_update_available === 'yes' ? 10 : 0;
  score -= (updates.plugins_to_update || 0) * 2;
  score -= (updates.themes_to_update  || 0) * 2;
  score -= (malware.suspicious_count  || 0) * 25;
  score -= /^no/i.test(sec.ssl_enabled || '') ? 20 : 0;
  score -= startsYes(sec.file_editor_enabled) ? 5 : 0;
  score -= startsYes(sec.admin_path_default)  ? 3 : 0;
  score = Math.max(0, Math.min(100, score));

  const alerts =
    (health.critical    || 0) +
    (health.recommended || 0) +
    (startsYes(sec.file_editor_enabled) ? 1 : 0) +
    (startsYes(sec.admin_path_default)  ? 1 : 0) +
    (malware.suspicious_count || 0);

  const updateCount =
    (updates.core_update_available === 'yes' ? 1 : 0) +
    (updates.plugins_to_update || 0) +
    (updates.themes_to_update  || 0);

  return {
    score,
    alerts,
    updates: updateCount,
    phpVersion: data.site?.php_version || null,
    wpVersion:  data.site?.wp_version  || null,
    dbSize:     data.database?.db_size || null,
    diskUsedPct: data.disk?.disk_used_percent || null,
    lastBackup: data.backups?.last_backup?.modified || null,
    backupCount: data.backups?.backup_count ?? 0,
    pluginsActive: data.plugins?.active ?? 0,
    snapshotAt: new Date(),
  };
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
          site.latest = computeSummary(r.data);
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

// POST /api/sites/:id/sync — fire-and-forget: replies immediately, syncs in background.
// Safe to refresh the frontend — the backend continues running regardless.
// Multiple different sites can sync at the same time.
router.post('/:id/sync', async (req, res) => {
  const site = await Site.findById(req.params.id).lean();
  if (!site) return res.status(404).json({ ok: false, error: 'Not found' });

  const key = String(site._id);
  const existing = syncJobs.get(key);
  if (existing && existing.status === 'running') {
    return res.json({ ok: true, status: 'running', startedAt: existing.startedAt });
  }

  const startedAt = new Date();
  syncJobs.set(key, { status: 'running', startedAt, finishedAt: null, error: null });

  // Reply immediately — frontend is unblocked
  res.json({ ok: true, status: 'started', startedAt });

  // Run the actual sync in the background (survives page refresh)
  ;(async () => {
    try {
      const r = await callConnector(site.url, site.apiKey, '/data', 60000);
      if (r.status !== 200) {
        await Snapshot.create({ site: site._id, ok: false, error: `HTTP ${r.status}`, data: r.data });
        await Site.findByIdAndUpdate(site._id, { status: 'offline', lastCheckedAt: new Date() });
        syncJobs.set(key, { status: 'error', startedAt, finishedAt: new Date(), error: `Site returned ${r.status}` });
        return;
      }
      await Snapshot.create({ site: site._id, ok: true, data: r.data });
      const summary = computeSummary(r.data);
      await Site.findByIdAndUpdate(site._id, {
        $set: {
          status: 'online',
          lastCheckedAt: new Date(),
          lastSyncedAt: new Date(),
          latest: summary,
          ...(r.data?.site?.wp_version ? { wpVersion: r.data.site.wp_version } : {}),
        },
      });
      syncJobs.set(key, { status: 'done', startedAt, finishedAt: new Date(), error: null });
    } catch (e) {
      await Snapshot.create({ site: site._id, ok: false, error: e.message }).catch(() => {});
      await Site.findByIdAndUpdate(site._id, { status: 'offline', lastCheckedAt: new Date() }).catch(() => {});
      syncJobs.set(key, { status: 'error', startedAt, finishedAt: new Date(), error: e.message });
    }
  })();
});

// GET /api/sites/:id/sync/status — poll whether a sync is running/done/error
router.get('/:id/sync/status', (req, res) => {
  const job = syncJobs.get(req.params.id);
  if (!job) return res.json({ ok: true, status: 'idle' });
  res.json({ ok: true, ...job });
});

// GET /api/sites/:id/latest — most recent snapshot
router.get('/:id/latest', async (req, res) => {
  const snap = await Snapshot.findOne({ site: req.params.id }).sort({ fetchedAt: -1 }).lean();
  if (!snap) return res.status(404).json({ ok: false, error: 'No snapshots yet' });
  res.json({ ok: true, snapshot: snap });
});

// GET /api/sites/:id/history?days=7 — score history for chart
router.get('/:id/history', async (req, res) => {
  const days = Math.min(parseInt(req.query.days || '7', 10), 90);
  const since = new Date(Date.now() - days * 86400000);
  const snaps = await Snapshot.find({ site: req.params.id, fetchedAt: { $gte: since }, ok: true })
    .sort({ fetchedAt: 1 })
    .select('fetchedAt data')
    .lean();
  const points = snaps.map(s => ({
    date: s.fetchedAt,
    score: s.data?.summary?.score ?? s.data?.score ?? null,
  })).filter(p => p.score != null);
  res.json({ ok: true, points });
});

export default router;
