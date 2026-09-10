import express from 'express';
import axios from 'axios';
import Site from '../models/Site.js';
import Snapshot from '../models/Snapshot.js';
import { deriveHealthStatus } from '../services/healthStatus.js';

// Split out from routes/sites.js on purpose: this ONE endpoint is called by
// the WordPress plugin itself (vynox-connector.php's activation hook +
// daily retry cron), not a logged-in browser — it authenticates with its
// own shared secret (VYNOX_ENROLL_SECRET), same category as /api/scan's
// X-Scan-Secret. server.js mounts this router UNGUARDED and before the
// requireAuth-gated /api/sites mount — confirmed live that a new site's
// plugin activation stopped auto-registering once ALL of /api/sites got
// wrapped in requireAuth (the dashboard's PIN/password session gate), which
// a WordPress plugin has no way to obtain. Keeping /register in its own
// file makes that split obvious instead of relying on route-order alone in
// server.js.

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

// POST /api/sites/register — plugin sends { url, apiKey, secret, name }. We
// verify the shared enrollment secret, then upsert the site (re-registering
// is safe).
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
        // Only applied on a genuinely NEW site (upsert insert), never on a
        // re-registration of an existing one — so this doesn't clobber a
        // site's real, already-saved monitoredPages/pagesConfigured. Home
        // ('/') is seeded immediately and enabled for capture right away
        // (see POST / in routes/sites.js for why: it's never a guessed slug,
        // so there's no reason to gate it behind manual Settings review like
        // Shop/Contact Us/Track Order are).
        $setOnInsert: {
          name: name || cleaned,
          tags: [],
          notes: '',
          monitoredPages: [{ label: 'Home', path: '/', enabled: true, matchStatus: 'ok' }],
          pagesConfigured: true,
        },
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

      // NOTE: we deliberately do NOT auto-apply detectMonitoredPages() (the
      // Shop/Contact Us/Track Order guesses) here — those guessed slugs are
      // frequently wrong, and running against a wrong/404 page is exactly
      // the silent-garbage-data problem this feature exists to avoid. The
      // user must explicitly open Settings, review the live sitemap-detected
      // page candidates (GET /:id/page-candidates), and save their
      // selection (PUT /:id/monitored-pages) to add anything beyond Home.
      // Home itself, however, IS seeded automatically above ($setOnInsert)
      // and pagesConfigured starts true — Home is never a guess (always
      // "/"), so capture starts on it immediately without waiting on a
      // human to open Settings.
    })();
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

export default router;
