// Standalone entry point for capturing screenshots OUTSIDE of the main
// server.js process. This is what GitHub Actions runs on a schedule — see
// .github/workflows/screenshots.yml — because shared cPanel Node.js hosting
// cannot run Playwright/Chromium (no system libraries, no permission to
// install browser binaries; see services/screenshot.js for details on why).
//
// GitHub's Ubuntu runners have no such restriction, so this script just:
//   1. connects to the same MongoDB Atlas database the cPanel backend uses
//   2. runs the exact same captureAllSites() logic
//   3. disconnects and exits
//
// Usage: node scripts/runScreenshots.js
// Required env vars: MONGO_URI, FTP_HOST, FTP_PORT, FTP_USER, FTP_PASSWORD,
// FTP_REMOTE_BASE, FTP_SECURE, SCREENSHOT_PUBLIC_BASE_URL, and optionally
// SCREENSHOT_DIFF_THRESHOLD_PCT / SCREENSHOT_JPEG_QUALITY.
import 'dotenv/config';
import mongoose from 'mongoose';
import { captureAllSites } from '../services/screenshot.js';

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('[runScreenshots] MONGO_URI is not set — aborting.');
  process.exit(1);
}

async function main() {
  console.log('[runScreenshots] connecting to MongoDB...');
  await mongoose.connect(MONGO_URI);
  console.log('[runScreenshots] connected. starting capture run...');

  const summary = await captureAllSites();
  console.log('[runScreenshots] run complete:', JSON.stringify(summary, null, 2));

  const anyFailed = summary.some(s => !s.ok);
  await mongoose.disconnect();

  // Non-zero exit on failure so the GitHub Actions run shows as failed
  // (makes it easy to notice via GitHub's own email/UI notifications).
  process.exit(anyFailed ? 1 : 0);
}

main().catch(async (e) => {
  console.error('[runScreenshots] fatal error:', e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
