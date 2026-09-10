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
 * periodically from server.js, and on-demand via
 * POST /api/screenshots/cleanup-now (routes/screenshots.js) for diagnosing
 * exactly what a run finds/deletes without having to dig through server
 * logs.
 *
 * DB records are deleted regardless of whether the FTP file delete
 * actually succeeded — an orphaned file left on cPanel storage after a
 * failed FTP delete doesn't block the database from staying clean, which
 * is the part that actually affects what the dashboard shows. FTP
 * failures ARE now surfaced in the return value (see sftpUpload.js's
 * deleteScreenshots) instead of being silently swallowed, so a real
 * problem (wrong stored path, a dead connection partway through a big
 * batch, permissions) is visible instead of just leaving files behind
 * forever with no trace.
 *
 * @returns {Promise<{
 *   found: number,
 *   dbDeleted: number,
 *   ftpDeleted: number,
 *   ftpFailed: { relativePath: string, error: string }[],
 *   noRelativePath: number,
 * }>}
 */
export async function cleanupOldScreenshots() {
  const cutoff = new Date(Date.now() - SCREENSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const old = await Screenshot.find({ capturedAt: { $lt: cutoff } }).select('_id relativePath').lean();
  if (!old.length) return { found: 0, dbDeleted: 0, ftpDeleted: 0, ftpFailed: [], noRelativePath: 0 };

  const withPath = old.filter(s => s.relativePath);
  const noRelativePath = old.length - withPath.length;

  let ftpDeleted = 0;
  let ftpFailed = [];
  try {
    const ftpResult = await deleteScreenshots(withPath.map(s => s.relativePath));
    ftpDeleted = ftpResult.succeeded;
    ftpFailed = ftpResult.failed;
    if (ftpFailed.length) {
      console.error(`[screenshotRetention] ${ftpFailed.length} FTP delete(s) failed:`, JSON.stringify(ftpFailed.slice(0, 10)));
    }
  } catch (e) {
    console.error('[screenshotRetention] FTP batch delete threw entirely (still cleaning up DB records):', e.message);
    ftpFailed = withPath.map(s => ({ relativePath: s.relativePath, error: e.message }));
  }

  const dbResult = await Screenshot.deleteMany({ _id: { $in: old.map(s => s._id) } });
  return {
    found: old.length,
    dbDeleted: dbResult.deletedCount,
    ftpDeleted,
    ftpFailed,
    noRelativePath,
  };
}
