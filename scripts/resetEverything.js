// Full reset script: deletes EVERYTHING — all registered sites, all scan
// history, all screenshots, all pagespeed results, all alerts. Use this when
// you want to start completely fresh: remove every site from the dashboard,
// wipe all data, then re-register all sites at once (e.g. by reactivating/
// re-registering the Vynox Connector plugin on each WordPress site) so they
// all get checked together from a clean slate.
//
// Run this from your own machine (where MONGO_URI in .env already points
// at the real Atlas database):
//
//   cd vynox-api
//   node scripts/resetEverything.js
//
// What it does:
//   - Deletes ALL Site documents (site registrations — plugin will need to
//     re-register each site, which happens automatically via the plugin's
//     daily retry cron, or immediately if you deactivate+reactivate the
//     plugin on each site)
//   - Deletes ALL Snapshot documents (scan history)
//   - Deletes ALL Screenshot documents (screenshot records — the actual
//     image files on cPanel FTP storage are NOT touched by this script,
//     only the MongoDB records; delete those separately via FTP/File
//     Manager if you also want the image files gone)
//   - Deletes ALL PageSpeedResult documents
//   - Deletes ALL Alert documents (the High/Medium/Low alert history)
//
// Safe to delete this file afterwards.

import 'dotenv/config';
import mongoose from 'mongoose';

import Site from '../models/Site.js';
import Snapshot from '../models/Snapshot.js';
import Screenshot from '../models/Screenshot.js';
import PageSpeedResult from '../models/PageSpeedResult.js';
import Alert from '../models/Alert.js';

const uri = process.env.MONGO_URI;
if (!uri) {
  console.error('MONGO_URI not set in .env — aborting.');
  process.exit(1);
}

async function main() {
  await mongoose.connect(uri);
  console.log('Connected to:', mongoose.connection.db.databaseName);

  const siteRes = await Site.deleteMany({});
  console.log(`Deleted ${siteRes.deletedCount} sites (registrations removed)`);

  const snapRes = await Snapshot.deleteMany({});
  console.log(`Deleted ${snapRes.deletedCount} snapshots (scan history)`);

  const shotRes = await Screenshot.deleteMany({});
  console.log(`Deleted ${shotRes.deletedCount} screenshot records (DB records only — FTP image files untouched)`);

  const psRes = await PageSpeedResult.deleteMany({});
  console.log(`Deleted ${psRes.deletedCount} pagespeed results`);

  const alertRes = await Alert.deleteMany({});
  console.log(`Deleted ${alertRes.deletedCount} alerts`);

  await mongoose.disconnect();
  console.log('Done. Dashboard is now completely empty — re-register sites to start fresh.');
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
