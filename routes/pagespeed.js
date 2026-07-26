import express from 'express';
import Site from '../models/Site.js';
import PageSpeedResult from '../models/PageSpeedResult.js';
import { checkSitePageSpeed, checkAllSitesPageSpeed } from '../services/pagespeed.js';

const router = express.Router();

// Both /check and /check-all run in the BACKGROUND (fire-and-forget) rather
// than awaiting the full PageSpeed run before responding. With retries this
// can now take up to ~11 minutes per page (5 attempts x up to 120s + 20s
// delay) — a single site with 4 monitored pages could keep an HTTP request
// open for 45+ minutes. cPanel's LiteSpeed/Apache proxy in front of this app
// times out connections well before that (well under an hour, often under a
// couple of minutes), which drops the response before it's sent — the
// browser then reports this as a CORS error ("no Access-Control-Allow-Origin
// header"), because there's no response at all for it to read the header
// from, not because CORS is actually misconfigured. Responding immediately
// with 202 and letting the check run in the background avoids the proxy
// timeout entirely; the frontend just re-polls GET /latest afterwards, same
// as it already did.
//
// runningSites tracks in-flight per-site checks (by siteId) purely to avoid
// starting a duplicate run if "Check Now" is clicked again before the first
// one finishes — it's in-memory only (resets on server restart), which is
// fine since it's just a safety net, not a source of truth.
const runningSites = new Set();
let checkAllRunning = false;

// POST /api/pagespeed/check-all — manually trigger a PageSpeed run for every site
router.post('/check-all', (_req, res) => {
  if (checkAllRunning) {
    return res.status(409).json({ ok: false, error: 'A check-all run is already in progress' });
  }
  checkAllRunning = true;
  res.status(202).json({ ok: true, message: 'PageSpeed check started for all sites — refresh results shortly.' });
  checkAllSitesPageSpeed()
    .then((summary) => console.log('[pagespeed] check-all complete:', JSON.stringify(summary)))
    .catch((e) => console.error('[pagespeed] check-all failed:', e.message))
    .finally(() => { checkAllRunning = false; });
});

// POST /api/pagespeed/:siteId/check — manually trigger a PageSpeed run for one site
router.post('/:siteId/check', async (req, res) => {
  const site = await Site.findById(req.params.siteId);
  if (!site) return res.status(404).json({ ok: false, error: 'Site not found' });
  if (!site.pagesConfigured) {
    // Same gate as the scheduled job (services/pagespeed.js's
    // checkAllSitesPageSpeed) — running "Check Now" against un-reviewed
    // default page guesses would produce the same misleading wrong-page
    // results this whole feature exists to prevent.
    return res.status(409).json({ ok: false, error: 'Monitored pages have not been configured for this site yet — set them up in Settings first.' });
  }

  const siteId = String(site._id);
  if (runningSites.has(siteId)) {
    return res.status(409).json({ ok: false, error: 'A check is already in progress for this site' });
  }

  runningSites.add(siteId);
  res.status(202).json({ ok: true, message: 'PageSpeed check started — refresh results shortly.' });

  checkSitePageSpeed(site)
    .then((results) => console.log(`[pagespeed] ${site.name || siteId} check complete: ${results.length} page(s)`))
    .catch((e) => console.error(`[pagespeed] ${site.name || siteId} check failed:`, e.message))
    .finally(() => { runningSites.delete(siteId); });
});

// GET /api/pagespeed/:siteId/status — whether a background check is currently
// running for this site, so the frontend can restore "Checking…" UI after a
// page reload (it otherwise has no way to know the in-memory state above).
router.get('/:siteId/status', (req, res) => {
  res.json({ ok: true, checking: runningSites.has(String(req.params.siteId)) });
});

// GET /api/pagespeed/:siteId/latest — latest result per monitored page.
// Includes disabled/mismatched pages too (with their matchStatus/enabled
// flags) rather than hiding them, so the frontend can show *why* a page has
// no fresh score ("skipped — page disabled" / "skipped — slug mismatch")
// instead of it just silently not being there.
router.get('/:siteId/latest', async (req, res) => {
  const site = await Site.findById(req.params.siteId).lean();
  if (!site) return res.status(404).json({ ok: false, error: 'Site not found' });

  const pages = site.monitoredPages?.length ? site.monitoredPages : [{ label: 'Home', path: '/' }];
  const latestByPage = [];
  for (const page of pages) {
    const latest = await PageSpeedResult.findOne({ site: site._id, pageLabel: page.label })
      .sort({ checkedAt: -1 })
      .lean();
    latestByPage.push({
      pageLabel: page.label,
      pagePath: page.path,
      enabled: page.enabled !== false,
      matchStatus: page.matchStatus || 'unknown',
      latest: latest || null,
    });
  }
  res.json({ ok: true, pages: latestByPage, pagesConfigured: !!site.pagesConfigured });
});

// GET /api/pagespeed/:siteId/history?page=Home&days=30 — score history for charting
router.get('/:siteId/history', async (req, res) => {
  const { page } = req.query;
  const days = Math.min(parseInt(req.query.days || '30', 10), 180);
  const since = new Date(Date.now() - days * 86400000);

  const filter = { site: req.params.siteId, checkedAt: { $gte: since }, ok: true };
  if (page) filter.pageLabel = page;

  const results = await PageSpeedResult.find(filter)
    .sort({ checkedAt: 1 })
    .select('pageLabel checkedAt scores vitals')
    .lean();

  res.json({ ok: true, points: results });
});

export default router;
