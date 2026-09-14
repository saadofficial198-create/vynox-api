// Plugins that are a standing security risk just by being installed —
// surfaced as alerts by routes/alerts.js's deriveAlerts().
//
// This is deliberately NOT a general vulnerability scanner. It doesn't try
// to track every CVE in the WordPress ecosystem (that needs a constantly
// updated feed and a version-range matcher, and would go stale the moment
// nobody maintained it). It's a short, hand-picked list of plugins where
// the risk is about the plugin's PURPOSE, not one specific buggy release:
// a file manager grants arbitrary read/write/execute on the whole server
// through the browser, so a single auth bypass in it is a full site
// compromise — which is exactly what happened to wp-file-manager in 2020
// (CVE-2020-25213: unauthenticated arbitrary file upload, mass-exploited
// in the wild, exploit code still public on Exploit-DB).
//
// Matching is on the plugin's FOLDER name (the part of WordPress's plugin
// file path before the slash, e.g. "wp-file-manager/file_folder_manager.php"
// -> "wp-file-manager"). The folder is what actually identifies a plugin —
// a display name can be changed by editing one header line, and several
// unrelated plugins share names like "File Manager".

// Each entry: { slugs, label, severity, why }
//   slugs    — plugin folder names, lowercase
//   label    — shown as the alert title
//   severity — 'high' for remote-code-execution-class risk
//   why      — the alert description; says what to actually do about it
const RISKY_PLUGINS = [
  {
    slugs: ['wp-file-manager', 'file-manager-advanced', 'filester', 'file-manager'],
    label: 'File Manager Plugin Installed',
    severity: 'high',
    why: 'File manager plugins allow browsing, editing, uploading and deleting any file on the server from the browser, so a single flaw in one hands an attacker the whole site. wp-file-manager was mass-exploited in 2020 (CVE-2020-25213, unauthenticated file upload → remote code execution) and its exploit code is still public; further flaws have been found since (CVE-2025-0818). Use cPanel File Manager or SFTP instead, and if this plugin is only needed occasionally, delete it rather than leaving it installed — deactivating alone still leaves the files on disk.',
  },
];

// "wp-file-manager/file_folder_manager.php" -> "wp-file-manager".
// A plugin sitting directly in the plugins root as a single file (rare, no
// folder — "hello.php") yields its filename minus the extension, which is
// still a stable identifier for it.
function pluginSlug(file) {
  if (typeof file !== 'string' || !file) return '';
  const first = file.split('/')[0];
  return first.replace(/\.php$/i, '').toLowerCase();
}

/**
 * Finds installed plugins that match the risky list.
 *
 * Reports INACTIVE plugins too, not just active ones — deactivating a
 * plugin leaves its PHP files on disk and reachable by direct URL, which
 * is precisely how CVE-2020-25213 was exploited (a request straight to
 * connector.minimal.php, no WordPress bootstrap involved). "Deactivated"
 * is not "removed", and treating it as safe would miss the real exposure.
 * The alert text says which state it's in so the fix is unambiguous.
 *
 * @param {object|null|undefined} snapshotData - snap.data from the latest Snapshot
 * @returns {{ slug: string, name: string, version: string|null, status: string, label: string, severity: string, why: string }[]}
 */
export function findRiskyPlugins(snapshotData) {
  const plugins = Array.isArray(snapshotData?.plugins?.plugins) ? snapshotData.plugins.plugins : [];
  const found = [];

  for (const p of plugins) {
    const slug = pluginSlug(p?.file);
    if (!slug) continue;
    const match = RISKY_PLUGINS.find(r => r.slugs.includes(slug));
    if (!match) continue;
    found.push({
      slug,
      name: p.name || slug,
      version: p.version || null,
      status: p.status === 'active' ? 'active' : 'inactive',
      label: match.label,
      severity: match.severity,
      why: match.why,
    });
  }

  return found;
}
