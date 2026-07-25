import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import axios from 'axios';
import https from 'https';
import sitesRouter from './routes/sites.js';
import alertsRouter from './routes/alerts.js';
import updatesRouter from './routes/updates.js';
import scansRouter from './routes/scans.js';
import backupsRouter from './routes/backups.js';
import pagespeedRouter from './routes/pagespeed.js';
import screenshotsRouter from './routes/screenshots.js';
import scanRouter from './routes/scan.js';
import Site from './models/Site.js';
import { checkAllSitesPageSpeed } from './services/pagespeed.js';
// NOTE: screenshot capture (Playwright/Chromium) does NOT run on this cPanel
// backend anymore — shared cPanel Node.js hosting can't run a headless
// browser (no system libs, no permission to install Chromium). Captures now
// run on a schedule via GitHub Actions instead — see .github/workflows/
// screenshots.yml and scripts/runScreenshots.js. This server only reads
// screenshot records that GitHub Actions already wrote to MongoDB (routes/
// screenshots.js GET endpoints), it doesn't trigger new captures itself.

// Ignore SSL cert errors when pinging (self-signed certs, mixed http/https, etc.)
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// Track consecutive ping failures per site — only mark offline after 2 in a row
const pingFails = new Map();

const PORT        = process.env.PORT || 4000;
const MONGO_URI   = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/vynox';
const CORS_ORIGIN = (process.env.CORS_ORIGIN || 'http://localhost:5174').split(',').map(s => s.trim());

const app = express();
app.use(cors({ origin: CORS_ORIGIN, credentials: false }));
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'vynox-api',
    mongo: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    time: new Date().toISOString(),
  });
});

app.use('/api/sites', sitesRouter);
app.use('/api/alerts', alertsRouter);
app.use('/api/updates', updatesRouter);
app.use('/api/scans', scansRouter);
app.use('/api/backups', backupsRouter);
app.use('/api/pagespeed', pagespeedRouter);
app.use('/api/screenshots', screenshotsRouter);
app.use('/api/scan', scanRouter);

app.use((err, _req, res, _next) => {
  console.error('[ERR]', err);
  res.status(500).json({ ok: false, error: err.message });
});

async function pingSite(url) {
  // Use GET with stream so we don't download the full page body.
  // httpsAgent ignores SSL errors (self-signed certs, http→https redirects, etc.)
  const r = await axios.get(url, {
    timeout: 15000,
    validateStatus: () => true,
    maxRedirects: 5,
    httpsAgent,
    responseType: 'stream',
  });
  r.data?.destroy?.(); // immediately discard body — we only need the status code
  return r.status;
}

async function pingMonitor() {
  try {
    const sites = await Site.find({ status: { $in: ['online', 'offline', 'unknown'] } }).lean();
    for (const site of sites) {
      if (!site.url) continue;
      const key = String(site._id);
      try {
        const status = await pingSite(site.url);
        const isUp = status < 500; // 2xx, 3xx, 4xx all count as "up" — only 5xx = server error

        pingFails.set(key, 0); // reset consecutive fail count on any successful response

        if (isUp && site.status === 'offline') {
          await Site.findByIdAndUpdate(site._id, { status: 'online', lastCheckedAt: new Date() });
          console.log(`[monitor] RECOVERED: ${site.url} (${status})`);
        } else if (!isUp && site.status === 'online') {
          // 5xx from the site itself — mark offline immediately (genuine server error)
          await Site.findByIdAndUpdate(site._id, { status: 'offline', lastCheckedAt: new Date() });
          console.log(`[monitor] DOWN (5xx): ${site.url} (${status})`);
        } else {
          await Site.findByIdAndUpdate(site._id, { lastCheckedAt: new Date() });
        }
      } catch (e) {
        // Network-level error (timeout, DNS fail, SSL, connection refused).
        // Require 2 consecutive failures before marking offline to avoid false alarms
        // from transient cPanel network hiccups.
        const fails = (pingFails.get(key) || 0) + 1;
        pingFails.set(key, fails);
        console.log(`[monitor] FAIL #${fails}: ${site.url} — ${e.message}`);

        if (fails >= 2 && site.status === 'online') {
          await Site.findByIdAndUpdate(site._id, { status: 'offline', lastCheckedAt: new Date() });
          console.log(`[monitor] DOWN after ${fails} fails: ${site.url}`);
        } else {
          await Site.findByIdAndUpdate(site._id, { lastCheckedAt: new Date() });
        }
      }
    }
  } catch (e) {
    console.error('[monitor] error:', e.message);
  }
}

// Guards so an overrunning PageSpeed/screenshot run can't overlap with itself
// if a site is slow to respond and the next interval tick fires anyway.
let pageSpeedRunning = false;
async function pageSpeedJob() {
  if (pageSpeedRunning) return console.log('[pagespeed] previous run still in progress, skipping tick');
  pageSpeedRunning = true;
  try {
    const summary = await checkAllSitesPageSpeed();
    console.log('[pagespeed] run complete:', JSON.stringify(summary));
  } catch (e) {
    console.error('[pagespeed] run failed:', e.message);
  } finally {
    pageSpeedRunning = false;
  }
}

mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log('[mongo] connected:', MONGO_URI);
    app.listen(PORT, () => {
      console.log(`[vynox-api] listening on http://localhost:${PORT}`);
      setInterval(pingMonitor, 5 * 60 * 1000);
      setTimeout(pingMonitor, 10000);

      // PageSpeed: every 6 hours (Google's free quota is 25k/day — way more
      // than we need, but there's no reason to hammer it more often than this).
      setInterval(pageSpeedJob, 6 * 60 * 60 * 1000);
      setTimeout(pageSpeedJob, 20000);

      // Screenshots are captured by GitHub Actions on a schedule now, not by
      // this server — see the NOTE near the top of this file.
    });
  })
  .catch((e) => {
    console.error('[mongo] connection failed:', e.message);
    process.exit(1);
  });
