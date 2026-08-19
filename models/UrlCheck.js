import mongoose from 'mongoose';

// One document per domain-reference-check run (see services/urlReferenceCheck.js).
// Used after a domain migration (e.g. vizkart.com -> vizkart.pk) to find every
// live page that still references the old domain, anywhere in its raw HTML.
const UrlCheckSchema = new mongoose.Schema(
  {
    site:       { type: mongoose.Schema.Types.ObjectId, ref: 'Site', required: true, index: true },
    oldDomain:  { type: String, required: true },
    startedAt:  { type: Date, default: Date.now },
    finishedAt: { type: Date, default: null },

    status: {
      type: String,
      enum: ['running', 'completed', 'failed'],
      default: 'running',
    },
    error: { type: String, default: null },

    // Sub-state only meaningful while status is 'running' — lets the
    // frontend show what's actually happening during the (potentially
    // multi-minute) page-discovery phase instead of a frozen-looking
    // "Scanned 0 of … pages found", which was confirmed live to read as
    // "this is stuck" even though it was working normally.
    phase:      { type: String, enum: ['discovering', 'scanning', null], default: 'discovering' },
    phaseLabel: { type: String, default: null }, // e.g. "checking sitemap…", "crawling site links…"

    // Page-discovery progress — how many pages were found (across
    // monitoredPages/REST-API/sitemap/link-crawl) and how many have been
    // scanned so far. Lets the frontend poll and show live progress instead
    // of a blank screen for what can be a multi-minute run on a large site.
    totalPages:   { type: Number, default: 0 },
    scannedPages: { type: Number, default: 0 },
    // True when page discovery hit one of its own caps (see
    // discoverAllPages's `cap`/`crawlMaxPages`) — i.e. there may be MORE
    // pages on the site than were actually checked. Surfaced in the UI
    // rather than silently under-reporting coverage.
    truncated: { type: Boolean, default: false },
    discoverySources: {
      monitoredPages: { type: Number, default: 0 },
      restApi:        { type: Number, default: 0 },
      sitemap:        { type: Number, default: 0 },
      crawl:          { type: Number, default: 0 },
    },
    unreachablePages: { type: Number, default: 0 }, // pages that errored/timed out during the scan itself

    // Only pages where the old domain was actually found — clean pages
    // aren't listed individually, just counted via scannedPages/matches.length.
    matches: [
      {
        pageUrl:    { type: String, required: true },
        matchCount: { type: Number, required: true },
        snippets:   [{ type: String }],
      },
    ],
  },
  { timestamps: true }
);

UrlCheckSchema.index({ site: 1, createdAt: -1 });

export default mongoose.model('UrlCheck', UrlCheckSchema);
