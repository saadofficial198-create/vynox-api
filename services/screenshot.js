import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import sharp from 'sharp';
import Site from '../models/Site.js';
import Screenshot from '../models/Screenshot.js';
import { uploadScreenshot, downloadScreenshot } from './sftpUpload.js';

// If a new screenshot differs from the previous one by more than this %, flag it
// as a possible UI glitch (layout break, error page, blank page, etc.).
const DIFF_FLAG_THRESHOLD_PCT = Number(process.env.SCREENSHOT_DIFF_THRESHOLD_PCT || 15);
// JPEG quality — 70 keeps files small (cPanel storage is finite) while still
// being clear enough to visually spot a broken page.
const JPEG_QUALITY = Number(process.env.SCREENSHOT_JPEG_QUALITY || 70);

function joinUrl(base, p) {
  const b = String(base || '').trim().replace(/\/$/, '');
  const rel = String(p || '/').trim();
  if (rel === '/' || rel === '') return b + '/';
  return b + (rel.startsWith('/') ? rel : `/${rel}`);
}

function safeSlug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

/** Compares two JPEG buffers (converted to raw pixels via sharp) of the same page; returns % differing pixels, or null if sizes mismatch/unreadable. */
async function diffPercent(prevJpegBuf, curJpegBuf) {
  try {
    const [prevRaw, curRaw] = await Promise.all([
      sharp(prevJpegBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
      sharp(curJpegBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    ]);
    if (prevRaw.info.width !== curRaw.info.width || prevRaw.info.height !== curRaw.info.height) {
      return null; // page layout changed shape (e.g. content length differs) — skip diff, don't false-flag
    }
    const { width, height } = curRaw.info;
    const diffImg = new PNG({ width, height });
    const changedPixels = pixelmatch(prevRaw.data, curRaw.data, diffImg.data, width, height, { threshold: 0.1 });
    return (changedPixels / (width * height)) * 100;
  } catch {
    return null;
  }
}

/**
 * Captures one page for one site: navigates with Playwright/Chromium, encodes
 * a JPEG, uploads it to cPanel over SFTP (services/sftpUpload.js), diffs it
 * against the previous capture of the same page, and stores a Screenshot
 * record. Returns the saved doc.
 */
export async function captureSitePage(browser, site, page) {
  const fullUrl = joinUrl(site.url, page.path);
  const siteSlug = safeSlug(site.name || site._id);
  const pageSlug = safeSlug(page.label);
  const fileName = `${pageSlug}-${Date.now()}.jpg`;
  const relativePath = `${siteSlug}/${fileName}`;

  // Find the previous successful capture for this (site, pageLabel) BEFORE
  // we upload the new one, so we have something to diff against.
  const prev = await Screenshot.findOne({ site: site._id, pageLabel: page.label, ok: true })
    .sort({ capturedAt: -1 })
    .lean();

  let ctx;
  try {
    ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const tab = await ctx.newPage();
    // 25s (down from 45s) — long enough for a normally slow WordPress page,
    // but short enough that one down/overloaded site can't eat minutes of
    // the shared capture run for every other site queued behind it.
    await tab.goto(fullUrl, { waitUntil: 'networkidle', timeout: 25000 });
    const pngBuffer = await tab.screenshot({ fullPage: true }); // Playwright only outputs png/jpeg natively; we take png then re-encode below for quality control
    const jpegBuffer = await sharp(pngBuffer).jpeg({ quality: JPEG_QUALITY }).toBuffer();

    const { publicUrl } = await uploadScreenshot(jpegBuffer, relativePath);

    let diffPct = null;
    let diffFlagged = false;
    if (prev?.relativePath) {
      const prevBuf = await downloadScreenshot(prev.relativePath).catch(() => null);
      if (prevBuf) {
        diffPct = await diffPercent(prevBuf, jpegBuffer);
        if (diffPct != null && diffPct >= DIFF_FLAG_THRESHOLD_PCT) diffFlagged = true;
      }
    }

    return Screenshot.create({
      site: site._id,
      pageLabel: page.label,
      pagePath: page.path,
      fullUrl,
      ok: true,
      relativePath,
      publicUrl,
      fileSize: jpegBuffer.length,
      diffPct,
      diffFlagged,
    });
  } catch (e) {
    return Screenshot.create({
      site: site._id,
      pageLabel: page.label,
      pagePath: page.path,
      fullUrl,
      ok: false,
      error: e.message,
    });
  } finally {
    await ctx?.close().catch(() => {});
  }
}

/**
 * Captures every monitored page for one site. Reuses a single browser
 * instance across pages.
 *
 * Skips pages that are either explicitly disabled (page.enabled === false —
 * the user turned it off in Settings without deleting it) or currently
 * mismatched (page.matchStatus === 'mismatch' — the last daily scan
 * couldn't find this path in the site's sitemap anymore, meaning the slug
 * likely changed or the page was removed). Capturing a mismatched page
 * would just screenshot a 404/wrong page and silently record it as if it
 * were a real result, which is the exact problem this whole page-selection
 * system exists to prevent — see models/Site.js's MonitoredPageSchema
 * comment and services/sitemapDetect.js's refreshPageMatchStatus. Skipped
 * pages are reported back to the caller (not just silently dropped) so
 * captureAllSites() can surface them in its summary/logs.
 */
export async function captureSite(browser, site) {
  const allPages = site.monitoredPages?.length ? site.monitoredPages : [{ label: 'Home', path: '/' }];
  const results = [];
  const skipped = [];
  for (const page of allPages) {
    if (page.enabled === false) { skipped.push({ label: page.label, reason: 'disabled' }); continue; }
    if (page.matchStatus === 'mismatch') { skipped.push({ label: page.label, reason: 'mismatch' }); continue; }
    results.push(await captureSitePage(browser, site, page));
  }
  return { results, skipped };
}

/**
 * Captures every monitored page for every site. Launches one browser for
 * the whole run.
 *
 * Sites where pagesConfigured is still false are skipped ENTIRELY (not one
 * page at a time) — this covers a site the WordPress plugin just
 * auto-registered, which starts with no reviewed page selection at all.
 * Running screenshot capture against the hardcoded default guesses
 * (Home/Shop/Contact Us/Track Order) before the user has confirmed real
 * page slugs is exactly how "Contact Us" and "Track Your Order" ended up
 * capturing 404 pages in practice — see models/Site.js's pagesConfigured
 * comment. The user must open Settings and save a page selection (which
 * flips pagesConfigured to true) before this site's captures begin; until
 * then it shows up in the summary as skipped, and a persisted Alert (raised
 * elsewhere, from routes/alerts.js's deriveAlerts) tells the user why.
 *
 * A single site's browser navigation crashing, timing out, or the site
 * being completely down never stops the run for other sites — each site is
 * wrapped in its own try/catch, same as before.
 */
export async function captureAllSites() {
  const sites = await Site.find().lean(false);
  const browser = await chromium.launch({ headless: true });
  const summary = [];
  try {
    for (const site of sites) {
      if (!site.pagesConfigured) {
        summary.push({ site: site.name, ok: true, pages: 0, skipped: 'pagesConfigured is false — no page selection saved yet' });
        continue;
      }
      try {
        const { results, skipped } = await captureSite(browser, site);
        const flagged = results.filter(r => r.diffFlagged).length;
        summary.push({
          site: site.name, ok: true, pages: results.length, flagged,
          ...(skipped.length ? { skippedPages: skipped } : {}),
        });
      } catch (e) {
        // Whatever happened, it's isolated to this one site — every other
        // site in the loop still gets its turn.
        summary.push({ site: site.name, ok: false, error: e.message });
      }
    }
  } finally {
    await browser.close();
  }
  return summary;
}
