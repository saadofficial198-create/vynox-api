import Screenshot from '../models/Screenshot.js';
import { deleteScreenshots, listAllScreenshotFiles } from './sftpUpload.js';

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

// services/screenshot.js names every capture "<pageSlug>-<Date.now()>.jpg"
// (see captureSitePage) — the millisecond-epoch timestamp is right there in
// the filename. This lets orphan cleanup below determine a file's true age
// directly from its name, with no dependency on MongoDB (which is exactly
// the thing that's missing for an orphan) and no dependency on the FTP
// server's own modification-time reporting (unreliable across different
// FTP servers/configs — see basic-ftp's own FileInfo docs: only servers
// supporting the modern MLSD command return a reliably parseable date at
// all, and cPanel's plain FTP often doesn't).
const FILENAME_TIMESTAMP_RE = /-(\d{10,})\.[a-z0-9]+$/i;

/**
 * Deletes screenshot files sitting on cPanel that are older than
 * SCREENSHOT_RETENTION_DAYS but have NO corresponding MongoDB Screenshot
 * record at all — files cleanupOldScreenshots() above can never see, since
 * it only ever looks at rows that still exist in Mongo. Confirmed live:
 * this codebase's oldest screenshots for at least one site were sitting on
 * cPanel 45+ days later while MongoDB had zero old Screenshot rows for it,
 * meaning those DB rows were gone (whatever the original cause) while the
 * files themselves never got cleaned up — cleanupOldScreenshots() reported
 * "found: 0" for a genuinely full month of leftover images.
 *
 * Run this AFTER cleanupOldScreenshots() in the same pass (see
 * screenshotCleanupJob in server.js and POST /api/screenshots/cleanup-now)
 * — by the time this runs, every file that's old AND still DB-tracked has
 * already been removed by that step, so whatever this finds is guaranteed
 * to be a genuine orphan, not a race with the DB-driven pass.
 *
 * A file whose name doesn't match the expected "-<timestamp>.ext" pattern
 * is left alone and counted separately (`unparseable`) rather than risking
 * deleting something this wasn't meant to touch.
 *
 * @returns {Promise<{
 *   totalFiles: number,
 *   found: number,
 *   deleted: number,
 *   failed: { relativePath: string, error: string }[],
 *   unparseable: number,
 * }>}
 */
export async function cleanupOrphanedScreenshotFiles() {
  const cutoffMs = Date.now() - SCREENSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const allFiles = await listAllScreenshotFiles();

  const oldPaths = [];
  let unparseable = 0;
  for (const f of allFiles) {
    const m = FILENAME_TIMESTAMP_RE.exec(f.name);
    if (!m) { unparseable++; continue; }
    const capturedAtMs = Number(m[1]);
    if (Number.isFinite(capturedAtMs) && capturedAtMs < cutoffMs) oldPaths.push(f.relativePath);
  }

  if (!oldPaths.length) {
    return { totalFiles: allFiles.length, found: 0, deleted: 0, failed: [], unparseable };
  }

  const result = await deleteScreenshots(oldPaths);
  if (result.failed.length) {
    console.error(`[screenshotRetention] ${result.failed.length} orphan FTP delete(s) failed:`, JSON.stringify(result.failed.slice(0, 10)));
  }
  return {
    totalFiles: allFiles.length,
    found: oldPaths.length,
    deleted: result.succeeded,
    failed: result.failed,
    unparseable,
  };
}

/**
 * DIAGNOSTIC: List ALL orphan files (files on cPanel with NO matching
 * MongoDB record) WITHOUT deleting anything. Useful before running a
 * destructive cleanup to confirm exactly what will be removed.
 *
 * Returns: list of files with their sizes and timestamps, grouped by
 * whether they're registered in MongoDB or not.
 *
 * @returns {Promise<{
 *   totalFiles: number,
 *   registeredInDb: number,
 *   orphaned: { relativePath: string, name: string, size: number, timestampMs: number, capturedDate: string }[],
 *   unparseable: number,
 * }>}
 */
export async function detectOrphanScreenshots() {
  const allFiles = await listAllScreenshotFiles();
  const allDbPaths = new Set();

  const dbRecords = await Screenshot.find().select('relativePath').lean();
  for (const rec of dbRecords) {
    if (rec.relativePath) allDbPaths.add(rec.relativePath);
  }

  const orphaned = [];
  let unparseable = 0;

  for (const f of allFiles) {
    const m = FILENAME_TIMESTAMP_RE.exec(f.name);
    if (!m) { unparseable++; continue; }

    const timestampMs = Number(m[1]);
    if (!Number.isFinite(timestampMs)) { unparseable++; continue; }

    const isOrphan = !allDbPaths.has(f.relativePath);
    if (isOrphan) {
      orphaned.push({
        relativePath: f.relativePath,
        name: f.name,
        size: f.size,
        timestampMs,
        capturedDate: new Date(timestampMs).toISOString(),
      });
    }
  }

  return {
    totalFiles: allFiles.length,
    registeredInDb: allDbPaths.size,
    orphaned: orphaned.sort((a, b) => b.timestampMs - a.timestampMs),
    unparseable,
  };
}
