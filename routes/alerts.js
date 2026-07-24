import express from 'express';
import Site from '../models/Site.js';
import Snapshot from '../models/Snapshot.js';

const router = express.Router();

function startsYes(v) { return typeof v === 'string' && /^yes/i.test(v); }

function hostFromUrl(url) {
  try { const u = new URL(url); return u.hostname + (u.pathname.length > 1 ? u.pathname.replace(/\/$/, '') : ''); }
  catch { return url; }
}

function deriveAlerts(site, snap) {
  if (!snap || !snap.ok || !snap.data) return [];
  const d = snap.data;
  const sec     = d.security || {};
  const malware = d.malware  || {};
  const updates = d.updates  || {};
  const health  = d.health?.tests || {};
  const disk    = d.disk     || {};
  const backups = d.backups  || {};
  const logins  = d.logins   || {};

  const at = snap.fetchedAt || new Date();
  const host = hostFromUrl(site.url);
  const out = [];

  const push = (key, name, desc, type, severity) => {
    out.push({
      id: `${site._id}-${key}`,
      siteId: String(site._id),
      siteUrl: site.url,
      site: host,
      siteLabel: site.name,
      name, desc, type, severity,
      sevLabel:   severity === 'high' ? 'High' : severity === 'medium' ? 'Medium' : 'Low',
      sevCls:     severity === 'high' ? 'sev-high' : severity === 'medium' ? 'sev-med' : 'sev-low',
      first: at, last: at,
      status: 'active',
    });
  };

  if (malware.suspicious_count > 0) {
    push('malware', 'Malware Detected', `${malware.suspicious_count} suspicious file(s) found in uploads`, 'Malware', 'high');
  } else if (malware.php_files_count > 0) {
    push('uploads-php', 'PHP Files in Uploads', `${malware.php_files_count} PHP file(s) in uploads directory — should only contain media`, 'Malware', 'medium');
  }

  if (updates.core_update_available === 'yes') {
    push('core-update', 'WordPress Core Update Available', `New version ${updates.core_new_version || ''} available`, 'Core Update', 'medium');
  }
  (updates.plugin_list || []).forEach((p, i) => {
    push('plugin-' + i, `Plugin Update: ${p.name}`, `${p.current} → ${p.latest}`, 'Plugin', 'medium');
  });
  (updates.theme_list || []).forEach((t, i) => {
    push('theme-' + i, `Theme Update: ${t.name}`, `${t.current} → ${t.latest}`, 'Plugin', 'medium');
  });

  if (startsYes(sec.file_editor_enabled)) {
    push('file-editor', 'File Editor Enabled', 'Anyone with admin access can edit theme/plugin code from WP admin. Set DISALLOW_FILE_EDIT in wp-config.php', 'Server', 'medium');
  }
  if (startsYes(sec.admin_path_default)) {
    push('admin-path', 'Default Login Path', 'wp-login.php is at the default path — easy target for brute-force attacks', 'Login Security', 'low');
  }
  if (/^no/i.test(sec.ssl_enabled || '')) {
    push('ssl', 'SSL Not Enabled', 'Site is not served over HTTPS', 'SSL', 'high');
  }

  Object.entries(health).forEach(([k, t]) => {
    if (!t || !t.status) return;
    const label = t.label || k;
    const badge = t.badge ? `Site Health · ${t.badge}` : 'Site Health';
    if (t.status === 'critical')         push('health-' + k, label, badge, 'Server', 'high');
    else if (t.status === 'recommended') push('health-' + k, label, badge, 'Server', 'low');
  });

  if (typeof disk.disk_used_percent === 'string') {
    const pct = parseFloat(disk.disk_used_percent);
    if (pct > 90)      push('disk', 'Low Disk Space',  `Disk ${disk.disk_used_percent} used`, 'Server', 'high');
    else if (pct > 80) push('disk', 'High Disk Usage', `Disk ${disk.disk_used_percent} used`, 'Server', 'medium');
  }

  if (backups.wpvivid_active === false) {
    push('no-backup', 'No Backup Plugin', 'No WPvivid backup plugin detected on this site', 'Server', 'medium');
  } else if (backups.backup_count === 0) {
    push('no-backups', 'No Backups Found', 'WPvivid is active but no backups exist yet', 'Server', 'medium');
  }

  if (logins.failed_last_24h > 10) {
    push('failed-logins', 'Multiple Failed Logins', `${logins.failed_last_24h} failed login attempts in last 24h`, 'Login Security', 'high');
  }

  return out;
}

// GET /api/alerts — all alerts across all sites
router.get('/', async (_req, res) => {
  const sites = await Site.find().lean();
  const all = [];
  for (const site of sites) {
    if (site.status === 'offline') {
      const host = hostFromUrl(site.url);
      all.push({
        id: `${site._id}-down`,
        siteId: String(site._id),
        siteUrl: site.url,
        site: host,
        siteLabel: site.name,
        name: 'Site is Down',
        desc: `${site.name || host} is not responding — checked at ${site.lastCheckedAt ? new Date(site.lastCheckedAt).toLocaleString() : 'unknown'}`,
        type: 'Uptime',
        severity: 'high',
        sevLabel: 'High',
        sevCls: 'sev-high',
        first: site.lastCheckedAt || new Date(),
        last: site.lastCheckedAt || new Date(),
        status: 'active',
      });
    }
    const snap = await Snapshot.findOne({ site: site._id, ok: true }).sort({ fetchedAt: -1 }).lean();
    all.push(...deriveAlerts(site, snap));
  }
  res.json({ ok: true, alerts: all });
});

export default router;
