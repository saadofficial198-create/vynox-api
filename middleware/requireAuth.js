import Session from '../models/Session.js';

export const SESSION_COOKIE_NAME = 'vynox_session';

// Minimal cookie-header parser — deliberately not the `cookie-parser`
// package, since reading one specific cookie is a five-line job and this
// codebase already prefers small local helpers over dependencies for
// things this size (see e.g. hostFromUrl() duplicated locally in several
// route files rather than pulling in a URL-parsing library).
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function getSessionToken(req) {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME] || null;
}

// Gates every browser-facing dashboard route behind the PIN/password login
// (see routes/auth.js). The session token travels as an HttpOnly cookie —
// NOT sessionStorage/localStorage/an Authorization header — specifically so
// it's shared across every tab/window of the same browser (confirmed live:
// sessionStorage is scoped per-TAB, so a second tab of the same browser
// kept asking to log in again even though the first tab was already
// authenticated) while still disappearing when the browser is fully closed
// (a cookie with no Max-Age/Expires is a "session cookie" — cleared when
// the browser application quits, not per-tab). HttpOnly also means
// JavaScript (and therefore any XSS on this page) can't read the token at
// all, which a sessionStorage-based token could be.
//
// Deliberately does NOT protect routes/scan.js's /run-all, /run-pagespeed
// (GitHub Actions' own X-Scan-Secret machine auth) or the OTP/screenshot
// capture scripts (they write to MongoDB directly, never over HTTP) — this
// only gates the endpoints an actual browser session calls.
export async function requireAuth(req, res, next) {
  const token = getSessionToken(req);

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
