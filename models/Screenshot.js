import mongoose from 'mongoose';

// One document per (site, page) capture. The actual image lives on disk
// (see services/screenshot.js for the storage path convention); this record
// just indexes it and stores the diff score vs. the previous capture.
const ScreenshotSchema = new mongoose.Schema(
  {
    site:       { type: mongoose.Schema.Types.ObjectId, ref: 'Site', required: true, index: true },
    pageLabel:  { type: String, required: true },
    pagePath:   { type: String, required: true },
    fullUrl:    { type: String, required: true },
    capturedAt: { type: Date, default: Date.now, index: true },
    ok:         { type: Boolean, default: true },
    error:      { type: String, default: null },

    // Stored on cPanel via SFTP (not on the backend's local disk — see
    // services/sftpUpload.js). relativePath is what we pass to SFTP upload/
    // delete; publicUrl is the direct HTTP(S) link since the folder lives
    // under public_html (used by the dashboard to render the image).
    relativePath: { type: String, default: null },
    publicUrl:    { type: String, default: null },
    fileSize:     { type: Number, default: null }, // bytes

    // Visual diff vs. the immediately preceding successful screenshot of the
    // same (site, pageLabel). diffPct is % of pixels changed — a cheap
    // "possible UI glitch" signal, not a guarantee.
    diffPct:      { type: Number, default: null },
    diffFlagged:  { type: Boolean, default: false }, // true if diffPct crossed the alert threshold
  },
  { timestamps: true }
);

ScreenshotSchema.index({ site: 1, pageLabel: 1, capturedAt: -1 });

export default mongoose.model('Screenshot', ScreenshotSchema);
