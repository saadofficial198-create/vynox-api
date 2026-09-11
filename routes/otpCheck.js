import express from 'express';
import Site from '../models/Site.js';
import OtpCheck from '../models/OtpCheck.js';

const router = express.Router();

// Multi-site by design (see scripts/runOtpCheck.js, which runs this check
// across EVERY registered site) — no site is hardcoded here. Each endpoint
// either returns one row per site (latest) or accepts an optional ?siteId=
// to scope to a single site's history.

// GET /api/otp-check/latest — most recent OtpCheck doc for EVERY site that
// has at least one check recorded (sites never checked yet are omitted).
//
// Sites with the OTP monitor switched off are excluded too: they're the
// ones that aren't shops at all, so listing their last-ever result in the
// dashboard's OTP panel would be stale noise about a check that is no
// longer running. Their historical OtpCheck rows are left in the database
// untouched — turning the monitor back on restores the full history rather
// than starting from nothing.
router.get('/latest', async (_req, res) => {
  const sites = await Site.find({ otpCheckEnabled: { $ne: false } }).lean();
  if (!sites.length) return res.json({ ok: true, checks: [] });

  const checks = await Promise.all(
    sites.map(async (site) => {
      const check = await OtpCheck.findOne({ site: site._id }).sort({ checkedAt: -1 }).lean();
      if (!check) return null;
      return { ...check, siteName: site.name, siteUrl: site.url };
    })
  );

  res.json({ ok: true, checks: checks.filter(Boolean) });
});

// GET /api/otp-check/history?days=30&siteId=... — recent OtpCheck docs,
// capped at 90 days. Without siteId, returns recent checks across ALL sites
// (most recent first); with siteId, scoped to that one site.
router.get('/history', async (req, res) => {
  const days = Math.min(parseInt(req.query.days || '30', 10) || 30, 90);
  const since = new Date(Date.now() - days * 86400000);
  const filter = { checkedAt: { $gte: since } };
  if (req.query.siteId) filter.site = req.query.siteId;

  const checks = await OtpCheck.find(filter)
    .sort({ checkedAt: -1 })
    .limit(500)
    .populate('site', 'name url')
    .lean();

  res.json({ ok: true, checks });
});

export default router;
