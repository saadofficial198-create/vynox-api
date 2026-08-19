// Standalone entry point for the OTP-email-delivery monitor — runs OUTSIDE
// of the main server.js process, same reasoning as scripts/runScreenshots.js
// (shared cPanel Node.js hosting has restrictions that make this cleaner to
// run via GitHub Actions on a schedule instead — see
// .github/workflows/otp-check.yml).
//
// Runs across EVERY registered site, not just one hardcoded store — this is
// meant to scale to however many client sites get added later, the same way
// screenshots/scans/pagespeed already do. For each site:
//   1. Derives Layer 1 (OTP plugin active?) + Layer 2 (SMTP configured?)
//      status from that site's most recent Snapshot — no new WordPress call
//      needed, this data is already collected on every daily scan.
//   2. If a site doesn't have the OTP plugin active (or SMTP isn't
//      configured), Layer 3 is skipped for THAT site only — other sites
//      keep being checked normally. There's no assumption that every site
//      even has this OTP feature.
//   3. Otherwise, triggers the plugin's own "send_otp" AJAX action directly
//      (POST {site.url}/wp-admin/admin-ajax.php, action=send_otp&email=...)
//      and verifies delivery via IMAP against the one shared test mailbox.
//      No per-site URL configuration needed in .env — every site's own
//      `url` field (already stored from registration) is reused, just with
//      "/wp-admin/admin-ajax.php" appended. Adding a 21st site tomorrow
//      requires zero changes here.
//   4. Persists one OtpCheck document per site.
//
// Usage: node scripts/runOtpCheck.js
// Required env vars: MONGO_URI, OTP_TEST_EMAIL, OTP_TEST_EMAIL_PASSWORD,
// OTP_IMAP_HOST, and optionally OTP_IMAP_PORT.
import 'dotenv/config';
import mongoose from 'mongoose';
import Site from '../models/Site.js';
import Snapshot from '../models/Snapshot.js';
import OtpCheck from '../models/OtpCheck.js';
import { deriveOtpPrereqStatus } from '../services/otpLayers.js';
import { runOtpCheck } from '../services/otpCheck.js';

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('[runOtpCheck] MONGO_URI is not set — aborting.');
  process.exit(1);
}

function computeOverallStatus({ otpPluginActive, smtpPluginActive, smtpConfigured, layer3Attempted, popupAppeared, emailFound }) {
  if (otpPluginActive === null) return 'not_applicable'; // no snapshot yet — nothing to report either way
  if (otpPluginActive === false) return 'not_applicable'; // this site doesn't run the OTP plugin at all — not a failure
  if (smtpPluginActive === false) return 'fail_plugin_inactive';
  // `smtpConfigured` is `null` (not `false`) when the connector plugin
  // couldn't determine SMTP config at all (e.g. it detected the "WP Mail
  // SMTP" plugin from the active-plugins list but its own status check
  // came back empty/undetected — see vynox-connector.php's
  // vynox_get_wp_mail_smtp_status()). Either way Layer 3 can't safely run,
  // so treat "unknown" the same as "not configured" — falling through to
  // the generic 'error' status here used to hide a real, actionable finding
  // behind a vague label.
  if (smtpConfigured !== true) return 'fail_smtp_not_configured';
  if (!layer3Attempted) return 'error';
  if (!popupAppeared) return 'fail_checkout_trigger';
  if (!emailFound) return 'fail_email_not_received';
  return 'pass';
}

// Detects the specific Imunify360 "Access denied" message inside a Layer 3
// popupError string, so we can auto-flag Site.imunify360Status = 'blocked'.
// This is a per-server setting (see models/Site.js's comment on
// imunify360Status) — every site's hosting server has its own independent
// Imunify360/firewall, so this must be tracked per-site, not globally.
function isImunify360Block(errorMessage) {
  return typeof errorMessage === 'string' && /imunify360/i.test(errorMessage);
}

async function checkOneSite(site) {
  console.log(`\n[runOtpCheck] --- ${site.name || site.url} (${site._id}) ---`);

  const snap = await Snapshot.findOne({ site: site._id, ok: true }).sort({ fetchedAt: -1 }).lean();
  const prereq = deriveOtpPrereqStatus(snap?.data);
  console.log('[runOtpCheck] Layer 1/2 status:', JSON.stringify(prereq));

  const record = {
    site: site._id,
    checkedAt: new Date(),
    otpPluginActive: prereq.otpPluginActive,
    otpProvider: prereq.otpProvider,
    smtpPluginActive: prereq.smtpPluginActive,
    smtpConfigured: prereq.smtpConfigured,
    smtpMailer: prereq.smtpMailer,
    layer3Attempted: false,
    popupAppeared: null,
    popupError: null,
    emailFound: null,
    emailCheckError: null,
    emailReceivedAt: null,
    deliveryLatencyMs: null,
  };

  // 'vynox' provider's monitoring action authenticates with the site's own
  // connector API key (see services/otpCheck.js) instead of a checkout
  // nonce/cart — without it, Layer 3 can't even attempt the call, so treat
  // that the same as "prerequisites not met" rather than trying and getting
  // a confusing auth-failure error. In practice Site.apiKey is always set
  // (required at registration — see models/Site.js), but this stays
  // defensive rather than assuming that.
  const readyForLayer3 = prereq.readyForLayer3 && (prereq.otpProvider !== 'vynox' || !!site.apiKey);

  if (prereq.otpPluginActive === null) {
    console.log('[runOtpCheck] no snapshot data yet for this site — skipping until the next daily scan runs.');
  } else if (prereq.otpPluginActive === false) {
    console.log('[runOtpCheck] OTP plugin not active on this site — not applicable, skipping.');
  } else if (!readyForLayer3) {
    console.log('[runOtpCheck] prerequisites not met — skipping Layer 3 (AJAX + IMAP).');
  } else {
    console.log(`[runOtpCheck] prerequisites OK — running Layer 3 via '${prereq.otpProvider}' provider (AJAX trigger + IMAP)...`);
    record.layer3Attempted = true;
    try {
      const ajaxUrl = `${String(site.url).replace(/\/$/, '')}/wp-admin/admin-ajax.php`;
      const l3 = await runOtpCheck({ ajaxUrl, provider: prereq.otpProvider, apiKey: site.apiKey });
      record.popupAppeared = l3.popupAppeared;
      record.popupError = l3.popupError;
      record.emailFound = l3.emailFound;
      record.emailCheckError = l3.emailCheckError;
      record.emailReceivedAt = l3.emailReceivedAt;
      if (l3.triggeredAt && l3.emailReceivedAt) {
        record.deliveryLatencyMs = new Date(l3.emailReceivedAt).getTime() - new Date(l3.triggeredAt).getTime();
      }
      console.log('[runOtpCheck] Layer 3 result:', JSON.stringify({
        popupAppeared: l3.popupAppeared,
        popupError: l3.popupError,
        emailFound: l3.emailFound,
        emailCheckError: l3.emailCheckError,
        emailReceivedAt: l3.emailReceivedAt,
        otpCode: l3.otpCode,
      }));
    } catch (e) {
      console.error('[runOtpCheck] Layer 3 threw unexpectedly:', e.message);
      record.popupError = e.message;
    }
  }

  record.overallStatus = computeOverallStatus(record);
  console.log(`[runOtpCheck] overallStatus: ${record.overallStatus}`);

  await OtpCheck.create(record);

  // Auto-flag Site.imunify360Status = 'blocked' whenever this specific
  // failure shows up, so the dashboard can surface "this site's server
  // needs the X-Vynox-Bot allowlist rule" without the user having to dig
  // through workflow logs — see models/Site.js's comment on
  // imunify360Status for the full reasoning (this is a manual/tracked
  // status, not something we can fix remotely, since every hosting
  // server's Imunify360 is independent and usually has no client-facing
  // API). We only ever set it to 'blocked' automatically — moving it to
  // 'allowlisted' is always a manual user action (PUT
  // /:id/imunify360-status), since we can't verify the fix ourselves
  // until the next check happens to succeed.
  if (isImunify360Block(record.popupError) && site.imunify360Status !== 'blocked') {
    await Site.findByIdAndUpdate(site._id, {
      $set: { imunify360Status: 'blocked', imunify360CheckedAt: new Date() },
    }).catch((e) => console.error('[runOtpCheck] failed to update imunify360Status:', e.message));
    console.log('[runOtpCheck] detected Imunify360 block — marked Site.imunify360Status = "blocked"');
  }

  return record.overallStatus;
}

async function main() {
  console.log('[runOtpCheck] connecting to MongoDB...');
  await mongoose.connect(MONGO_URI);
  console.log('[runOtpCheck] connected.');

  const sites = await Site.find().lean();
  if (!sites.length) {
    console.log('[runOtpCheck] no sites registered yet — nothing to check.');
    await mongoose.disconnect();
    process.exit(0);
    return;
  }
  console.log(`[runOtpCheck] checking ${sites.length} site(s)...`);

  let anyFailed = false;
  for (const site of sites) {
    try {
      const status = await checkOneSite(site);
      if (status !== 'pass' && status !== 'not_applicable') anyFailed = true;
    } catch (e) {
      console.error(`[runOtpCheck] site ${site._id} (${site.url}) failed unexpectedly:`, e.message);
      anyFailed = true;
    }
  }

  await mongoose.disconnect();

  // Exit 1 if ANY site had a real OTP-delivery failure, so GitHub Actions
  // shows a red X worth investigating. Sites where the OTP plugin simply
  // isn't installed ('not_applicable') don't count as failures.
  process.exit(anyFailed ? 1 : 0);
}

main().catch(async (e) => {
  console.error('[runOtpCheck] fatal error:', e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
