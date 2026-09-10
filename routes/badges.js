import express from 'express';
import Badge from '../models/Badge.js';
import Site from '../models/Site.js';

const router = express.Router();

// Fixed palette, cycled by creation order — consistent with how the rest
// of this app assigns category colors (e.g. alert severities) rather than
// asking the user to pick one for every badge they create.
const PALETTE = ['#5b46f5', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#8b5cf6', '#ec4899', '#10b981', '#f97316', '#3b82f6'];

router.get('/', async (_req, res) => {
  const badges = await Badge.find().sort({ name: 1 }).lean();
  res.json({ ok: true, badges });
});

router.post('/', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: 'name is required' });

  const existing = await Badge.findOne({ name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).lean();
  if (existing) return res.status(409).json({ ok: false, error: `Badge "${existing.name}" already exists` });

  const count = await Badge.countDocuments();
  const badge = await Badge.create({ name, color: PALETTE[count % PALETTE.length] });
  res.json({ ok: true, badge });
});

// DELETE /api/badges/:id — also strips this badge from every site currently
// using it, so a deleted badge never lingers as an orphaned tag a site
// still "has" but that no longer appears anywhere as selectable.
router.delete('/:id', async (req, res) => {
  const badge = await Badge.findById(req.params.id);
  if (!badge) return res.status(404).json({ ok: false, error: 'Badge not found' });

  await Site.updateMany({ tags: badge.name }, { $pull: { tags: badge.name } });
  await badge.deleteOne();
  res.json({ ok: true });
});

export default router;
