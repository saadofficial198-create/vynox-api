// One-time cleanup script: deletes ALL uploaded screenshot files from the
// cPanel FTP storage (the SCREENSHOT_PUBLIC_BASE_URL / FTP_REMOTE_BASE folder),
// since the MongoDB Screenshot records referencing them were already wiped.
//
// Run this from your own machine (same .env used by the backend):
//
//   cd vynox-api
//   node scripts/resetScreenshots.js
//
// What it does:
//   - Connects to cPanel via FTP using FTP_HOST/FTP_USER/FTP_PASSWORD from .env
//   - Recursively deletes every file and subfolder under FTP_REMOTE_BASE
//   - Leaves the FTP_REMOTE_BASE folder itself in place (empty), ready for
//     the next automated screenshot run to repopulate it
//
// Safe to delete this file afterwards.

import 'dotenv/config';
import { Client } from 'basic-ftp';

const { FTP_HOST, FTP_PORT, FTP_USER, FTP_PASSWORD, FTP_REMOTE_BASE, FTP_SECURE } = process.env;

if (!FTP_HOST || !FTP_USER || !FTP_PASSWORD || !FTP_REMOTE_BASE) {
  console.error('FTP not configured — set FTP_HOST, FTP_USER, FTP_PASSWORD, FTP_REMOTE_BASE in .env');
  process.exit(1);
}

let secure = true;
if (FTP_SECURE === 'false') secure = false;
else if (FTP_SECURE === 'implicit') secure = 'implicit';

async function connect() {
  const client = new Client(20000);
  client.ftp.verbose = false;
  try {
    await client.access({
      host: FTP_HOST,
      port: Number(FTP_PORT) || 21,
      user: FTP_USER,
      password: FTP_PASSWORD,
      secure,
      secureOptions: { rejectUnauthorized: false },
    });
  } catch (e) {
    if (secure !== false) {
      await client.access({
        host: FTP_HOST,
        port: Number(FTP_PORT) || 21,
        user: FTP_USER,
        password: FTP_PASSWORD,
        secure: false,
      });
    } else {
      throw e;
    }
  }
  return client;
}

async function main() {
  const remoteBase = FTP_REMOTE_BASE.replace(/\/$/, '');
  const client = await connect();
  console.log('Connected to FTP:', FTP_HOST);
  console.log('Target folder:', remoteBase);

  try {
    // List what's there first, for a visible count.
    const list = await client.list(remoteBase);
    console.log(`Found ${list.length} top-level entries in ${remoteBase}`);

    // clearWorkingDir removes all files/subfolders inside the given dir,
    // but keeps the dir itself.
    await client.cd(remoteBase);
    await client.clearWorkingDir();

    console.log('All screenshot files deleted. Folder is now empty.');
  } finally {
    client.close();
  }
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
