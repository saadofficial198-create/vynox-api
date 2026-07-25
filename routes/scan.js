import express from 'express';
import { scanAllSites } from '../services/scanAllSites.js';

const router = express.Router();

// Guards against overlapping runs if GitHub Actions ever double-fires or a
// manual + scheduled run collide.
let running = false;

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

export default router;
