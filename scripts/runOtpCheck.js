// Standalone entry point for the OTP-email-delivery monitor — runs OUTSIDE
// of the main server.js process, same reasoning as scripts/runScreenshots.js:
// shared cPanel Node.js hosting can't run Playwright/Chromium, so this runs
// on a schedule via GitHub Actions instead — see
// .github/workflows/otp-check.yml.
//
// What it does:
//   1. Connects to the same MongoDB Atlas database the cPanel backend uses.
//   2. Finds the BoloCart Site doc and its most recent Snapshot.
//   3. Derives Layer 1 (plugin active?) + Layer 2 (SMTP configured?) status
//      from that snapshot — no new WordPress call needed.
//   4. If prerequisites aren't met, skips the browser/IMAP step entirely.
//   5. Otherwise runs the full Playwright + IMAP Layer 3 check.
//   6. Persists everything as an OtpCheck document.
//   7. Exits 0 on pass, 1 on any real failure (so GitHub Actions shows red).
//
// Usage: node scripts/runOtpCheck.js
// Required env vars: MONGO_URI, OTP_TEST_EMAIL, OTP_TEST_EMAIL_PASSWORD,
// OTP_IMAP_HOST, and optionally OTP_IMAP_PORT, BOLOCART_SHOP_URL,
// BOLOCART_CHECKOUT_URL, OTP_TEST_CITY.
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
  if (otpPluginActive === false || smtpPluginActive === false) return 'fail_plugin_inactive';
  if (smtpConfigured === false) return 'fail_smtp_not_configured';
  if (!layer3Attempted) return 'error'; // prereqs looked fine (or unknown) but we still couldn't run Layer 3
  if (!popupAppeared) return 'fail_checkout_trigger';
  if (!emailFound) return 'fail_email_not_received';
  return 'pass';
}

async function main() {
  console.log('[runOtpCheck] connecting to MongoDB...');
  await mongoose.connect(MONGO_URI);
  console.log('[runOtpCheck] connected.');

  const site = await Site.findOne({ url: { $regex: /bolocart\.com/i } }).lean();
  if (!site) {
    console.error('[runOtpCheck] No site found matching "bolocart.com" in the Site collection — aborting.');
    await mongoose.disconnect();
    process.exit(1);
    return;
  }
  console.log(`[runOtpCheck] found site: ${site.name || site.url} (${site._id})`);

  const snap = await Snapshot.findOne({ site: site._id, ok: true }).sort({ fetchedAt: -1 }).lean();
  const prereq = deriveOtpPrereqStatus(snap?.data);
  console.log('[runOtpCheck] Layer 1/2 status:', JSON.stringify(prereq));

  const record = {
    site: site._id,
    checkedAt: new Date(),
    otpPluginActive: prereq.otpPluginActive,
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

  if (!prereq.readyForLayer3) {
    console.log('[runOtpCheck] prerequisites not met — skipping Layer 3 (browser/IMAP).');
  } else {
    console.log('[runOtpCheck] prerequisites OK — running Layer 3 (Playwright + IMAP)...');
    record.layer3Attempted = true;
    try {
      const l3 = await runOtpCheck();
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

  await mongoose.disconnect();

  // Exit 0 when the check passed OR correctly skipped Layer 3 with no
  // prerequisite issue (shouldn't really happen — readyForLayer3 false always
  // implies a prereq problem — but guards against an 'error' status from an
  // unexpected code path). Exit 1 for anything that represents a real failure.
  const passing = record.overallStatus === 'pass';
  process.exit(passing ? 0 : 1);
}

main().catch(async (e) => {
  console.error('[runOtpCheck] fatal error:', e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
