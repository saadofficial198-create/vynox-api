import mongoose from 'mongoose';

// Pages we monitor for PageSpeed + hourly screenshots.
// `path` is relative to the site's base url (e.g. "/shop", "/contact-us").
// Defaults cover the common WooCommerce set; editable per-site since slugs vary.
const MonitoredPageSchema = new mongoose.Schema(
  {
    label: { type: String, required: true }, // "Home", "Shop", "Contact Us", "Track Your Order"
    path:  { type: String, required: true }, // "/", "/shop", "/contact-us", "/track-order"
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
  },
  { timestamps: true }
);

export { DEFAULT_MONITORED_PAGES };
export default mongoose.model('Site', SiteSchema);
