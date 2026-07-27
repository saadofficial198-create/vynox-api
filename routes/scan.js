import express from 'express';
import { scanAllSites } from '../services/scanAllSites.js';
import { checkAllSitesPageSpeed } from '../services/pagespeed.js';

const router = express.Router();

// Guards against overlapping runs if GitHub Actions ever double-fires or a
// manual + scheduled run collide.
let running = false;
let runningPageSpeed = false;

// POST /api/scan/run-all — triggers a full sync of every site (pull /data,
// store Snapshot, update Site.latest, sync Alert collection, send emails
// for new high-severity alerts / newly-offline sites). Protected by a
// shared secret header since this replaces the old manual per-site "Sync"
// button — it's now only meant to be called by the daily GitHub Actions
// workflow (.github/workflows/daily-scan.yml), not the frontend.
router.post('/run-all', async (req, res) => {
  const expected = process.env.SCAN_TRIGGER_SECRET;
  const provided = req.get('X-Scan-Secret');

  if (!expected) {
    return res.status(500).json({ ok: false, error: 'Server SCAN_TRIGGER_SECRET not configured' });
  }
  if (!provided || provided !== expected) {
    return res.status(401).json({ ok: false, error: 'Invalid scan secret' });
  }

  if (running) {
    return res.status(409).json({ ok: false, error: 'A scan is already in progress' });
  }

  running = true;
  try {
    const summary = await scanAllSites();
    res.json({ ok: true, summary });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    running = false;
  }
});

// POST /api/scan/run-pagespeed — triggers a Desktop PageSpeed check for
// every site, on demand. This exists so the daily GitHub Actions workflow
// (.github/workflows/daily-scan.yml) can pull fresh Desktop scores every
// day, instead of relying solely on the internal 6-hourly setInterval in
// server.js — that timer only fires while the cPanel Node process happens
// to be alive at that exact moment, and gives no daily-scan-level
// guarantee. Reuses the same X-Scan-Secret protection as /run-all since
// it's meant to be called by the same trusted workflow, not the frontend.
// This does NOT replace the 6-hourly internal job — both can run; the
// internal job's own 6h cooldown (models/JobLock.js) means it simply skips
// its own tick if this endpoint already ran recently.
//
// Runs in the BACKGROUND (fire-and-forget, responds 202 immediately) — same
// reasoning as routes/pagespeed.js's /check and /check-all. With retries, a
// full run across every site/page can take well over an hour; keeping the
// HTTP request open that long would hit cPanel's proxy timeout and drop the
// response before GitHub Actions ever sees it, making a perfectly fine run
// look like a failed workflow. Responding immediately means the workflow
// just confirms the run STARTED; the actual scores land in MongoDB
// whenever each site's check finishes, same as clicking "Check Now" does.
router.post('/run-pagespeed', (req, res) => {
  const expected = process.env.SCAN_TRIGGER_SECRET;
  const provided = req.get('X-Scan-Secret');

  if (!expected) {
    return res.status(500).json({ ok: false, error: 'Server SCAN_TRIGGER_SECRET not configured' });
  }
  if (!provided || provided !== expected) {
    return res.status(401).json({ ok: false, error: 'Invalid scan secret' });
  }

  if (runningPageSpeed) {
    return res.status(409).json({ ok: false, error: 'A PageSpeed run is already in progress' });
  }

  runningPageSpeed = true;
  res.status(202).json({ ok: true, strategy: 'desktop', message: 'Desktop PageSpeed check started for all sites — results will land in MongoDB as each site finishes.' });

  checkAllSitesPageSpeed('desktop')
    .then((summary) => console.log('[scan] run-pagespeed (desktop) complete:', JSON.stringify(summary)))
    .catch((e) => console.error('[scan] run-pagespeed (desktop) failed:', e.message))
    .finally(() => { runningPageSpeed = false; });
});

export default router;
