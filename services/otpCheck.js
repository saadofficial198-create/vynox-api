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

/**
 * Triggers the OTP send by calling the plugin's own AJAX endpoint directly,
 * then verifies the email actually arrived via IMAP.
 * @param {{ ajaxUrl: string }} opts - ajaxUrl: that site's own
 *   "{url}/wp-admin/admin-ajax.php" — every site provides its own, so this
 *   function has no knowledge of which site it's checking.
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
export async function runOtpCheck({ ajaxUrl }) {
  if (!ajaxUrl) {
    throw new Error('runOtpCheck requires { ajaxUrl } — the target site\'s own admin-ajax.php URL');
  }

  const email = process.env.OTP_TEST_EMAIL;
  if (!email) {
    throw new Error('OTP_TEST_EMAIL is not set — required as the target email for the send_otp AJAX call and the IMAP mailbox to poll');
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

  try {
    result.triggeredAt = new Date();
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
    const res = await axios.post(
      ajaxUrl,
      new URLSearchParams({ action: 'send_otp', email }).toString(),
      {
        headers,
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
      }
    );

    const ok = res.status === 200 && res.data && res.data.success === true;
    if (ok) {
      result.popupAppeared = true;
    } else {
      result.popupAppeared = false;
      const serverMsg = res.data?.data?.message || JSON.stringify(res.data);
      result.popupError = `send_otp AJAX call did not report success (HTTP ${res.status}): ${serverMsg}`;
    }
  } catch (e) {
    result.popupAppeared = false;
    result.popupError = `send_otp AJAX call failed: ${e.message}`;
  }

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
