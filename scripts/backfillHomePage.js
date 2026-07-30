// One-time migration: makes Home ("/") a permanent monitored page on every
// EXISTING site already saved in the database — not just new ones going
// forward (that part is handled by routes/sites.js's POST / and /register,
// and enforced again server-side in PUT /:id/monitored-pages).
//
// Run this from your own machine (where MONGO_URI in .env already points at
// the real Atlas database):
//
//   cd vynox-api
//   node scripts/backfillHomePage.js
//
// What it does, per site:
//   - If monitoredPages already has a "/" entry: leave it exactly as-is
//     (this script never removes/changes an existing Home entry).
//   - If monitoredPages has other pages but NO "/" entry: adds Home,
//     enabled, matchStatus 'ok' — keeps everything else untouched.
//   - If monitoredPages is empty (site was never configured,
//     pagesConfigured: false): adds Home AND flips pagesConfigured to
//     true, so screenshot/PageSpeed capture starts on Home from the next
//     scheduled run without anyone needing to open Settings first.
//
// Safe to run more than once — sites that already have Home are skipped
// and reported separately, nothing is double-added.

import 'dotenv/config';
import mongoose from 'mongoose';
import Site from '../models/Site.js';

const uri = process.env.MONGO_URI;
if (!uri) {
  console.error('MONGO_URI not set in .env — aborting.');
  process.exit(1);
}

async function main() {
  await mongoose.connect(uri);
  console.log('Connected to:', mongoose.connection.db.databaseName);

  const sites = await Site.find();
  console.log(`Found ${sites.length} site(s) total.`);

  let alreadyHadHome = 0;
  let addedHomeToExisting = 0;
  let addedHomeAndActivated = 0;

  for (const site of sites) {
    const pages = Array.isArray(site.monitoredPages) ? site.monitoredPages : [];
    const hasHome = pages.some((p) => p.path === '/');

    if (hasHome) {
      alreadyHadHome++;
      continue;
    }

    const homeEntry = { label: 'Home', path: '/', enabled: true, matchStatus: 'ok', lastMatchedAt: new Date(), lastMismatchAt: null };

    if (pages.length === 0) {
      // Never configured at all — seed Home and turn monitoring on.
      site.monitoredPages = [homeEntry];
      site.pagesConfigured = true;
      addedHomeAndActivated++;
    } else {
      // Had other pages configured, just missing Home — add it, keep the rest.
      site.monitoredPages = [homeEntry, ...pages];
      addedHomeToExisting++;
    }

    site.markModified('monitoredPages');
    await site.save();
    console.log(`  updated: ${site.name || site.url} (${site.url})`);
  }

  console.log('\n--- Summary ---');
  console.log(`Already had Home (untouched):        ${alreadyHadHome}`);
  console.log(`Had other pages, Home added:          ${addedHomeToExisting}`);
  console.log(`Had zero pages, Home added + activated: ${addedHomeAndActivated}`);
  console.log(`Total sites processed:                ${sites.length}`);

  await mongoose.disconnect();
  console.log('Done.');
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
