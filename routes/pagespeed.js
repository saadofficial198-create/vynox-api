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

// POST /api/pagespeed/:siteId/check?strategy=mobile|desktop — manually
// trigger a PageSpeed run for one site, for whichever strategy the dashboard
// has toggled (default 'mobile'). Both strategies can be manually checked
// from the Performance tab now — the 6-hourly internal scheduler
// (server.js -> checkAllSitesPageSpeed('desktop')) still separately keeps
// desktop scores fresh in the background even if nobody clicks the button.
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

  const strategy = (req.query.strategy === 'desktop' || req.body?.strategy === 'desktop') ? 'desktop' : 'mobile';
  const siteId = String(site._id);
  // Keyed by siteId+strategy (not just siteId) so a Mobile check running for
  // a site doesn't block a Desktop check for the SAME site from starting —
  // they're independent runs against independent PageSpeedResult documents.
  const runKey = `${siteId}:${strategy}`;
  if (runningSites.has(runKey)) {
    return res.status(409).json({ ok: false, error: `A ${strategy} check is already in progress for this site` });
  }

  runningSites.add(runKey);
  res.status(202).json({ ok: true, strategy, message: `PageSpeed check (${strategy}) started — refresh results shortly.` });

  checkSitePageSpeed(site, strategy)
    .then((results) => console.log(`[pagespeed] ${site.name || siteId} (${strategy}) check complete: ${results.length} page(s)`))
    .catch((e) => console.error(`[pagespeed] ${site.name || siteId} (${strategy}) check failed:`, e.message))
    .finally(() => { runningSites.delete(runKey); });
});

// GET /api/pagespeed/:siteId/status?strategy=mobile|desktop — whether a
// background check is currently running for this site+strategy, so the
// frontend can restore "Checking…" UI after a page reload (it otherwise has
// no way to know the in-memory state above).
router.get('/:siteId/status', (req, res) => {
  const strategy = req.query.strategy === 'desktop' ? 'desktop' : 'mobile';
  res.json({ ok: true, checking: runningSites.has(`${req.params.siteId}:${strategy}`) });
});

// GET /api/pagespeed/:siteId/latest?strategy=mobile|desktop — latest result
// per monitored page, for ONE strategy (default 'mobile' for backward
// compatibility with the frontend/older callers). Includes disabled/
// mismatched pages too (with their matchStatus/enabled flags) rather than
// hiding them, so the frontend can show *why* a page has no fresh score
// ("skipped — page disabled" / "skipped — slug mismatch") instead of it
// just silently not being there.
router.get('/:siteId/latest', async (req, res) => {
  const site = await Site.findById(req.params.siteId).lean();
  if (!site) return res.status(404).json({ ok: false, error: 'Site not found' });

  const strategy = req.query.strategy === 'desktop' ? 'desktop' : 'mobile';

  const pages = site.monitoredPages?.length ? site.monitoredPages : [{ label: 'Home', path: '/' }];
  const latestByPage = [];
  for (const page of pages) {
    const latest = await PageSpeedResult.findOne({ site: site._id, pageLabel: page.label, strategy })
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
  res.json({ ok: true, strategy, pages: latestByPage, pagesConfigured: !!site.pagesConfigured });
});

// GET /api/pagespeed/:siteId/history?page=Home&days=30&strategy=mobile|desktop — score history for charting
router.get('/:siteId/history', async (req, res) => {
  const { page } = req.query;
  const days = Math.min(parseInt(req.query.days || '30', 10), 180);
  const since = new Date(Date.now() - days * 86400000);
  const strategy = req.query.strategy === 'desktop' ? 'desktop' : 'mobile';

  const filter = { site: req.params.siteId, checkedAt: { $gte: since }, ok: true, strategy };
  if (page) filter.pageLabel = page;

  const results = await PageSpeedResult.find(filter)
    .sort({ checkedAt: 1 })
    .select('pageLabel checkedAt scores vitals')
    .lean();

  res.json({ ok: true, strategy, points: results });
});

export default router;
