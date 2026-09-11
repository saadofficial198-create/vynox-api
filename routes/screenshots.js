import express from 'express';
import Site from '../models/Site.js';
import Screenshot from '../models/Screenshot.js';
import { triggerGithubWorkflow } from '../services/githubTrigger.js';
import { cleanupOldScreenshots, cleanupOrphanedScreenshotFiles, SCREENSHOT_RETENTION_DAYS } from '../services/screenshotRetention.js';
import { mergeScreenshotFolders } from '../services/screenshotMigration.js';

const router = express.Router();

// POST /api/screenshots/merge-folders-now — one-time migration for the
// folder-fragmentation bug fixed in services/screenshot.js (a site rename
// used to create a brand new cPanel screenshot folder instead of reusing
// the same one). Moves every site's existing screenshots into its current,
// permanent site._id-based folder — see services/screenshotMigration.js.
// Safe to run more than once: a site with nothing left in the wrong place
// is simply skipped.
router.post('/merge-folders-now', async (_req, res) => {
  try {
    const result = await mergeScreenshotFolders();
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/screenshots/cleanup-now — runs BOTH retention-cleanup passes
// (see services/screenshotRetention.js) immediately and returns the full
// result, instead of waiting for server.js's own daily job and having to
// dig through cPanel's Node app logs to see what happened:
//   1. DB-tracked pass — deletes Screenshots (+ their cPanel file) whose
//      MongoDB record says they're older than the retention window.
//   2. Orphan-file pass — separately scans cPanel directly by filename
//      timestamp, for files older than the window that have NO matching
//      MongoDB record at all (confirmed to actually happen live — pass 1
//      alone reported "found: 0" while 45+ day old files still sat on
//      cPanel, because their DB rows were already gone).
// Meant as a diagnostic/manual-trigger tool — the daily background job
// still runs both passes on its own regardless of whether this is called.
router.post('/cleanup-now', async (_req, res) => {
  try {
    const dbPass = await cleanupOldScreenshots();
    const orphanPass = await cleanupOrphanedScreenshotFiles();
    res.json({ ok: true, retentionDays: SCREENSHOT_RETENTION_DAYS, dbPass, orphanPass });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/screenshots/capture-all — asks GitHub Actions to run the
// screenshot workflow right now (in addition to its 2x/day schedule).
// Actual capturing (Playwright/Chromium) never happens on this cPanel
// server — it can't run a headless browser. See services/screenshot.js
// and .github/workflows/screenshots.yml for the full explanation.
router.post('/capture-all', async (_req, res) => {
  try {
    await triggerGithubWorkflow();
    res.json({ ok: true, message: 'Triggered GitHub Actions — captures for all sites will run in the next 1-2 minutes. Refresh this page shortly to see results.' });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// POST /api/screenshots/:siteId/capture — same as above; GitHub Actions
// currently captures every site in one run (per-site triggering isn't
// wired up), so this also re-runs the full workflow.
router.post('/:siteId/capture', async (req, res) => {
  const site = await Site.findById(req.params.siteId).lean();
  if (!site) return res.status(404).json({ ok: false, error: 'Site not found' });
  try {
    await triggerGithubWorkflow();
    res.json({ ok: true, message: 'Triggered GitHub Actions — this runs for ALL sites (not just this one), takes a few minutes. Refresh shortly.' });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// GET /api/screenshots/:siteId/latest — latest screenshot per monitored page
router.get('/:siteId/latest', async (req, res) => {
  const site = await Site.findById(req.params.siteId).lean();
  if (!site) return res.status(404).json({ ok: false, error: 'Site not found' });

  const pages = site.monitoredPages?.length ? site.monitoredPages : [{ label: 'Home', path: '/' }];
  const latestByPage = [];
  for (const page of pages) {
    const latest = await Screenshot.findOne({ site: site._id, pageLabel: page.label })
      .sort({ capturedAt: -1 })
      .lean();
    latestByPage.push({ pageLabel: page.label, pagePath: page.path, latest: latest || null });
  }
  res.json({ ok: true, pages: latestByPage });
});

// GET /api/screenshots/:siteId/history?page=Home&limit=24
router.get('/:siteId/history', async (req, res) => {
  const { page } = req.query;
  const limit = Math.min(parseInt(req.query.limit || '24', 10), 200);

  const filter = { site: req.params.siteId };
  if (page) filter.pageLabel = page;

  const results = await Screenshot.find(filter)
    .sort({ capturedAt: -1 })
    .limit(limit)
    .lean();

  res.json({ ok: true, results });
});

// GET /api/screenshots/file/:screenshotId — redirect to the image's direct
// cPanel URL (the file lives under public_html now, uploaded via SFTP —
// see services/sftpUpload.js — so we don't proxy the bytes ourselves).
router.get('/file/:screenshotId', async (req, res) => {
  const shot = await Screenshot.findById(req.params.screenshotId).lean();
  if (!shot || !shot.publicUrl) {
    return res.status(404).json({ ok: false, error: 'Screenshot not found or has no public URL configured' });
  }
  res.redirect(shot.publicUrl);
});

export default router;
