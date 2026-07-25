import express from 'express';
import Site from '../models/Site.js';
import Snapshot from '../models/Snapshot.js';
import { deriveHealthStatus } from '../services/healthStatus.js';

const router = express.Router();

function hostFromUrl(url) {
  try { const u = new URL(url); return u.hostname + (u.pathname.length > 1 ? u.pathname.replace(/\/$/, '') : ''); }
  catch { return url; }
}

router.get('/', async (_req, res) => {
  const sites = await Site.find().lean();
  const siteMap = new Map(sites.map(s => [String(s._id), s]));
  const snaps = await Snapshot.find().sort({ fetchedAt: -1 }).limit(200).lean();

  const scans = snaps.map(snap => {
    const site = siteMap.get(String(snap.site));
    const data = snap.data || {};
    const health = snap.ok ? deriveHealthStatus(data) : null;
    const malware = data.malware || {};
    const url = site?.url || '';
    return {
      id: String(snap._id),
      siteId: String(snap.site),
      site: hostFromUrl(url),
      siteLabel: site?.name || 'Unknown site',
      woo: !!data.plugins?.plugins?.find?.(p => /woocommerce/i.test(p.name)),
      type: 'Full Scan',
      trigger: 'Manual',
      triggerSub: 'API',
      status: snap.ok ? 'completed' : 'failed',
      statusLabel: snap.ok ? 'Completed' : 'Failed',
      error: snap.error || null,
      date: snap.fetchedAt,
      filesScanned: malware.files_scanned || 0,
      phpFilesInUploads: malware.php_files_count || 0,
      suspicious: malware.suspicious_count || 0,
      verdict: malware.verdict || null,
      healthStatus: health?.status ?? null,
      healthLabel:  health?.label  ?? null,
      critical:     health?.critical    ?? null,
      recommended:  health?.recommended ?? null,
      good:         health?.good        ?? null,
    };
  });

  res.json({ ok: true, scans });
});

export default router;
