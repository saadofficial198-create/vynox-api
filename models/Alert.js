import mongoose from 'mongoose';

// Persisted alert — one doc per (site, key) issue. Re-detecting the same
// issue on a later sync just bumps lastSeenAt/severity/desc instead of
// creating a duplicate row. When an issue stops being detected we flip it
// to 'resolved' rather than deleting it, so there's a history of what fired.
const AlertSchema = new mongoose.Schema(
  {
    site:        { type: mongoose.Schema.Types.ObjectId, ref: 'Site', required: true, index: true },
    key:         { type: String, required: true }, // stable id, e.g. 'malware', 'core-update', 'site-down'
    name:        { type: String, required: true },
    desc:        { type: String, default: '' },
    type:        { type: String, default: '' },
    severity:    { type: String, enum: ['high', 'medium', 'low'], required: true },
    status:      { type: String, enum: ['active', 'resolved'], default: 'active' },
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt:  { type: Date, default: Date.now },
    resolvedAt:  { type: Date, default: null },
  },
  { timestamps: true }
);

// Same issue on the same site should update in place, not duplicate.
AlertSchema.index({ site: 1, key: 1 }, { unique: true });

export default mongoose.model('Alert', AlertSchema);
