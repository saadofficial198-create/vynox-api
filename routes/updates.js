import express from 'express';
import Site from '../models/Site.js';
import Snapshot from '../models/Snapshot.js';

const router = express.Router();

function hostFromUrl(url) {
  try { const u = new URL(url); return u.hostname + (u.pathname.length > 1 ? u.pathname.replace(/\/$/, '') : ''); }
  catch { return url; }
}

function severityFor(kind, name) {
  if (kind === 'Core') return 'high';
  if (kind === 'Plugin') {
    const n = (name || '').toLowerCase();
    if (n.includes('woocommerce') || n.includes('wordfence') || n.includes('jetpack') || n.includes('elementor')) return 'high';
    return 'medium';
  }
  return 'low';
}

function sevMeta(severity) {
  return {
    sevLabel: severity === 'high' ? 'High' : severity === 'medium' ? 'Medium' : 'Low',
    sevCls:   severity === 'high' ? 'sev-high' : severity === 'medium' ? 'sev-med' : 'sev-low',
  };
}

function kindMeta(kind) {
  if (kind === 'Core')   return { kindCls: 'ut-blue' };
  if (kind === 'Theme')  return { kindCls: 'ut-green' };
  return { kindCls: 'ut-purple' };
}

function deriveUpdates(site, snap) {
  if (!snap || !snap.ok || !snap.data) return [];
  const u = snap.data.updates || {};
  const at = snap.fetchedAt || new Date();
  const host = hostFromUrl(site.url);
  const base = { siteId: String(site._id), site: host, siteLabel: site.name, date: at, status: 'available' };
  const out = [];
  let idx = 0;
  const push = (kind, name, current, latest, woo) => {
    const severity = severityFor(kind, name);
    out.push({
      id: `${site._id}-${kind}-${idx++}`,
      ...base,
      woo: !!woo,
      kind,
      ...kindMeta(kind),
      name,
      current: current || '',
      latest: latest || '',
      severity,
      ...sevMeta(severity),
    });
  };
  if (u.core_update_available === 'yes') {
    push('Core', 'WordPress Core', snap.data.site?.wp_version || '', u.core_new_version, false);
  }
  (u.plugin_list || []).forEach(p => {
    const isWoo = /woocommerce/i.test(p.name);
    push('Plugin', p.name, p.current, p.latest, isWoo);
  });
  (u.theme_list || []).forEach(t => {
    push('Theme', t.name, t.current, t.latest, false);
  });
  return out;
}

router.get('/', async (_req, res) => {
  const sites = await Site.find().lean();
  const all = [];
  for (const site of sites) {
    const snap = await Snapshot.findOne({ site: site._id, ok: true }).sort({ fetchedAt: -1 }).lean();
    all.push(...deriveUpdates(site, snap));
  }
  res.json({ ok: true, updates: all });
});

export default router;
