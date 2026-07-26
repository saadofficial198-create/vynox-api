import axios from 'axios';

// Common WordPress/WooCommerce sitemap locations, tried in order.
const SITEMAP_CANDIDATES = [
  '/wp-sitemap.xml',        // WordPress core sitemap (5.5+)
  '/sitemap_index.xml',     // Yoast SEO
  '/sitemap.xml',           // Rank Math / generic / All in One SEO
  '/page-sitemap.xml',      // Yoast per-type sitemap, sometimes present alone
];

// What we're trying to find, and the words we look for in the URL path to
// recognize each one. Order matters: first match wins per page. Used only
// for the "smart pre-select" convenience in detectMonitoredPages() — the
// full candidate list (detectSitemapCandidates) is unfiltered so the user
// can pick ANY page, not just these three.
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

/** Turns a URL path like "/track-your-order/" into a human-readable guess like "Track Your Order". */
function labelFromPath(path) {
  const clean = String(path || '').replace(/^\/|\/$/g, '');
  if (!clean) return 'Home';
  const last = clean.split('/').pop();
  return last
    .split(/[-_]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
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
 * Returns EVERY page the sitemap lists (deduped, capped at a sane limit),
 * as { label, path } candidates for the user to choose from at registration
 * time or later in site Settings — see routes/sites.js's /detect-pages and
 * the "Monitored Pages" picker in the frontend. Home ("/") is always
 * included first even if the sitemap doesn't explicitly list it (most
 * WordPress sitemaps don't bother with the homepage itself).
 *
 * Unlike detectMonitoredPages() below (which is a narrow, backward-compatible
 * best-guess for Shop/Contact Us/Track Order used to pre-fill defaults),
 * this is deliberately unfiltered — the user might monitor any page(s),
 * including duplicates of a similar "kind" (e.g. two separate contact
 * pages), so we don't try to be clever about picking just one of each type.
 */
export async function detectSitemapCandidates(baseUrl, { limit = 60 } = {}) {
  const base = cleanUrl(baseUrl);
  let urls = [];
  try {
    urls = await getAllSitemapUrls(base);
  } catch {
    return { candidates: [{ label: 'Home', path: '/' }], source: 'default (sitemap fetch failed)' };
  }

  const seen = new Set(['/']);
  const candidates = [{ label: 'Home', path: '/' }];

  for (const u of urls) {
    if (candidates.length >= limit) break;
    let path;
    try {
      path = new URL(u).pathname.replace(/\/$/, '') || '/';
    } catch {
      continue;
    }
    if (seen.has(path)) continue;
    seen.add(path);
    candidates.push({ label: labelFromPath(path), path });
  }

  if (candidates.length <= 1) {
    return { candidates, source: urls.length ? 'sitemap (no additional pages found)' : 'default (no sitemap found)' };
  }
  return { candidates, source: 'sitemap' };
}

/**
 * Given a site's base URL, tries to auto-detect the real slugs for Shop,
 * Contact Us, and Track Your Order by scanning the sitemap. Returns an array
 * in the same shape as Site.monitoredPages: [{ label, path }, ...].
 * Home is always included and always "/" (it isn't sitemap-dependent).
 * Pages that can't be confidently matched fall back to their common default
 * slug — this only IMPROVES accuracy, it never breaks what worked before.
 *
 * This is used ONLY to pre-fill a sensible default selection the first time
 * a site is registered (before the user has had a chance to open the page
 * picker) — see routes/sites.js /register and POST /. The user's actual
 * saved choice (Site.monitoredPages, possibly edited via the page picker)
 * is always what actually gets monitored afterwards.
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

/**
 * Re-checks every one of a site's SAVED monitoredPages against a fresh
 * sitemap scan, and returns an updated copy of that array with matchStatus/
 * lastMatchedAt/lastMismatchAt refreshed accordingly. Does NOT add or remove
 * pages — it only updates the match bookkeeping on the pages the user
 * already selected, so screenshot/PageSpeed capture (services/screenshot.js,
 * services/pagespeed.js) can skip anything currently mismatched instead of
 * capturing a 404 or crashing, and routes/alerts.js can raise a "page slug
 * changed" alert for the user to act on.
 *
 * Home ("/") is always treated as matched — it isn't sitemap-dependent, and
 * failing to match it would just be noise (if the homepage itself is really
 * down, the site-wide uptime ping already reports that separately).
 *
 * If the sitemap scan itself fails entirely (site down, sitemap missing),
 * we deliberately do NOT mark every page as mismatched — that would raise a
 * false "your page slugs changed" alert for what's actually just "the site
 * didn't respond right now" (a different, already-handled failure mode).
 * Existing matchStatus is left untouched in that case.
 */
export async function refreshPageMatchStatus(site) {
  const pages = Array.isArray(site.monitoredPages) ? site.monitoredPages : [];
  if (!pages.length) return { pages, scanOk: true };

  let urls = [];
  try {
    urls = await getAllSitemapUrls(site.url);
  } catch {
    return { pages, scanOk: false }; // leave matchStatus as-is; not the pages' fault
  }
  if (!urls.length) return { pages, scanOk: false };

  const sitemapPaths = new Set(
    urls
      .map(u => { try { return new URL(u).pathname.replace(/\/$/, '') || '/'; } catch { return null; } })
      .filter(Boolean)
  );

  const now = new Date();
  const updated = pages.map(p => {
    const found = p.path === '/' || sitemapPaths.has(p.path);
    return {
      ...(typeof p.toObject === 'function' ? p.toObject() : p),
      matchStatus: found ? 'ok' : 'mismatch',
      lastMatchedAt: found ? now : (p.lastMatchedAt ?? null),
      lastMismatchAt: found ? (p.lastMismatchAt ?? null) : now,
    };
  });

  return { pages: updated, scanOk: true };
}
