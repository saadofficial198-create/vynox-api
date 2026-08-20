import axios from 'axios';

// Finds every leftover reference to an old domain (e.g. "vizkart.com" after
// migrating to "vizkart.pk") across every live page of a site — home,
// contact, about, categories, single product pages, everywhere. Two parts:
//   1. discoverAllPages() — find every page URL that exists on the site.
//   2. scanUrlForDomain() — fetch one page's raw HTML and search it.
// runUrlCheck() ties both together and persists progress into a UrlCheck
// document (see models/UrlCheck.js) so the frontend can poll it.

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const SITEMAP_CANDIDATES = [
  '/wp-sitemap.xml',
  '/sitemap_index.xml',
  '/sitemap.xml',
  '/page-sitemap.xml',
];

function cleanUrl(url) {
  return String(url || '').trim().replace(/\/$/, '');
}

function normalizePageUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    u.search = ''; // query strings (e.g. ?add-to-cart=) aren't distinct pages for this purpose
    return u.origin + (u.pathname.replace(/\/$/, '') || '/');
  } catch {
    return null;
  }
}

async function fetchText(url, timeoutMs) {
  try {
    const res = await axios.get(url, {
      timeout: timeoutMs,
      validateStatus: () => true,
      headers: { 'User-Agent': BROWSER_USER_AGENT, Accept: '*/*' },
      maxContentLength: 20 * 1024 * 1024, // 20MB safety ceiling per page
    });
    if (res.status !== 200 || typeof res.data !== 'string') return null;
    return res.data;
  } catch {
    return null;
  }
}

function extractLocs(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1]);
}

// Unlike services/sitemapDetect.js's getAllSitemapUrls() (used for the page
// picker), this does NOT cap sub-sitemaps at 5 or filter them to
// page|post-named ones — a WooCommerce store's product/category sitemaps
// (e.g. "product-sitemap1.xml") would be silently skipped by that filter,
// and product pages are exactly what a domain-migration check needs to
// cover. maxSitemaps is just a sane ceiling against a pathological site
// with hundreds of sub-sitemaps, not a deliberate narrowing.
async function getAllSitemapUrlsThorough(baseUrl, { maxSitemaps = 60 } = {}) {
  const base = cleanUrl(baseUrl);
  for (const candidate of SITEMAP_CANDIDATES) {
    const xml = await fetchText(base + candidate, 15000);
    if (!xml) continue;
    const locs = extractLocs(xml);
    if (!locs.length) continue;

    if (!/<sitemapindex/i.test(xml)) return locs;

    // Fetched concurrently, not one-at-a-time — a WooCommerce store's
    // sitemap index commonly lists dozens of product/category sub-sitemaps,
    // and fetching them sequentially (up to maxSitemaps * 15s) was the
    // single biggest contributor to this whole check looking "stuck" for
    // several minutes before scanning even started.
    const subSitemaps = locs.slice(0, maxSitemaps);
    const subResults = await mapWithConcurrency(subSitemaps, 8, (sm) => fetchText(sm, 15000));
    const all = subResults.filter(Boolean).flatMap(extractLocs);
    return all.length ? all : locs;
  }
  return [];
}

// Reads every published "page" (post type "page" only) via WordPress's own
// core REST API — doesn't depend on a sitemap existing at all.
async function fetchPagesFromRestApi(baseUrl) {
  const base = cleanUrl(baseUrl);
  try {
    const res = await axios.get(`${base}/wp-json/wp/v2/pages`, {
      timeout: 60000,
      validateStatus: () => true,
      params: { per_page: 100, _fields: 'link' },
      headers: { Accept: 'application/json' },
    });
    if (res.status !== 200 || !Array.isArray(res.data)) return [];
    return res.data.map(p => p.link).filter(Boolean);
  } catch {
    return [];
  }
}

function extractSameHostLinks(html, pageUrl, host) {
  const hrefs = [...html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["']/gi)].map(m => m[1]);
  const out = [];
  for (const href of hrefs) {
    try {
      const u = new URL(href, pageUrl);
      if (u.hostname !== host) continue;
      if (!/^https?:$/.test(u.protocol)) continue;
      out.push(u.href);
    } catch { /* relative/invalid href, skip */ }
  }
  return out;
}

// Runs `limit` calls to `fn` concurrently over `items`, in order, without
// spawning items.length promises at once (important here — sites can have
// thousands of pages, and hammering them all in parallel would either get
// the monitor rate-limited/blocked or overload the target server).
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Discovers every page URL on a site, combining four sources so a broken or
 * missing sitemap (confirmed to happen on some real sites) never leaves this
 * with nothing to scan:
 *   1. The site's own saved monitoredPages (always available, guaranteed floor)
 *   2. WordPress's core REST API (/wp/v2/pages) — static pages, no sitemap needed
 *   3. The site's sitemap(s), unfiltered/uncapped-sub-sitemap (catches
 *      single product/category pages a "pages"-only source would miss)
 *   4. A same-host link crawl starting from the homepage (BFS, capped) —
 *      catches everything neither of the above listed, and is the only
 *      source that still works when a site has no sitemap AND blocks the
 *      REST API.
 * `onProgress(urls.length, phaseLabel)` is called after each source finishes
 * (and periodically during the crawl) purely so a caller can persist "here's
 * what we've found so far, still looking" — discovery alone can take a
 * couple of minutes on a big store, and with no feedback during that window
 * it reads as "stuck" even though it's working (confirmed live: a user
 * watched "Scanned 0 of … pages found" for several minutes and assumed the
 * check had broken).
 * @returns {Promise<{ urls: string[], truncated: boolean, sources: object }>}
 */
export async function discoverAllPages(site, opts = {}) {
  const { cap = 3000, crawlMaxPages = 1200, crawlMaxDepth = 3, crawlConcurrency = 6, onProgress, deadlineTs = Infinity } = opts;
  const base = cleanUrl(site.url);
  const host = new URL(base).hostname;
  const seen = new Set();
  const urls = [];
  const sources = { monitoredPages: 0, restApi: 0, sitemap: 0, crawl: 0 };
  let truncated = false;

  const add = (raw, sourceKey) => {
    if (urls.length >= cap) { truncated = true; return; }
    const norm = normalizePageUrl(raw);
    if (!norm || seen.has(norm)) return;
    seen.add(norm);
    urls.push(norm);
    sources[sourceKey]++;
  };

  add(base, 'monitoredPages');
  for (const p of site.monitoredPages || []) {
    if (p?.path) add(base + p.path, 'monitoredPages');
  }
  onProgress?.(urls.length, 'checking WordPress REST API…');

  const restPages = await fetchPagesFromRestApi(base).catch(() => []);
  for (const link of restPages) add(link, 'restApi');
  onProgress?.(urls.length, 'checking sitemap…');

  let sitemapUrls = [];
  try {
    sitemapUrls = await getAllSitemapUrlsThorough(base);
  } catch { sitemapUrls = []; }
  if (sitemapUrls.length > cap - urls.length) truncated = true;
  for (const u of sitemapUrls) add(u, 'sitemap');
  onProgress?.(urls.length, 'crawling site links…');

  // Same-host link crawl — always run as a supplement (not just when the
  // above found nothing), since it catches pages neither the sitemap nor
  // the REST API listed. Capped separately (crawlMaxPages) from the overall
  // `cap` so a slow/huge site doesn't spend its entire budget crawling
  // before ever getting to scan anything. Also bails once `deadlineTs`
  // passes, same reasoning as the equivalent check in runUrlCheck's scan
  // loop — discovery alone shouldn't be able to run forever on a site with
  // an enormous or cyclical link graph.
  const queue = [{ url: base, depth: 0 }];
  const queued = new Set([normalizePageUrl(base)]);
  let crawled = 0;
  while (queue.length && crawled < crawlMaxPages && urls.length < cap && Date.now() < deadlineTs) {
    const batch = queue.splice(0, crawlConcurrency);
    const htmls = await mapWithConcurrency(batch, crawlConcurrency, (item) => fetchText(item.url, 12000));
    for (let i = 0; i < batch.length; i++) {
      crawled++;
      const html = htmls[i];
      const { url: pageUrl, depth } = batch[i];
      add(pageUrl, 'crawl');
      if (!html || depth >= crawlMaxDepth) continue;
      for (const link of extractSameHostLinks(html, pageUrl, host)) {
        const linkNorm = normalizePageUrl(link);
        if (!linkNorm || queued.has(linkNorm)) continue;
        queued.add(linkNorm);
        queue.push({ url: link, depth: depth + 1 });
      }
    }
    onProgress?.(urls.length, 'crawling site links…');
  }
  if (queue.length && (crawled >= crawlMaxPages || Date.now() >= deadlineTs)) truncated = true;

  return { urls, truncated, sources };
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const MAX_SNIPPETS_PER_PAGE = 5;
const SNIPPET_CONTEXT_CHARS = 45;

/**
 * Fetches one page's raw HTML and searches it for every occurrence of
 * `oldDomain` (case-insensitive substring match — deliberately not
 * restricted to <a href> only, so it also catches canonical/OG tags,
 * JSON-LD, inline scripts, and plain text mentions).
 */
export async function scanUrlForDomain(pageUrl, oldDomain) {
  const html = await fetchText(pageUrl, 20000);
  if (html === null) {
    return { ok: false, error: 'Page did not respond (timed out, or non-200/non-HTML response)', matchCount: 0, snippets: [] };
  }

  const re = new RegExp(escapeRegExp(oldDomain), 'gi');
  const snippets = [];
  let matchCount = 0;
  let m;
  while ((m = re.exec(html)) !== null) {
    matchCount++;
    if (snippets.length < MAX_SNIPPETS_PER_PAGE) {
      const start = Math.max(0, m.index - SNIPPET_CONTEXT_CHARS);
      const end = Math.min(html.length, m.index + m[0].length + SNIPPET_CONTEXT_CHARS);
      const raw = html.slice(start, end).replace(/\s+/g, ' ').trim();
      snippets.push((start > 0 ? '…' : '') + raw + (end < html.length ? '…' : ''));
    }
    // Guard against a pathological/huge page with runaway matches.
    if (matchCount >= 5000) break;
  }

  return { ok: true, error: null, matchCount, snippets };
}

// Overall wall-clock ceiling for one run (discovery + scanning combined).
// Without this, a pathological site (huge/cyclical link graph, thousands of
// slow-responding product pages) could keep a check "running" indefinitely
// — and since the frontend disables "Scan Now" while status is 'running',
// that would leave the user with no way to retry. Whatever's been found by
// the deadline is reported as a (truncated) completed result rather than a
// failure — a partial answer is still useful.
const MAX_RUN_MS = 25 * 60 * 1000;

/**
 * Full run: discover every page, scan each for `oldDomain`, and write
 * progress into `doc` (a UrlCheck mongoose document) as it goes so the
 * frontend can poll GET /api/url-check/:siteId/latest for live progress
 * instead of watching a frozen-looking "Scanned 0 of … pages found" during
 * the (potentially multi-minute) discovery phase. Sites can have thousands
 * of pages, so the whole thing can legitimately take minutes.
 */
// Mongoose refuses a second save() on the same document instance while an
// earlier one is still in flight ("Can't save() the same doc multiple times
// in parallel"). This run has MANY places that want to persist progress —
// discovery's onProgress fires once per crawl batch (which on a fast site
// can happen many times in quick succession), and the scan loop below has
// several concurrent workers each wanting to persist periodically. None of
// those callers await each other, so without this, two progress-saves could
// easily overlap (confirmed live: a crawl that found pages quickly hit
// exactly this error a few dozen batches in). Chaining every save through
// the same promise — each one only starts once the previous has actually
// finished — makes save() calls from anywhere in this function safe to fire
// without the caller needing to coordinate with any other caller.
function makeSerialSaver(doc) {
  let chain = Promise.resolve();
  return () => {
    chain = chain.then(() => doc.save()).catch((e) => {
      console.error('[urlCheck] doc.save() failed:', e.message);
    });
    return chain;
  };
}

export async function runUrlCheck(doc, site, oldDomain, { scanConcurrency = 6 } = {}) {
  const deadlineTs = Date.now() + MAX_RUN_MS;
  const saveDoc = makeSerialSaver(doc);

  doc.phase = 'discovering';
  await saveDoc();

  let sinceLastDiscoverySave = 0;
  const { urls, truncated: discoveryTruncated, sources } = await discoverAllPages(site, {
    deadlineTs,
    onProgress: (count, phaseLabel) => {
      doc.totalPages = count;
      doc.phaseLabel = phaseLabel;
      // Throttled the same way the scan-progress saves below are — this
      // fires once per source plus once per crawl batch, which on a big
      // crawl could otherwise be dozens of writes in quick succession.
      if (++sinceLastDiscoverySave >= 5) {
        sinceLastDiscoverySave = 0;
        saveDoc();
      }
    },
  });

  doc.phase = 'scanning';
  doc.phaseLabel = null;
  doc.totalPages = urls.length;
  doc.discoverySources = sources;
  doc.scannedPages = 0;
  await saveDoc();

  const matches = [];
  let scanned = 0;
  let sinceLastSave = 0;
  let timedOut = false;

  await mapWithConcurrency(urls, scanConcurrency, async (pageUrl) => {
    if (Date.now() >= deadlineTs) { timedOut = true; return; }
    const result = await scanUrlForDomain(pageUrl, oldDomain);
    scanned++;
    sinceLastSave++;
    if (result.ok && result.matchCount > 0) {
      matches.push({ pageUrl, matchCount: result.matchCount, snippets: result.snippets });
    } else if (!result.ok) {
      doc.unreachablePages = (doc.unreachablePages || 0) + 1;
    }
    // Persist progress every ~15 pages (or on the last one) rather than on
    // every single page — thousands of individual writes would otherwise
    // hammer MongoDB for no real benefit to the polling UI.
    if (sinceLastSave >= 15 || scanned === urls.length) {
      doc.scannedPages = scanned;
      sinceLastSave = 0;
      await saveDoc();
    }
  });

  doc.matches = matches;
  doc.scannedPages = scanned;
  doc.truncated = discoveryTruncated || timedOut || scanned < urls.length;
  doc.phase = null;
  doc.status = 'completed';
  doc.finishedAt = new Date();
  await saveDoc();
  return doc;
}
