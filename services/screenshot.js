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

// IMPORTANT: none of the constants below are "wait N seconds then screenshot"
// delays. Every wait in this file is driven by actually POLLING the page
// (via tab.waitForFunction, checking real DOM/network state) until the
// condition is true, and only stops early if that ceiling is hit. A fast
// site finishes in a couple seconds; a slow one can use the full ceiling.
// The old bug was a fixed 25s timeout used as the actual "is it loaded"
// signal — that's exactly what these ceilings are NOT supposed to be.
//
// Hard ceiling on Playwright's own navigation wait (goto). Slow WordPress
// sites (heavy plugins, cheap shared hosting) routinely need more than the
// old 25s. This is just a safety cap so one dead/hanging site can't freeze
// the run forever — captureAllSites() also isolates failures per-site.
const NAV_TIMEOUT_MS = Number(process.env.SCREENSHOT_NAV_TIMEOUT_MS || 60000);
// Ceiling for the post-navigation "is everything actually settled" poll
// (images finished decoding, no visible loading spinner, network quiet).
// waitForRealPageReady() below checks the real condition every ~500ms and
// returns as soon as it's true — this is only the worst-case cap if a page
// never actually settles (e.g. a plugin that polls forever in the background).
const IMAGE_SETTLE_TIMEOUT_MS = Number(process.env.SCREENSHOT_IMAGE_SETTLE_TIMEOUT_MS || 45000);
// How long to poll for an overlay/popup to actually disappear after we try
// to close/hide it, before moving on regardless.
const OVERLAY_SETTLE_TIMEOUT_MS = Number(process.env.SCREENSHOT_OVERLAY_SETTLE_TIMEOUT_MS || 8000);
// How long to wait for a bot-verification/security-challenge interstitial
// (Cloudflare "Just a moment...", Imunify360 "Please wait while your request
// is being verified...", generic JS challenge pages) to clear on its own
// before giving up. Many of these ARE designed to auto-resolve in a few
// seconds for a real browser (Playwright's Chromium looks like one), so it's
// worth polling for real instead of immediately treating it as a hard fail —
// but if it's a genuine permanent block (server firewall denying our IP/UA
// outright), it will never clear and we need to stop waiting and flag it.
const CHALLENGE_CLEAR_TIMEOUT_MS = Number(process.env.SCREENSHOT_CHALLENGE_CLEAR_TIMEOUT_MS || 20000);

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
 * Scrolls the page down in steps (top to bottom) and back up. This is what
 * actually triggers lazy-loaded images (native loading="lazy" and the JS
 * IntersectionObserver-based lazy-load plugins WordPress sites commonly use)
 * — those images never fire their load event until the browser thinks
 * they're near the viewport, so without scrolling, "wait for images to load"
 * would wait forever for images that are never even asked to load.
 *
 * Deliberately does NOT click anything (no "Load More" / "Show more"
 * buttons) — per requirement, we only want the images that load
 * automatically via scroll, never content that requires an explicit click.
 */
async function autoScroll(tab) {
  await tab.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, step);
        total += step;
        if (total >= scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 150); // small pause between steps so lazy-load observers actually fire
    });
  });
  // Give any observers/animations triggered by the final scroll step a brief
  // moment to start, then return to the top for the actual screenshot
  // (fullPage screenshots capture from current DOM state regardless of
  // scroll position, but starting from the top avoids any scroll-position
  // side effects on sticky headers etc.).
  await tab.waitForTimeout(300);
  await tab.evaluate(() => window.scrollTo(0, 0));
}

/**
 * Polls (does not just wait a fixed time) until every currently-visible
 * <img> on the page has actually finished loading — i.e. real detection via
 * naturalWidth/naturalHeight and the element's own `complete` flag, not a
 * guess. Also treats CSS background-image on large visible elements as
 * "loaded" once the underlying request settles, by leaning on the browser's
 * own decode() where available.
 *
 * Returns true if everything settled before the ceiling, false if the
 * ceiling was hit with something still pending (caller still screenshots —
 * partial-but-real is better than refusing to ever capture a stubborn page).
 */
async function waitForImagesLoaded(tab, timeoutMs) {
  try {
    await tab.waitForFunction(
      () => {
        const imgs = Array.from(document.images || []);
        return imgs.every((img) => {
          // offsetParent === null means the element isn't actually visible/
          // rendered (display:none, detached, etc.) — no point waiting on it.
          if (img.offsetParent === null && img.loading !== 'eager') return true;
          return img.complete && img.naturalWidth > 0;
        });
      },
      { timeout: timeoutMs, polling: 250 }
    );
    return true;
  } catch {
    return false; // hit the ceiling — proceed anyway with whatever loaded
  }
}

/**
 * Polls until there is no visible "still working" indicator on the page.
 * Network-level idle detection is already handled by the caller (tab.goto's
 * waitUntil: 'networkidle'); this function specifically watches for
 * JS-driven loading spinners that a lot of WordPress themes/plugins show
 * client-side even after the initial network is idle (e.g. a "Load More"
 * section still finishing its own fetch that started on scroll, or a
 * skeleton loader before content swaps in).
 *
 * Detection is generic/behavioral, not tied to any site's specific class
 * names: it looks for visible elements whose class/id/aria-label CONTAINS
 * common loading-related substrings ("spinner", "loading", "loader",
 * "skeleton", "lazy-placeholder") OR elements with role="progressbar" /
 * aria-busy="true". If none are found to begin with, this resolves
 * immediately.
 */
async function waitForNoActiveSpinners(tab, timeoutMs) {
  try {
    await tab.waitForFunction(
      () => {
        const isVisible = (el) => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          const style = window.getComputedStyle(el);
          return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
        };
        const candidates = Array.from(document.querySelectorAll(
          '[class*="spinner" i], [class*="loading" i], [class*="loader" i], ' +
          '[class*="skeleton" i], [id*="spinner" i], [id*="loading" i], ' +
          '[role="progressbar"], [aria-busy="true"]'
        ));
        return candidates.every((el) => !isVisible(el));
      },
      { timeout: timeoutMs, polling: 250 }
    );
    return true;
  } catch {
    return false; // some spinner-like element never disappeared — proceed anyway
  }
}

/**
 * Detects and removes popup/modal/overlay elements WITHOUT knowing anything
 * about the specific site — no hardcoded IDs or class names, because every
 * site's cookie banner / subscribe modal / newsletter popup is built
 * differently (different plugin, different theme, custom code). Instead
 * this uses the same behavioral signature basically every overlay shares
 * regardless of implementation:
 *
 *   1. position is fixed or sticky (overlays don't scroll away with content)
 *   2. it covers a large chunk of the viewport (width/height ratio above a
 *      threshold) OR sits on top of everything via a very high z-index while
 *      covering a meaningful area (banners across the top/bottom count too)
 *   3. it's actually visible (not display:none, not zero-size, not
 *      offscreen)
 *
 * For each match we first try clicking an obvious close control INSIDE it
 * (generic patterns: aria-label containing "close"/"dismiss", visible text
 * that is exactly "x"/"×"/"✕"/"close"/"no thanks"/"skip", or a child with a
 * class name containing "close"/"dismiss"/"modal-close"). If no close
 * control can be found/clicked, we forcibly hide the element via inline
 * style — belt-and-suspenders, since the goal ("popup must not be in the
 * screenshot") matters more than closing it "properly".
 *
 * Runs twice by design (see captureSitePage): once right after initial
 * load, and again after auto-scrolling, because a lot of popups are
 * scroll-triggered or exit-intent-triggered and don't exist yet on first
 * paint.
 */
async function dismissOverlays(tab) {
  return tab.evaluate(() => {
    const CLOSE_TEXT_PATTERNS = ['close', 'dismiss', 'no thanks', 'not now', 'skip', '×', '✕', 'x'];

    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
      return true;
    };

    const looksLikeOverlay = (el) => {
      const style = window.getComputedStyle(el);
      if (style.position !== 'fixed' && style.position !== 'sticky') return false;
      if (!isVisible(el)) return false;
      const r = el.getBoundingClientRect();
      const viewportArea = window.innerWidth * window.innerHeight;
      const elArea = r.width * r.height;
      const coverageRatio = elArea / viewportArea;
      const zIndex = Number(style.zIndex) || 0;
      // Either it covers a big share of the screen (a true modal/lightbox),
      // or it's a full-width bar (top or bottom banner) with a high z-index —
      // catches slim cookie-consent bars that don't cover much area but are
      // definitely an intrusive overlay.
      const isFullWidthBar = r.width / window.innerWidth > 0.9 && r.height < window.innerHeight * 0.5;
      return (coverageRatio > 0.25) || (isFullWidthBar && zIndex >= 100);
    };

    const findCloseControl = (root) => {
      const candidates = Array.from(root.querySelectorAll('button, a, [role="button"], span, div'));
      for (const el of candidates) {
        if (!isVisible(el)) continue;
        const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
        const cls = (el.className && typeof el.className === 'string' ? el.className : '').toLowerCase();
        const text = (el.textContent || '').trim().toLowerCase();
        if (CLOSE_TEXT_PATTERNS.some((p) => aria.includes(p))) return el;
        if (/close|dismiss|modal-close|popup-close/.test(cls)) return el;
        if (text.length <= 12 && CLOSE_TEXT_PATTERNS.includes(text)) return el;
      }
      return null;
    };

    const allEls = Array.from(document.querySelectorAll('body *'));
    const overlays = allEls.filter(looksLikeOverlay);
    let handled = 0;

    for (const overlay of overlays) {
      const closeBtn = findCloseControl(overlay);
      if (closeBtn) {
        try { closeBtn.click(); handled++; continue; } catch { /* fall through to force-hide */ }
      }
      // No close control found (or click failed) — force it out of the
      // render tree so it can never appear in the screenshot, regardless of
      // what the site's own code does.
      overlay.style.setProperty('display', 'none', 'important');
      handled++;
    }

    // Common side-effect of overlay libraries: they lock body scroll via a
    // class/style on <html>/<body> even after the overlay itself is hidden,
    // which can leave a fullPage screenshot mis-sized. Clear the obvious ones.
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';

    return handled;
  }).catch(() => 0);
}

/**
 * Detects whether the CURRENT page is a bot-verification / security-
 * challenge interstitial instead of the site's real content — e.g.
 * Cloudflare's "Checking your browser before accessing..." / "Just a
 * moment...", Imunify360's "Please wait while your request is being
 * verified...", generic hCaptcha/reCAPTCHA challenge screens, or any other
 * host's WAF/anti-bot splash page. This is exactly what was happening in
 * practice: the daily screenshot job captured a cPanel/Imunify360
 * verification splash instead of the real page, and nothing in the pipeline
 * noticed or flagged it — it just silently got recorded as if it were a
 * normal, successful capture.
 *
 * Detection is deliberately generic/text-based (not tied to any one
 * provider's markup), since — same reasoning as dismissOverlays() — every
 * hosting provider's firewall/challenge page is built differently and we
 * can't hardcode selectors for all of them, current or future. We check the
 * page's visible text for a set of phrases that are near-universal across
 * these challenge pages, phrased in a way generic enough to catch new ones
 * we haven't seen without also matching ordinary page content.
 */
async function looksLikeSecurityChallenge(tab) {
  return tab.evaluate(() => {
    const text = (document.body?.innerText || '').toLowerCase();
    const PATTERNS = [
      'checking your browser',
      'just a moment',
      'please wait while your request is being verified',
      'verifying you are human',
      'verify you are a human',
      'ddos protection by',
      'attention required! | cloudflare',
      'please stand by, while we are checking your browser',
      'this process is automatic',
      'your browser will redirect shortly',
      'ray id:', // Cloudflare's block/challenge pages always show a Ray ID
      'access denied by imunify360',
      'blocked by imunify360',
      'imunify360 bot-protection',
    ];
    return PATTERNS.some((p) => text.includes(p));
  }).catch(() => false);
}

/**
 * Polls (real detection, not a blind delay) waiting for a detected
 * challenge page to clear — many JS-based challenges auto-resolve within a
 * few seconds for a real browser, which is exactly what Playwright's
 * Chromium is. Returns true once the challenge text is gone (or never
 * appeared), false if it's still present when CHALLENGE_CLEAR_TIMEOUT_MS is
 * hit — meaning this looks like a genuine, standing block rather than a
 * brief interstitial.
 */
async function waitForChallengeToClear(tab, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const stillChallenged = await looksLikeSecurityChallenge(tab);
    if (!stillChallenged) return true;
    await tab.waitForTimeout(1000);
  }
  return !(await looksLikeSecurityChallenge(tab));
}

/**
 * Combines all of the above into one "is this page actually ready to
 * screenshot" wait. Every step is real polling against page state, never a
 * blind sleep:
 *   0. check for a bot-verification/security-challenge interstitial FIRST —
 *      if the server's firewall is showing a "please wait, verifying..."
 *      splash instead of the real page, there is no point scrolling for
 *      lazy images or hunting for popups on that splash page. Poll for it to
 *      clear (a real browser often passes automatically within seconds);
 *      only proceed to the normal steps once it's gone (or never appeared).
 *   1. dismiss any overlay visible immediately after load
 *   2. auto-scroll (triggers lazy images), then dismiss any overlay that
 *      only appeared because of scrolling (scroll-triggered popups)
 *   3. wait for images to finish loading for real (naturalWidth check)
 *   4. wait for any generic loading-spinner-like element to disappear
 *   5. one final overlay sweep, in case something appeared while step 3/4
 *      were polling (e.g. a timed popup that fires N seconds after load)
 *
 * Returns { challengeBlocked } — true if a security-challenge page was
 * detected and NEVER cleared within CHALLENGE_CLEAR_TIMEOUT_MS, meaning
 * whatever gets screenshotted next is very likely still the challenge splash,
 * not the real page. The caller records this distinctly instead of silently
 * treating it as a normal successful capture.
 */
async function waitForRealPageReady(tab) {
  let challengeBlocked = false;
  if (await looksLikeSecurityChallenge(tab)) {
    const cleared = await waitForChallengeToClear(tab, CHALLENGE_CLEAR_TIMEOUT_MS);
    challengeBlocked = !cleared;
  }

  if (!challengeBlocked) {
    await dismissOverlays(tab);
    await autoScroll(tab);
    await dismissOverlays(tab);

    await waitForImagesLoaded(tab, IMAGE_SETTLE_TIMEOUT_MS);
    await waitForNoActiveSpinners(tab, IMAGE_SETTLE_TIMEOUT_MS);

    await dismissOverlays(tab);
    // Brief real wait tied to the overlay ceiling: if that last sweep just
    // hid something large, let layout/reflow settle before the screenshot.
    await tab.waitForTimeout(Math.min(500, OVERLAY_SETTLE_TIMEOUT_MS));
  }

  return { challengeBlocked };
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
    // NAV_TIMEOUT_MS is a safety ceiling, not the "is it loaded" signal —
    // waitForRealPageReady() below is what actually detects readiness.
    await tab.goto(fullUrl, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT_MS });

    // Real detection, not a fixed delay: dismiss popups, trigger + wait for
    // lazy-loaded images, wait for loading spinners to clear, sweep for any
    // popup that appeared afterward. See function docs above for details.
    const { challengeBlocked } = await waitForRealPageReady(tab);

    if (challengeBlocked) {
      // A bot-verification/security-challenge splash (Cloudflare, Imunify360,
      // or similar) never cleared — whatever's on screen is that splash, not
      // the real page. Recording it as a normal successful capture would
      // silently store a misleading screenshot every single day, which is
      // exactly what was happening before this check existed. We deliberately
      // do NOT upload/save an image for this run — the previous good capture
      // stays as the last-known-good reference — and flag it distinctly so
      // it can be surfaced as an alert (see routes/alerts.js, Site model's
      // screenshotChallengeStatus) instead of just disappearing into a
      // generic error message.
      return Screenshot.create({
        site: site._id,
        pageLabel: page.label,
        pagePath: page.path,
        fullUrl,
        ok: false,
        challengeBlocked: true,
        error: 'A bot-verification/security-challenge page (e.g. Cloudflare or Imunify360) was shown instead of the real page, and did not clear in time. This site\'s hosting server is likely blocking our automated screenshot capture as bot traffic — see the Imunify360 allowlist guide, or check this server\'s firewall/WAF settings.',
      });
    }

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

  // Site-level challenge-blocked flag (see models/Site.js's
  // screenshotChallengeBlocked): true if ANY page for this site hit an
  // unresolved bot-verification challenge on this run, cleared back to false
  // as soon as at least one page captures normally again. Auto-clearing
  // (rather than requiring manual confirmation like imunify360Status) is
  // deliberate here — a challenge page appearing is something the NEXT run
  // can disprove on its own, unlike the OTP monitor's Imunify360 block which
  // needs a human to actually go add a firewall allowlist rule before it can
  // possibly resolve.
  const anyChallengeBlocked = results.some((r) => r.challengeBlocked === true);
  if (anyChallengeBlocked !== site.screenshotChallengeBlocked) {
    site.screenshotChallengeBlocked = anyChallengeBlocked;
    await site.save().catch(() => {}); // best-effort — a failed flag update shouldn't fail the whole capture run
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
