import axios from 'axios';
import Site from '../models/Site.js';
import PageSpeedResult from '../models/PageSpeedResult.js';

const API_URL = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const CATEGORIES = ['performance', 'seo', 'accessibility', 'best-practices'];

function joinUrl(base, path) {
  const b = String(base || '').trim().replace(/\/$/, '');
  const p = String(path || '/').trim();
  if (p === '/' || p === '') return b + '/';
  return b + (p.startsWith('/') ? p : `/${p}`);
}

function msFromMetricString(str) {
  // CrUX/Lighthouse sometimes returns "1.2 s" style displayValue; we prefer
  // numericValue (already in ms) when present, this is just a fallback.
  if (str == null) return null;
  const n = parseFloat(String(str).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Calls Google's PageSpeed Insights API for one URL + one strategy.
 * Returns a plain object matching the shape we store in PageSpeedResult.
 */
export async function fetchPageSpeed(fullUrl, strategy = 'mobile') {
  const apiKey = process.env.PAGESPEED_API_KEY;
  if (!apiKey) throw new Error('PAGESPEED_API_KEY is not set in .env');

  const params = new URLSearchParams({ url: fullUrl, key: apiKey, strategy });
  for (const c of CATEGORIES) params.append('category', c);

  // 120s (up from 60s) — when the target site's own server is under heavy
  // CPU load (slow to respond), Google's Lighthouse crawler can take a long
  // time to finish loading the page before it even gets to FAILED_DOCUMENT_REQUEST;
  // a short axios timeout here just gives up on our side before Lighthouse does.
  const { data } = await axios.get(`${API_URL}?${params.toString()}`, { timeout: 120000 });

  const lh = data.lighthouseResult;
  const cats = lh?.categories || {};
  const audits = lh?.audits || {};
  const crux = data.loadingExperience?.metrics || {}; // real-user field data, if Google has enough traffic data for this URL

  const scores = {
    performance:   cats.performance   ? Math.round(cats.performance.score   * 100) : null,
    seo:           cats.seo           ? Math.round(cats.seo.score           * 100) : null,
    accessibility: cats.accessibility ? Math.round(cats.accessibility.score * 100) : null,
    bestPractices: cats['best-practices'] ? Math.round(cats['best-practices'].score * 100) : null,
  };

  // Prefer real-user field data (CrUX) for vitals; fall back to Lighthouse lab data.
  const vitals = {
    lcpMs:    crux.LARGEST_CONTENTFUL_PAINT_MS?.percentile ?? audits['largest-contentful-paint']?.numericValue ?? null,
    clsScore: crux.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile != null
                ? crux.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100
                : audits['cumulative-layout-shift']?.numericValue ?? null,
    inpMs:    crux.INTERACTION_TO_NEXT_PAINT?.percentile ?? null,
    fcpMs:    crux.FIRST_CONTENTFUL_PAINT_MS?.percentile ?? audits['first-contentful-paint']?.numericValue ?? null,
    ttfbMs:   audits['server-response-time']?.numericValue ?? msFromMetricString(audits['server-response-time']?.displayValue) ?? null,
  };

  return { scores, vitals, raw: { fetchTime: lh?.fetchTime, finalUrl: lh?.finalUrl } };
}

const RETRY_ATTEMPTS = 5; // 1 initial try + 4 retries (raised from 3 — cPanel
// CPU load spikes were causing FAILED_DOCUMENT_REQUEST on nearly every page,
// every time, so a couple of quick retries weren't enough headroom)
const RETRY_DELAY_MS = 20000; // 20s between attempts (raised from 8s) — gives
// the target site's own server more time to recover from a CPU spike before
// Lighthouse/PageSpeed transient failures (timeouts, FAILED_DOCUMENT_REQUEST,
// NO_FCP, rate limits) are usually gone a bit later — this is not a real
// problem with the page, just Google's crawler (or the site's own server)
// having a bad moment, so we only record "Failed" once all attempts are
// exhausted.

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Runs PageSpeed checks for every monitoredPage of a single site (mobile
 * strategy only, to keep API usage low — desktop can be added later if needed),
 * saves one PageSpeedResult per page, and returns the array of saved docs.
 *
 * Skips any page that's disabled (page.enabled === false) or currently
 * mismatched against the sitemap (page.matchStatus === 'mismatch' — see
 * services/sitemapDetect.js's refreshPageMatchStatus and models/Site.js).
 * Running a real Google PageSpeed check against a page whose slug no longer
 * exists just burns API quota for a result that will always fail, and (like
 * the equivalent screenshot skip in services/screenshot.js) risks recording
 * a misleading score for the WRONG page if the slug now happens to resolve
 * to something else entirely.
 */
export async function checkSitePageSpeed(site) {
  const allPages = site.monitoredPages?.length ? site.monitoredPages : [{ label: 'Home', path: '/' }];
  const pages = allPages.filter(p => p.enabled !== false && p.matchStatus !== 'mismatch');
  const results = [];

  for (const page of pages) {
    const fullUrl = joinUrl(site.url, page.path);
    let lastError = null;

    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
      try {
        const { scores, vitals, raw } = await fetchPageSpeed(fullUrl, 'mobile');
        const doc = await PageSpeedResult.create({
          site: site._id,
          pageLabel: page.label,
          pagePath: page.path,
          fullUrl,
          strategy: 'mobile',
          ok: true,
          scores,
          vitals,
          raw,
        });
        results.push(doc);
        lastError = null;
        break; // success — stop retrying this page
      } catch (e) {
        lastError = e;
        const isLastAttempt = attempt === RETRY_ATTEMPTS;
        console.log(`[pagespeed] ${fullUrl} attempt ${attempt}/${RETRY_ATTEMPTS} failed: ${e.response?.data?.error?.message || e.message}${isLastAttempt ? '' : ' — retrying...'}`);
        if (!isLastAttempt) await sleep(RETRY_DELAY_MS);
      }
    }

    if (lastError) {
      const doc = await PageSpeedResult.create({
        site: site._id,
        pageLabel: page.label,
        pagePath: page.path,
        fullUrl,
        strategy: 'mobile',
        ok: false,
        error: lastError.response?.data?.error?.message || lastError.message,
      });
      results.push(doc);
    }
  }
  return results;
}

/**
 * Runs PageSpeed checks for every site in the DB, one at a time (sequential
 * on purpose — Google's free tier is generous but we don't need to hammer it,
 * and running sites in parallel makes error messages harder to read in logs).
 *
 * Sites where pagesConfigured is still false are skipped entirely — same
 * reasoning as services/screenshot.js's captureAllSites: a site the plugin
 * just auto-registered hasn't had its page selection reviewed yet, so there's
 * nothing meaningful to check against (the hardcoded default guesses are
 * exactly what caused wrong-page/404 results before this feature existed).
 *
 * A single site throwing (network error, bad data, anything) is caught here
 * and recorded in the summary — it never stops the loop for the rest of the
 * sites.
 */
export async function checkAllSitesPageSpeed() {
  const sites = await Site.find().lean(false); // full docs, need monitoredPages
  const summary = [];
  for (const site of sites) {
    if (!site.pagesConfigured) {
      summary.push({ site: site.name, ok: true, pages: 0, skipped: 'pagesConfigured is false — no page selection saved yet' });
      continue;
    }
    try {
      const results = await checkSitePageSpeed(site);
      summary.push({ site: site.name, ok: true, pages: results.length });
    } catch (e) {
      summary.push({ site: site.name, ok: false, error: e.message });
    }
  }
  return summary;
}
