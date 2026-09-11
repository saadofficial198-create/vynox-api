import path from 'path';
import Site from '../models/Site.js';
import Screenshot from '../models/Screenshot.js';
import { moveScreenshots } from './sftpUpload.js';

// Mirrors services/screenshot.js's own safeSlug() exactly — this has to
// compute the SAME folder name captureSitePage() now uses (site._id-based,
// permanently stable), or files would get "migrated" to a folder new
// captures never actually write to.
function safeSlug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

/**
 * One-time merge for the folder-fragmentation bug fixed in
 * services/screenshot.js (captureSitePage used to derive the screenshot
 * folder from site.name, which changes every time a site is renamed via
 * the Sites list's Edit modal — confirmed live: the same site ended up
 * with 3 separate cPanel folders, "vizkart"/"viz-kart"/"velet-mart", one
 * per past name).
 *
 * For every site, finds every Screenshot record whose relativePath points
 * at a folder OTHER than that site's current, permanent site._id-based
 * folder, moves the actual file there (server-side FTP rename — cheap,
 * no download/re-upload), and updates that record's relativePath/publicUrl
 * to match. This is driven entirely by each site's OWN Screenshot
 * documents (not by guessing past names), so it correctly finds files
 * regardless of how many times a site was renamed or what its old names
 * were.
 *
 * Old folders are deliberately left in place even once empty — removing a
 * directory that might still hold an unrelated/unexpected file is a risk
 * this doesn't need to take; an empty folder is harmless clutter, and
 * anything genuinely orphaned left inside will still be caught by
 * services/screenshotRetention.js's orphan-file pass once past the
 * retention window.
 *
 * @returns {Promise<{
 *   sitesChecked: number,
 *   sitesWithMoves: number,
 *   filesMoved: number,
 *   failed: { site: string, from: string, to: string, error: string }[],
 * }>}
 */
export async function mergeScreenshotFolders() {
  const sites = await Site.find().select('_id').lean();
  const publicBase = (process.env.SCREENSHOT_PUBLIC_BASE_URL || '').replace(/\/$/, '');

  let sitesWithMoves = 0;
  let filesMoved = 0;
  const failed = [];

  for (const site of sites) {
    const targetSlug = safeSlug(site._id);
    const shots = await Screenshot.find({ site: site._id, relativePath: { $exists: true, $ne: null } })
      .select('_id relativePath')
      .lean();

    const moves = [];
    const byFrom = new Map(); // relativePath -> { id, to }
    for (const shot of shots) {
      const currentFolder = shot.relativePath.split('/')[0];
      if (currentFolder === targetSlug) continue; // already in the right place
      const fileName = path.posix.basename(shot.relativePath);
      const to = `${targetSlug}/${fileName}`;
      moves.push({ from: shot.relativePath, to });
      byFrom.set(shot.relativePath, { id: shot._id, to });
    }
    if (!moves.length) continue;
    sitesWithMoves++;

    const result = await moveScreenshots(moves);

    for (const { from, to } of result.succeeded) {
      const entry = byFrom.get(from);
      if (!entry) continue;
      await Screenshot.updateOne(
        { _id: entry.id },
        { $set: { relativePath: to, publicUrl: publicBase ? `${publicBase}/${to}` : null } }
      );
      filesMoved++;
    }
    for (const f of result.failed) failed.push({ site: String(site._id), ...f });
  }

  if (failed.length) {
    console.error(`[screenshotMigration] ${failed.length} file move(s) failed:`, JSON.stringify(failed.slice(0, 10)));
  }

  return { sitesChecked: sites.length, sitesWithMoves, filesMoved, failed };
}
