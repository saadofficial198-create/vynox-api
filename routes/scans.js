import express from 'express';
import Site from '../models/Site.js';
import Snapshot from '../models/Snapshot.js';

const router = express.Router();

function hostFromUrl(url) {
  try { const u = new URL(url); return u.hostname + (u.pathname.length > 1 ? u.pathname.replace(/\/$/, '') : ''); }
  catch { return url; }
}

function startsYes(v) { return typeof v === 'string' && /^yes/i.test(v); }
function computeScore(data) {
  if (!data) return null;
  const sec = data.security || {}, health = data.health?.summary || {}, updates = data.updates || {}, malware = data.malware || {};
  let score = 100;
  score -= (health.critical || 0) * 15;
  score -= (health.recommended || 0) * 5;
  score -= updates.core_update_available === 'yes' ? 10 : 0;
  score -= (updates.plugins_to_update || 0) * 2;
  score -= (updates.themes_to_update || 0) * 2;
  score -= (malware.suspicious_count || 0) * 25;
  score -= /^no/i.test(sec.ssl_enabled || '') ? 20 : 0;
  score -= startsYes(sec.file_editor_enabled) ? 5 : 0;
  score -= startsYes(sec.admin_path_default) ? 3 : 0;
  return Math.max(0, Math.min(100, score));
}
function scoreColor(s) {
  if (s == null) return '#5a6480';
  if (s >= 80) return '#22c55e';
  if (s >= 60) return '#f59e0b';
  return '#ef4444';
}
function scoreDash(s) {
  const circumference = 100;
  const dash = Math.max(0, Math.min(circumference, s ?? 0));
  return `${dash.toFixed(1)} ${(circumference - dash).toFixed(1)}`;
}

router.get('/', async (_req, res) => {
  const sites = await Site.find().lean();
  const siteMap = new Map(sites.map(s => [String(s._id), s]));
  const snaps = await Snapshot.find().sort({ fetchedAt: -1 }).limit(200).lean();

  const scans = snaps.map(snap => {
    const site = siteMap.get(String(snap.site));
    const data = snap.data || {};
    const score = snap.ok ? computeScore(data) : null;
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
      score,
      scoreColor: scoreColor(score),
      scoreDash:  scoreDash(score),
    };
  });

  res.json({ ok: true, scans });
});

export default router;
