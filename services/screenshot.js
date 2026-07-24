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
    await tab.goto(fullUrl, { waitUntil: 'networkidle', timeout: 45000 });
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

/** Captures every monitored page for one site. Reuses a single browser instance across pages. */
export async function captureSite(browser, site) {
  const pages = site.monitoredPages?.length ? site.monitoredPages : [{ label: 'Home', path: '/' }];
  const results = [];
  for (const page of pages) {
    results.push(await captureSitePage(browser, site, page));
  }
  return results;
}

/** Captures every monitored page for every site. Launches one browser for the whole run. */
export async function captureAllSites() {
  const sites = await Site.find().lean(false);
  const browser = await chromium.launch({ headless: true });
  const summary = [];
  try {
    for (const site of sites) {
      try {
        const results = await captureSite(browser, site);
        const flagged = results.filter(r => r.diffFlagged).length;
        summary.push({ site: site.name, ok: true, pages: results.length, flagged });
      } catch (e) {
        summary.push({ site: site.name, ok: false, error: e.message });
      }
    }
  } finally {
    await browser.close();
  }
  return summary;
}
