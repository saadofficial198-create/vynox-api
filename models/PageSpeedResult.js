import mongoose from 'mongoose';

// One document per (site, page, strategy) check. History is kept — we don't
// overwrite — so the dashboard can chart score trend over time per page.
const PageSpeedResultSchema = new mongoose.Schema(
  {
    site:       { type: mongoose.Schema.Types.ObjectId, ref: 'Site', required: true, index: true },
    pageLabel:  { type: String, required: true }, // "Home", "Shop", ...
    pagePath:   { type: String, required: true },
    fullUrl:    { type: String, required: true },
    strategy:   { type: String, enum: ['mobile', 'desktop'], default: 'mobile' },
    checkedAt:  { type: Date, default: Date.now, index: true },
    ok:         { type: Boolean, default: true },
    error:      { type: String, default: null },

    // Lighthouse lab scores, 0-100
    scores: {
      performance:    { type: Number, default: null },
      seo:            { type: Number, default: null },
      accessibility:  { type: Number, default: null },
      bestPractices:  { type: Number, default: null },
    },

    // Core Web Vitals — field data (real user data, CrUX) when available,
    // else lab data from Lighthouse as a fallback.
    vitals: {
      lcpMs:  { type: Number, default: null }, // Largest Contentful Paint
      clsScore: { type: Number, default: null }, // Cumulative Layout Shift
      inpMs:  { type: Number, default: null }, // Interaction to Next Paint
      fcpMs:  { type: Number, default: null }, // First Contentful Paint
      ttfbMs: { type: Number, default: null }, // Time to First Byte
    },

    raw: { type: mongoose.Schema.Types.Mixed, default: null }, // trimmed API response, for debugging
  },
  { timestamps: true }
);

PageSpeedResultSchema.index({ site: 1, pageLabel: 1, checkedAt: -1 });

export default mongoose.model('PageSpeedResult', PageSpeedResultSchema);
