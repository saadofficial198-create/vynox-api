import mongoose from 'mongoose';

const SnapshotSchema = new mongoose.Schema(
  {
    site:       { type: mongoose.Schema.Types.ObjectId, ref: 'Site', required: true, index: true },
    fetchedAt:  { type: Date, default: Date.now, index: true },
    ok:         { type: Boolean, default: true },
    error:      { type: String, default: null },
    data:       { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

export default mongoose.model('Snapshot', SnapshotSchema);
