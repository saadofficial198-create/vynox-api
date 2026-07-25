// Shared "health status" derivation — replaces the old made-up point-deduction
// score. No arbitrary weights here: status is derived directly from WP Site
// Health's own good/recommended/critical counts, which WordPress already
// computes for us. We just surface those counts plus a couple of other raw
// numbers (updates available, malware hits) for the frontend to render.

function startsYes(v) { return typeof v === 'string' && /^yes/i.test(v); }

// deriveHealthStatus(data) — data is the raw payload from /wp-json/vynox/v1/data
export function deriveHealthStatus(data) {
  if (!data) return null;

  const health  = data.health?.summary || { good: 0, recommended: 0, critical: 0 };
  const updates = data.updates || {};
  const malware = data.malware || {};

  const good        = health.good        || 0;
  const recommended = health.recommended || 0;
  const critical    = health.critical    || 0;

  let status, label;
  if (critical > 0) {
    status = 'critical';
    label  = 'Critical';
  } else if (recommended > 0) {
    status = 'warning';
    label  = 'Needs Attention';
  } else {
    status = 'good';
    label  = 'Good';
  }

  const updatesAvailable =
    (updates.core_update_available === 'yes' ? 1 : 0) +
    (updates.plugins_to_update || 0) +
    (updates.themes_to_update  || 0);

  return {
    status,
    label,
    good,
    recommended,
    critical,
    updatesAvailable,
    malwareSuspiciousCount: malware.suspicious_count || 0,
    phpVersion: data.site?.php_version || null,
    wpVersion:  data.site?.wp_version  || null,
    dbSize:     data.database?.db_size || null,
    diskUsedPct: data.disk?.disk_used_percent || null,
    lastBackup: data.backups?.last_backup?.modified || null,
    backupCount: data.backups?.backup_count ?? 0,
    pluginsActive: data.plugins?.active ?? 0,
    checkedAt: new Date(),
  };
}

// Kept in case other modules want the raw "yes/no-ish string" helper — not
// exported previously, but harmless to expose since it's a pure function.
export { startsYes };
