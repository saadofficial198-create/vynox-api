import express from 'express';
import Site from '../models/Site.js';
import Snapshot from '../models/Snapshot.js';

const router = express.Router();

function hostFromUrl(url) {
  try { const u = new URL(url); return u.hostname + (u.pathname.length > 1 ? u.pathname.replace(/\/$/, '') : ''); }
  catch { return url; }
}

// Parse human-readable size to bytes (e.g. "220 MB" → 230686720)
function sizeToBytes(s) {
  if (!s || typeof s !== 'string') return 0;
  const m = s.match(/^([\d.]+)\s*(B|KB|MB|GB|TB)$/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  const mult = { B: 1, KB: 1024, MB: 1024**2, GB: 1024**3, TB: 1024**4 }[unit] || 1;
  return Math.round(n * mult);
}
function fmtBytes(b) {
  if (!b) return '0 B';
  const k = 1024, units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(b) / Math.log(k)));
  return `${(b / Math.pow(k, i)).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

router.get('/', async (_req, res) => {
  const sites = await Site.find().lean();
  const siteMap = new Map(sites.map(s => [String(s._id), s]));

  // Latest snapshot per site
  const latest = new Map();
  for (const site of sites) {
    const snap = await Snapshot.findOne({ site: site._id, ok: true }).sort({ fetchedAt: -1 }).lean();
    if (snap) latest.set(String(site._id), snap);
  }

  let totalBackupBytes = 0;
  let totalDiskFreeBytes = 0;
  let totalDiskBytes = 0;
  let counts = { success: 0, failed: 0, pending: 0 };

  const items = sites.map(site => {
    const snap = latest.get(String(site._id));
    const data = snap?.data || {};
    const b = data.backups || {};
    const d = data.disk || {};
    const lastBackup = b.last_backup || null;
    const totalSiteBytes = sizeToBytes(b.total_backup_size);
    totalBackupBytes += totalSiteBytes;

    // Disk parsing per site (use as the available headroom for this server)
    const freeBytes = sizeToBytes(d.disk_free);
    const diskBytes = sizeToBytes(d.disk_total);
    if (freeBytes) totalDiskFreeBytes += freeBytes;
    if (diskBytes) totalDiskBytes  += diskBytes;

    let status, statusLabel;
    if (!snap) {
      status = 'pending'; statusLabel = 'Never synced';
    } else if (b.wpvivid_active === false) {
      status = 'failed'; statusLabel = 'No backup plugin';
    } else if ((b.backup_count || 0) === 0) {
      status = 'pending'; statusLabel = 'No backups yet';
    } else {
      status = 'success'; statusLabel = 'Success';
    }
    counts[status]++;

    return {
      id: String(site._id),
      siteId: String(site._id),
      site: hostFromUrl(site.url),
      siteUrl: site.url,
      siteLabel: site.name,
      woo: !!data.plugins?.plugins?.find?.(p => /woocommerce/i.test(p.name)),
      lastBackup: lastBackup ? {
        name: lastBackup.name,
        size: lastBackup.size,
        sizeBytes: sizeToBytes(lastBackup.size),
        modified: lastBackup.modified,
        type: lastBackup.type,
      } : null,
      nextScheduled: null,
      backupCount: b.backup_count || 0,
      totalBackupSize: b.total_backup_size || '0 B',
      totalBackupBytes: totalSiteBytes,
      backupDirectory: b.backup_directory || null,
      backupType: lastBackup ? 'Files & Database' : '—',
      status,
      statusLabel,
      allBackups: b.all_backups || [],
      diskFree: d.disk_free || null,
      diskTotal: d.disk_total || null,
      diskUsedPercent: d.disk_used_percent || null,
    };
  });

  res.json({
    ok: true,
    backups: items,
    summary: {
      totalSites: sites.length,
      ...counts,
      totalBackupBytes,
      totalBackupSize: fmtBytes(totalBackupBytes),
      diskFreeBytes: totalDiskFreeBytes,
      diskFreeFmt: fmtBytes(totalDiskFreeBytes),
      diskTotalBytes: totalDiskBytes,
      diskTotalFmt: fmtBytes(totalDiskBytes),
      diskUsedPct: totalDiskBytes ? Math.round((1 - totalDiskFreeBytes / totalDiskBytes) * 1000) / 10 : null,
    },
  });
});

export default router;
