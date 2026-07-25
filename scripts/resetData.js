// One-time cleanup script: wipes fake/test scan history and screenshots,
// but KEEPS registered sites (name/url/apiKey/status) so the WordPress
// plugin connections don't break.
//
// Run this from your own machine (where MONGO_URI in .env already points
// at the real Atlas database):
//
//   cd vynox-api
//   node scripts/resetData.js
//
// What it does:
//   - Deletes ALL documents in Snapshot, Screenshot, PageSpeedResult collections
//   - Clears Site.latest (the old fake security score summary) back to null
//   - Leaves Site.name/url/apiKey/status/tags/notes/monitoredPages untouched
//
// Safe to delete this file afterwards.

import 'dotenv/config';
import mongoose from 'mongoose';

import Site from '../models/Site.js';
import Snapshot from '../models/Snapshot.js';
import Screenshot from '../models/Screenshot.js';
import PageSpeedResult from '../models/PageSpeedResult.js';

const uri = process.env.MONGO_URI;
if (!uri) {
  console.error('MONGO_URI not set in .env — aborting.');
  process.exit(1);
}

async function main() {
  await mongoose.connect(uri);
  console.log('Connected to:', mongoose.connection.db.databaseName);

  const snapRes = await Snapshot.deleteMany({});
  console.log(`Deleted ${snapRes.deletedCount} snapshots (scan history)`);

  const shotRes = await Screenshot.deleteMany({});
  console.log(`Deleted ${shotRes.deletedCount} screenshot records`);

  const psRes = await PageSpeedResult.deleteMany({});
  console.log(`Deleted ${psRes.deletedCount} pagespeed results`);

  const siteRes = await Site.updateMany({}, { $set: { latest: null } });
  console.log(`Cleared 'latest' (old fake score) on ${siteRes.modifiedCount} sites`);

  const remainingSites = await Site.countDocuments();
  console.log(`Sites kept as-is: ${remainingSites} (registrations untouched)`);

  await mongoose.disconnect();
  console.log('Done.');
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
