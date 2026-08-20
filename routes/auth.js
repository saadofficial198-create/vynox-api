import express from 'express';
import crypto from 'crypto';
import Session from '../models/Session.js';
import LoginAttempt from '../models/LoginAttempt.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = express.Router();

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h server-side ceiling — see models/Session.js
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_FAILURES = 5;

// Derived from the LoginAttempt log itself (not an in-memory counter) so
// the lockout survives this process restarting — cPanel Node hosting
// restarts fairly often (every deploy/env change, per this app's other
// comments on the same theme), and an in-memory-only counter would quietly
// reset a brute-force attempt's "5 failures" back to zero on every restart.
async function recentFailureCount(ip) {
  const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);
  return LoginAttempt.countDocuments({ ip, success: false, attemptedAt: { $gte: since } });
}

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  // Lengths almost always differ for a wrong guess — hash both to a fixed
  // length first so that alone doesn't leak anything via early-return timing.
  const hashA = crypto.createHash('sha256').update(bufA).digest();
  const hashB = crypto.createHash('sha256').update(bufB).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

// POST /api/auth/login — body: { password }. See middleware/requireAuth.js
// for how the returned token then gates every other dashboard route.
router.post('/login', async (req, res) => {
  const expected = process.env.DASHBOARD_PASSWORD;
  if (!expected) {
    return res.status(500).json({ ok: false, error: 'Server DASHBOARD_PASSWORD not configured' });
  }

  const ip = req.ip || 'unknown';
  const userAgent = req.get('User-Agent') || null;
  const password = String(req.body?.password || '');

  const failures = await recentFailureCount(ip);
  if (failures >= RATE_LIMIT_MAX_FAILURES) {
    // Deliberately does NOT log this as another attempt — it never even
    // reached the password check, so recording it wouldn't reflect a real
    // guess and would just extend the lockout window on top of itself.
    return res.status(429).json({
      ok: false,
      error: `Too many failed attempts. Try again in ${Math.ceil(RATE_LIMIT_WINDOW_MS / 60000)} minutes.`,
    });
  }

  const success = timingSafeStringEqual(password, expected);
  await LoginAttempt.create({ ip, userAgent, success });

  if (!success) {
    return res.status(401).json({ ok: false, error: 'Incorrect password' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  await Session.create({
    token,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    ip,
    userAgent,
  });

  res.json({ ok: true, token, expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString() });
});

// POST /api/auth/logout — body: {} (token comes from the Authorization
// header, same as every other protected route). Explicit logout deletes
// the session immediately rather than waiting for its TTL to expire, so a
// shared/public computer can't be logged out of just by closing the tab
// (sessionStorage would already do that) — this also invalidates the token
// itself server-side, in case it was copied somewhere.
router.post('/logout', requireAuth, async (req, res) => {
  const header = req.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (token) await Session.deleteOne({ token });
  res.json({ ok: true });
});

// GET /api/auth/logins — recent login attempts (success + failure), for
// the Settings page's "Recent Login Attempts" table. Protected — you need
// to already be logged in to see who else has been trying.
router.get('/logins', requireAuth, async (_req, res) => {
  const attempts = await LoginAttempt.find().sort({ attemptedAt: -1 }).limit(100).lean();
  res.json({ ok: true, attempts });
});

export default router;
