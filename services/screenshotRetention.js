import Screenshot from '../models/Screenshot.js';
import { deleteScreenshots } from './sftpUpload.js';

// How long a screenshot is kept before it's deleted (both the MongoDB
// record AND the actual image file on cPanel) — requested as "one month"
// (31 days) so the Screenshots tab doesn't grow forever. Every monitored
// page gets captured 2x/day (see .github/workflows/screenshots.yml), so
// without this a site with several monitored pages accumulates 60+ images
// a month, forever.
export const SCREENSHOT_RETENTION_DAYS = 31;

/**
 * Deletes every Screenshot older than SCREENSHOT_RETENTION_DAYS — the
 * actual cPanel file (via one shared FTP connection, see
 * sftpUpload.js's deleteScreenshots) AND its MongoDB record. Called
 * periodically from server.js.
 *
 * DB records are deleted regardless of whether the FTP file delete
 * actually succeeded — same tolerance this codebase already has elsewhere
 * (routes/sites.js's DELETE /:id has the identical caveat: an orphaned
 * file left on cPanel storage is a pre-existing, accepted risk here, not
 * something this cleanup needs to solve perfectly). A failed FTP delete
 * just means that one file sits unused on cPanel; it does NOT block the
 * database from staying clean, which is the part that actually affects
 * what the dashboard shows.
 *
 * @returns {Promise<{ found: number, deleted: number }>}
 */
export async function cleanupOldScreenshots() {
  const cutoff = new Date(Date.now() - SCREENSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const old = await Screenshot.find({ capturedAt: { $lt: cutoff } }).select('_id relativePath').lean();
  if (!old.length) return { found: 0, deleted: 0 };

  const relativePaths = old.filter(s => s.relativePath).map(s => s.relativePath);
  try {
    await deleteScreenshots(relativePaths);
  } catch (e) {
    console.error('[screenshotRetention] FTP batch delete failed (still cleaning up DB records):', e.message);
  }

  const result = await Screenshot.deleteMany({ _id: { $in: old.map(s => s._id) } });
  return { found: old.length, deleted: result.deletedCount };
}
