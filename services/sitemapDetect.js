import axios from 'axios';

// Common WordPress/WooCommerce sitemap locations, tried in order.
const SITEMAP_CANDIDATES = [
  '/wp-sitemap.xml',        // WordPress core sitemap (5.5+)
  '/sitemap_index.xml',     // Yoast SEO
  '/sitemap.xml',           // Rank Math / generic / All in One SEO
  '/page-sitemap.xml',      // Yoast per-type sitemap, sometimes present alone
];

// What we're trying to find, and the words we look for in the URL path to
// recognize each one. Order matters: first match wins per page.
const PAGE_MATCHERS = [
  { label: 'Shop',             keywords: ['shop', 'store', 'products'] },
  { label: 'Contact Us',       keywords: ['contact-us', 'contact_us', 'contact'] },
  { label: 'Track Your Order', keywords: ['track-order', 'track-your-order', 'order-tracking', 'track_order', 'trackorder'] },
];

function cleanUrl(url) {
  return String(url || '').trim().replace(/\/$/, '');
}

async function fetchXml(url) {
  const { data, status } = await axios.get(url, {
    timeout: 15000,
    validateStatus: () => true,
    headers: { Accept: 'application/xml,text/xml' },
  });
  if (status !== 200 || typeof data !== 'string') return null;
  return data;
}

/** Pulls every <loc>...</loc> value out of a sitemap XML string (works for both index and urlset sitemaps). */
function extractLocs(xml) {
  const matches = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)];
  return matches.map(m => m[1]);
}

/**
 * Fetches a site's sitemap(s) and returns a flat list of every page URL it
 * could find, following one level of nested sitemap-index if needed.
 */
async function getAllSitemapUrls(baseUrl) {
  const base = cleanUrl(baseUrl);
  for (const candidate of SITEMAP_CANDIDATES) {
    const xml = await fetchXml(base + candidate).catch(() => null);
    if (!xml) continue;

    const locs = extractLocs(xml);
    if (!locs.length) continue;

    // If this is a sitemap *index* (points to other sitemaps), fetch the
    // page-related sub-sitemaps and collect their URLs too.
    const isIndex = /<sitemapindex/i.test(xml);
    if (!isIndex) return locs;

    const pageSitemaps = locs.filter(l => /page|post/i.test(l)).slice(0, 5); // cap to avoid fetching dozens
    const all = [];
    for (const sm of pageSitemaps) {
      const subXml = await fetchXml(sm).catch(() => null);
      if (subXml) all.push(...extractLocs(subXml));
    }
    if (all.length) return all;
    return locs; // fall back to whatever the index itself listed
  }
  return [];
}

/**
 * Given a site's base URL, tries to auto-detect the real slugs for Shop,
 * Contact Us, and Track Your Order by scanning the sitemap. Returns an array
 * in the same shape as Site.monitoredPages: [{ label, path }, ...].
 * Home is always included and always "/" (it isn't sitemap-dependent).
 * Pages that can't be confidently matched fall back to their common default
 * slug — this only IMPROVES accuracy, it never breaks what worked before.
 */
export async function detectMonitoredPages(baseUrl) {
  const base = cleanUrl(baseUrl);
  const defaults = [
    { label: 'Home',            path: '/' },
    { label: 'Shop',             path: '/shop' },
    { label: 'Contact Us',       path: '/contact-us' },
    { label: 'Track Your Order', path: '/track-order' },
  ];

  let urls = [];
  try {
    urls = await getAllSitemapUrls(base);
  } catch {
    return { pages: defaults, source: 'default (sitemap fetch failed)' };
  }

  if (!urls.length) return { pages: defaults, source: 'default (no sitemap found)' };

  const pages = [{ label: 'Home', path: '/' }];
  const matchedLabels = new Set(['Home']);

  for (const matcher of PAGE_MATCHERS) {
    const hit = urls.find(u => {
      try {
        const path = new URL(u).pathname.toLowerCase();
        return matcher.keywords.some(kw => path.includes(kw));
      } catch {
        return false;
      }
    });
    if (hit) {
      const path = new URL(hit).pathname.replace(/\/$/, '') || '/';
      pages.push({ label: matcher.label, path });
      matchedLabels.add(matcher.label);
    }
  }

  // Anything we couldn't confidently match from the sitemap, keep the default
  // guess so the page is still monitored (just possibly at the wrong URL —
  // better than dropping it silently).
  for (const d of defaults) {
    if (!matchedLabels.has(d.label)) pages.push(d);
  }

  return { pages, source: 'sitemap' };
}
