import Session from '../models/Session.js';

// Gates every browser-facing dashboard route behind the PIN/password login
// (see routes/auth.js). Expects `Authorization: Bearer <token>` — the token
// the frontend got back from POST /api/auth/login and keeps in
// sessionStorage (not a cookie — see that route's comment for why).
//
// Deliberately does NOT protect routes/scan.js's /run-all, /run-pagespeed
// (GitHub Actions' own X-Scan-Secret machine auth) or the OTP/screenshot
// capture scripts (they write to MongoDB directly, never over HTTP) — this
// only gates the endpoints an actual browser session calls.
export async function requireAuth(req, res, next) {
  const header = req.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

  if (!token) {
    return res.status(401).json({ ok: false, error: 'Not logged in' });
  }

  const session = await Session.findOne({ token }).lean();
  // No stale-but-present check needed beyond this — Session's TTL index
  // (see models/Session.js) means an expired session simply no longer
  // exists as a document by the time this query runs.
  if (!session) {
    return res.status(401).json({ ok: false, error: 'Session expired or invalid — please log in again' });
  }

  next();
}
