import express from 'express';
import Site from '../models/Site.js';
import UrlCheck from '../models/UrlCheck.js';
import { runUrlCheck } from '../services/urlReferenceCheck.js';

const router = express.Router();

// Guards against starting a second scan for the same site while one is
// already running — keyed by siteId, same pattern as routes/scan.js's
// `running` flag.
const runningSites = new Set();

// POST /api/url-check/:siteId/run — starts a domain-reference check for one
// site. Runs in the BACKGROUND (responds 202 immediately) — a full scan
// across a large catalog's worth of pages can take several minutes, and
// keeping the HTTP request open that long would hit cPanel's proxy timeout
// the same way routes/scan.js's /run-all used to (see that file's comment
// for the full story). Poll GET /:siteId/latest for progress.
router.post('/:siteId/run', async (req, res) => {
  const { siteId } = req.params;
  const oldDomain = String(req.body?.oldDomain || '').trim();

  if (!oldDomain) {
    return res.status(400).json({ ok: false, error: 'oldDomain is required (e.g. "vizkart.com")' });
  }
  if (runningSites.has(siteId)) {
    return res.status(409).json({ ok: false, error: 'A URL check is already running for this site' });
  }

  const site = await Site.findById(siteId).lean().catch(() => null);
  if (!site) {
    return res.status(404).json({ ok: false, error: 'Site not found' });
  }

  const doc = await UrlCheck.create({ site: site._id, oldDomain, status: 'running' });
  runningSites.add(siteId);
  res.status(202).json({ ok: true, id: doc._id, message: 'URL check started — poll /latest for progress.' });

  runUrlCheck(doc, site, oldDomain)
    .catch(async (e) => {
      console.error(`[urlCheck] site ${siteId} failed:`, e.message);
      await UrlCheck.findByIdAndUpdate(doc._id, { $set: { status: 'failed', error: e.message, finishedAt: new Date() } }).catch(() => {});
    })
    .finally(() => runningSites.delete(siteId));
});

// Shared cPanel Node hosting restarts this process fairly often (every code/
// env deploy — see server.js's comments on the same theme elsewhere in this
// app). If that happens mid-run, the in-memory `runningSites` guard resets,
// but the UrlCheck doc is left stuck at status:'running' forever with no
// process left to finish it — and the frontend disables "Scan Now" while
// status is 'running', so the user would have no way to retry. `doc.save()`
// during a real run touches `updatedAt` every few pages (via mongoose's
// timestamps), so "no update in a long while" reliably means "the run died",
// not "it's just slow".
const STALE_RUNNING_MS = 20 * 60 * 1000;

// GET /api/url-check/:siteId/latest — most recent run for this site (any
// status — 'running' so the frontend can poll progress, 'completed'/
// 'failed' for the final result).
router.get('/:siteId/latest', async (req, res) => {
  const doc = await UrlCheck.findOne({ site: req.params.siteId }).sort({ createdAt: -1 });
  if (doc && doc.status === 'running' && Date.now() - doc.updatedAt.getTime() > STALE_RUNNING_MS) {
    doc.status = 'failed';
    doc.error = 'This check did not finish in a reasonable time (the backend process likely restarted mid-run) — click Scan Now to retry.';
    doc.finishedAt = new Date();
    await doc.save();
    runningSites.delete(String(req.params.siteId));
  }
  res.json({ ok: true, check: doc ? doc.toObject() : null });
});

// GET /api/url-check/:siteId/history — recent runs (e.g. to compare before/
// after fixing flagged links), most recent first.
router.get('/:siteId/history', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '10', 10) || 10, 50);
  const checks = await UrlCheck.find({ site: req.params.siteId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .select('-matches') // history list doesn't need every match's snippets — /latest has those
    .lean();
  res.json({ ok: true, checks });
});

export default router;
