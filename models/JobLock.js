import mongoose from 'mongoose';

// A tiny shared lock/lastRun tracker stored in MongoDB (not in-memory), so
// that scheduled jobs (PageSpeed, etc.) stay safe even across cPanel Node.js
// app restarts. In-memory guards like `let running = false` only protect
// against overlap WITHIN a single process — but this app has been restarted
// many times during development (after every code/env change), and if a
// restart doesn't cleanly kill the old process first (e.g. it's still
// mid-request, or cPanel's Node.js Selector leaves a zombie process behind),
// you can end up with two Node processes running simultaneously, each with
// its own setInterval(pageSpeedJob, 6h) — silently doubling (or worse,
// N-tupling) the number of Google PageSpeed API calls without any visible
// error. This actually happened: PageSpeed Insights showed ~2000 requests in
// 2 days for a single 4-page site, when the expected volume is a few hundred
// at most (4 pages x 4/day scheduled + occasional manual "Check Now" runs).
//
// One document per job `key` (e.g. "pagespeed"). `runningSince` is set when
// a run starts and cleared when it finishes; `lastRunAt` records the last
// completed run so a fresh process can decide whether it's actually time to
// run again instead of assuming a 6h timer starting from ITS OWN boot time.
const JobLockSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    runningSince: { type: Date, default: null },
    lastRunAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export default mongoose.model('JobLock', JobLockSchema);
