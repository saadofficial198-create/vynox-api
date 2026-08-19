import axios from 'axios';
import { checkForOtpEmail } from './imapCheck.js';

// Layer 3 of the OTP-email-delivery monitor.
//
// Originally this drove a full headless-browser checkout flow (add to cart,
// fill the billing form, click "Place order") to trigger the OTP email. That
// turned out to be unnecessarily fragile — after reading the actual OTP
// plugin source (woocommerce-email-otp.php), the real trigger is just a
// plain WordPress AJAX call the plugin's own JS makes when "Place order" is
// clicked:
//
//   POST {site}/wp-admin/admin-ajax.php
//   Content-Type: application/x-www-form-urlencoded
//   Body: action=send_otp&email=<billing email>
//
// (see add_action('wp_ajax_nopriv_send_otp', 'send_otp') in the plugin — it's
// registered for both logged-in AND logged-out ("nopriv") users, requires no
// nonce/cart/session state, and just rand()s a 6-digit OTP, stores it in the
// WC session, and calls wp_mail(). So hitting this endpoint directly with a
// plain HTTP POST is the exact same server-side action a real "Place order"
// click causes — no browser, no cart, no checkout form needed at all.
//
// This is generic to any site running this same OTP plugin (the action name
// "send_otp" and the "email" field are the plugin's fixed contract) — the
// AJAX URL is passed in per-call (derived from that site's own `url` field
// already stored in MongoDB, see scripts/runOtpCheck.js), NOT hardcoded to
// any one site. Adding another site with this plugin requires zero .env
// changes — the caller just builds `${site.url}/wp-admin/admin-ajax.php`.
//
// IMPORTANT: this deliberately never calls the "verify_otp" action — we only
// trigger the send, then confirm delivery via IMAP. No WooCommerce order is
// created by any of this (verify_otp + a real form submit would be needed
// for that), so there's nothing to clean up.
//
// Imunify360 (a bot-protection layer many cPanel hosts run in front of
// WordPress) can flag this plain server-to-server POST as bot traffic and
// return "Access denied by Imunify360 bot-protection" — GitHub Actions runner
// IPs change on every run, so IP whitelisting isn't viable. Instead we send:
//   1. A custom X-Vynox-Bot header carrying OTP_MONITOR_SECRET, which the
//      site admin whitelists in Imunify360's "Allowlist by header" (or
//      equivalent) rule — this works for any number of sites without ever
//      touching an IP list.
//   2. A normal-looking browser User-Agent, since some bot-protection rules
//      also flag on missing/non-browser UAs.

const REQUEST_TIMEOUT_MS = 20_000;
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Some sites' send_otp calls fail for reasons that have nothing to do with
// Imunify360 or our code — e.g. VIZKART's own plugin (woocommerce-email-otp.php)
// calls wp_mail() and reports "Email sending failed." whenever THAT single
// call to wp_mail() returns false, which cPanel's own SMTP ("Other SMTP" in
// WP Mail SMTP) can do transiently (a brief per-hour send-rate limit, or a
// slow/timed-out local SMTP handshake) even though the site's mail sending
// works fine most of the time — confirmed live: a manual checkout in a real
// browser at the same time delivered the OTP email successfully. Retrying
// once after a short delay avoids marking the whole check "failed" over a
// one-off hiccup on the SITE's end, the same way services/pagespeed.js
// already retries transient Lighthouse/PageSpeed failures.
//
// Imunify360 blocks are NOT retried here — see isImunify360Block below —
// because that's a different, non-transient failure (a firewall rule that
// won't fix itself moments later); retrying it would just waste time and
// still fail, so it's reported immediately instead.
const SEND_OTP_RETRY_DELAY_MS = 25_000;

function isImunify360Block(errorMessage) {
  return typeof errorMessage === 'string' && /imunify360/i.test(errorMessage);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// AJAX action name per OTP provider (see services/otpLayers.js for how the
// provider is detected from a site's plugin list):
//   'legacy' — the "WooCommerce Email OTP Verification" plugin's own
//              `send_otp` action, which needs no nonce/cart/session.
//   'vynox'  — our own vynox-checkout/vynox-commerce plugin. Its real
//              `vynox_request_otp` action requires a checkout-page nonce
//              and a non-empty WooCommerce cart (both tied to an actual
//              browser session, unlike 'legacy' — see the plugin's
//              class-otp.php), so it added a monitoring-only
//              `vynox_otp_monitor_check` action instead, gated by the
//              site's own `apiKey` (X-Vynox-Key header) rather than a
//              nonce/cart.
function actionNameFor(provider) {
  return provider === 'vynox' ? 'vynox_otp_monitor_check' : 'send_otp';
}

/**
 * One attempt at calling the plugin's send-OTP AJAX endpoint. Returns
 * { ok, triggeredAt, popupError } — never throws (network errors are
 * captured into popupError, same as before).
 */
async function attemptSendOtp(ajaxUrl, email, provider, apiKey) {
  const triggeredAt = new Date();
  const action = actionNameFor(provider);

  if (provider === 'vynox' && !apiKey) {
    return { ok: false, triggeredAt, popupError: 'vynox provider requires the site\'s own apiKey (sent as X-Vynox-Key) but none was provided' };
  }

  try {
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': BROWSER_USER_AGENT,
    };
    // Optional — only sent if configured. Lets a site's Imunify360 (or any
    // similar bot-protection) allowlist this monitor by header instead of by
    // IP, which would otherwise need updating on every GitHub Actions run.
    if (process.env.OTP_MONITOR_SECRET) {
      headers['X-Vynox-Bot'] = process.env.OTP_MONITOR_SECRET;
    }
    // 'vynox' provider's monitoring action authenticates with the site's
    // own connector API key instead of a checkout nonce/cart — see the
    // comment on actionNameFor above.
    if (provider === 'vynox') {
      headers['X-Vynox-Key'] = apiKey;
    }
    const res = await axios.post(
      ajaxUrl,
      new URLSearchParams({ action, email }).toString(),
      {
        headers,
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
      }
    );

    const ok = res.status === 200 && res.data && res.data.success === true;
    if (ok) return { ok: true, triggeredAt, popupError: null };

    const serverMsg = res.data?.data?.message || JSON.stringify(res.data);
    return { ok: false, triggeredAt, popupError: `${action} AJAX call did not report success (HTTP ${res.status}): ${serverMsg}` };
  } catch (e) {
    return { ok: false, triggeredAt, popupError: `${action} AJAX call failed: ${e.message}` };
  }
}

/**
 * Triggers the OTP send by calling the plugin's own AJAX endpoint directly,
 * then verifies the email actually arrived via IMAP.
 * @param {{ ajaxUrl: string, provider?: 'legacy'|'vynox', apiKey?: string }} opts
 *   - ajaxUrl: that site's own "{url}/wp-admin/admin-ajax.php" — every site
 *     provides its own, so this function has no knowledge of which site
 *     it's checking.
 *   - provider: which plugin's AJAX contract to use (see actionNameFor
 *     above); defaults to 'legacy' for back-compat with existing callers.
 *   - apiKey: required when provider is 'vynox' — that site's own connector
 *     API key (Site.apiKey), sent as X-Vynox-Key.
 * @returns {Promise<{
 *   triggeredAt: Date,
 *   popupAppeared: boolean,   // kept for schema/back-compat with OtpCheck model — true means "trigger call succeeded" (no popup involved anymore)
 *   popupError: string|null,
 *   emailFound: boolean|null,
 *   emailCheckError: string|null,
 *   emailReceivedAt: Date|null,
 *   otpCode: string|null,
 * }>}
 */
export async function runOtpCheck({ ajaxUrl, provider = 'legacy', apiKey }) {
  if (!ajaxUrl) {
    throw new Error('runOtpCheck requires { ajaxUrl } — the target site\'s own admin-ajax.php URL');
  }

  const email = process.env.OTP_TEST_EMAIL;
  if (!email) {
    throw new Error('OTP_TEST_EMAIL is not set — required as the target email for the send-OTP AJAX call and the IMAP mailbox to poll');
  }

  const result = {
    triggeredAt: null,
    popupAppeared: false, // "trigger succeeded" — name kept for compatibility with the rest of the pipeline
    popupError: null,
    emailFound: null,
    emailCheckError: null,
    emailReceivedAt: null,
    otpCode: null,
  };

  let attempt = await attemptSendOtp(ajaxUrl, email, provider, apiKey);

  // Retry once for failures that look like a transient hiccup on the
  // SITE's own end (e.g. its wp_mail() call briefly failing) rather than a
  // hard block. Imunify360 blocks skip the retry entirely — see the
  // reasoning above SEND_OTP_RETRY_DELAY_MS.
  if (!attempt.ok && !isImunify360Block(attempt.popupError)) {
    console.log(`[otpCheck] ${actionNameFor(provider)} failed on first attempt (${attempt.popupError}) — retrying once in ${SEND_OTP_RETRY_DELAY_MS / 1000}s...`);
    await sleep(SEND_OTP_RETRY_DELAY_MS);
    attempt = await attemptSendOtp(ajaxUrl, email, provider, apiKey);
  }

  result.triggeredAt = attempt.triggeredAt;
  result.popupAppeared = attempt.ok;
  result.popupError = attempt.popupError;

  if (!result.popupAppeared) {
    // Layer 3 "checkout_trigger_failed" — don't bother polling IMAP.
    return result;
  }

  const imapResult = await checkForOtpEmail(result.triggeredAt);
  result.emailFound = imapResult.emailFound;
  result.emailCheckError = imapResult.emailCheckError;
  result.emailReceivedAt = imapResult.emailReceivedAt;
  result.otpCode = imapResult.otpCode;

  return result;
}
