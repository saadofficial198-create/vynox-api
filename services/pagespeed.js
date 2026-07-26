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

  const { data } = await axios.get(`${API_URL}?${params.toString()}`, { timeout: 60000 });

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

const RETRY_ATTEMPTS = 3; // 1 initial try + 2 retries
const RETRY_DELAY_MS = 8000; // Lighthouse/PageSpeed transient failures (timeouts,
// FAILED_DOCUMENT_REQUEST, rate limits) are usually gone a few seconds later —
// this is not a real problem with the page, just Google's crawler having a
// bad moment, so we only record "Failed" once all attempts are exhausted.

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Runs PageSpeed checks for every monitoredPage of a single site (mobile
 * strategy only, to keep API usage low — desktop can be added later if needed),
 * saves one PageSpeedResult per page, and returns the array of saved docs.
 */
export async function checkSitePageSpeed(site) {
  const pages = site.monitoredPages?.length ? site.monitoredPages : [{ label: 'Home', path: '/' }];
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
 */
export async function checkAllSitesPageSpeed() {
  const sites = await Site.find().lean(false); // full docs, need monitoredPages
  const summary = [];
  for (const site of sites) {
    try {
      const results = await checkSitePageSpeed(site);
      summary.push({ site: site.name, ok: true, pages: results.length });
    } catch (e) {
      summary.push({ site: site.name, ok: false, error: e.message });
    }
  }
  return summary;
}
