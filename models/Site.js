import mongoose from 'mongoose';

// Pages we monitor for PageSpeed + screenshots.
// `path` is relative to the site's base url (e.g. "/shop", "/contact-us").
//
// These are USER-SELECTED from the live sitemap-detected candidate list at
// registration time (or later in Settings) — see services/sitemapDetect.js
// (detectSitemapCandidates) and routes/sites.js (/detect-pages,
// /:id/monitored-pages). They are NOT a hardcoded default anymore; a site
// can have any number of pages, including duplicates of the same "kind"
// (e.g. two different "Contact" pages), which is why there's no fixed
// label enum — `label` is just whatever the user typed/picked for that row.
//
// `matchStatus` tracks whether this page's slug still exists in the site's
// most recent sitemap scan (see services/sitemapDetect.js's
// refreshPageMatchStatus, called from services/scanAllSites.js on every
// daily scan):
//   - 'ok'       — path was found in the latest sitemap scan
//   - 'mismatch' — path was NOT found (slug likely changed or page removed);
//                  screenshot/PageSpeed capture SKIPS this page (instead of
//                  capturing a misleading 404 page or crashing) and an Alert
//                  is raised asking the user to re-select pages in Settings
//   - 'unknown'  — no scan has run yet to check (brand new page, or scan
//                  hasn't completed once since it was added)
// This lets one broken/renamed page degrade gracefully instead of either
// silently capturing garbage (a 404 screenshot) or taking down the whole
// site's monitoring.
const MonitoredPageSchema = new mongoose.Schema(
  {
    label:   { type: String, required: true }, // user-chosen display name, e.g. "Home", "Shop", "Contact Us"
    path:    { type: String, required: true }, // "/", "/shop", "/contact-us", "/track-order"
    enabled: { type: Boolean, default: true },  // user can temporarily disable a page without deleting it
    matchStatus: { type: String, enum: ['ok', 'mismatch', 'unknown'], default: 'unknown' },
    lastMatchedAt: { type: Date, default: null },   // last time this path was confirmed present in the sitemap
    lastMismatchAt: { type: Date, default: null },  // last time it was checked and NOT found
  },
  { _id: false }
);

const DEFAULT_MONITORED_PAGES = [
  { label: 'Home',            path: '/' },
  { label: 'Shop',             path: '/shop' },
  { label: 'Contact Us',       path: '/contact-us' },
  { label: 'Track Your Order', path: '/track-order' },
];

const SiteSchema = new mongoose.Schema(
  {
    name:           { type: String, required: true },
    url:            { type: String, required: true, unique: true },
    apiKey:         { type: String, required: true },
    status:         { type: String, enum: ['online', 'offline', 'unknown'], default: 'unknown' },
    lastCheckedAt:  { type: Date,   default: null },
    lastSyncedAt:   { type: Date,   default: null },
    connectorVersion: { type: String, default: null },
    wpVersion:        { type: String, default: null },
    tags:           { type: [String], default: [] },
    notes:          { type: String, default: '' },
    latest:         { type: mongoose.Schema.Types.Mixed, default: null },
    monitoredPages: { type: [MonitoredPageSchema], default: () => DEFAULT_MONITORED_PAGES },
    // A new site — whether auto-registered by the plugin (POST /register)
    // or added manually — starts with pagesConfigured: false. Screenshot
    // capture and PageSpeed checks both skip any site where this is false
    // (see services/screenshot.js, services/pagespeed.js), and an Alert is
    // raised ("Monitored pages not configured yet") so it's visible in the
    // dashboard, not just silently absent. This is deliberate: the plugin
    // auto-registering a site should NOT immediately start capturing
    // screenshots/running PageSpeed against whatever the hardcoded default
    // guesses (Home/Shop/Contact Us/Track Order) happen to be — those
    // guesses are frequently wrong (wrong slug, page doesn't exist, wrong
    // page entirely), and running against a wrong/404 page is exactly the
    // silent-garbage-data problem this whole feature exists to avoid.
    // PUT /:id/monitored-pages (the user explicitly saving their page
    // selection in Settings) is the ONLY thing that sets this to true.
    pagesConfigured: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export { DEFAULT_MONITORED_PAGES };
export default mongoose.model('Site', SiteSchema);
