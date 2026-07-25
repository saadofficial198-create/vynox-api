import express from 'express';
import Site from '../models/Site.js';
import OtpCheck from '../models/OtpCheck.js';

const router = express.Router();

// Both endpoints operate on "the BoloCart site" specifically — this monitor
// is single-site by design (see scripts/runOtpCheck.js), so there's no
// :siteId param, matching how the check is actually run.
async function findBoloCartSite() {
  return Site.findOne({ url: { $regex: /bolocart\.com/i } }).lean();
}

// GET /api/otp-check/latest — most recent OtpCheck doc for BoloCart.
router.get('/latest', async (_req, res) => {
  const site = await findBoloCartSite();
  if (!site) return res.json({ ok: true, check: null });

  const check = await OtpCheck.findOne({ site: site._id }).sort({ checkedAt: -1 }).lean();
  res.json({ ok: true, check: check || null });
});

// GET /api/otp-check/history?days=30 — recent OtpCheck docs, capped at 90 days.
router.get('/history', async (req, res) => {
  const days = Math.min(parseInt(req.query.days || '30', 10) || 30, 90);
  const site = await findBoloCartSite();
  if (!site) return res.json({ ok: true, checks: [] });

  const since = new Date(Date.now() - days * 86400000);
  const checks = await OtpCheck.find({ site: site._id, checkedAt: { $gte: since } })
    .sort({ checkedAt: -1 })
    .lean();

  res.json({ ok: true, checks });
});

export default router;
