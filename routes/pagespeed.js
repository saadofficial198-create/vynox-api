import express from 'express';
import Site from '../models/Site.js';
import PageSpeedResult from '../models/PageSpeedResult.js';
import { checkSitePageSpeed, checkAllSitesPageSpeed } from '../services/pagespeed.js';

const router = express.Router();

// POST /api/pagespeed/check-all — manually trigger a PageSpeed run for every site
router.post('/check-all', async (_req, res) => {
  try {
    const summary = await checkAllSitesPageSpeed();
    res.json({ ok: true, summary });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/pagespeed/:siteId/check — manually trigger a PageSpeed run for one site
router.post('/:siteId/check', async (req, res) => {
  const site = await Site.findById(req.params.siteId);
  if (!site) return res.status(404).json({ ok: false, error: 'Site not found' });
  try {
    const results = await checkSitePageSpeed(site);
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/pagespeed/:siteId/latest — latest result per monitored page
router.get('/:siteId/latest', async (req, res) => {
  const site = await Site.findById(req.params.siteId).lean();
  if (!site) return res.status(404).json({ ok: false, error: 'Site not found' });

  const pages = site.monitoredPages?.length ? site.monitoredPages : [{ label: 'Home', path: '/' }];
  const latestByPage = [];
  for (const page of pages) {
    const latest = await PageSpeedResult.findOne({ site: site._id, pageLabel: page.label })
      .sort({ checkedAt: -1 })
      .lean();
    latestByPage.push({ pageLabel: page.label, pagePath: page.path, latest: latest || null });
  }
  res.json({ ok: true, pages: latestByPage });
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
