import mongoose from 'mongoose';

// A logged-in browser session for the dashboard's PIN/password gate (see
// routes/auth.js, middleware/auth.js). The token itself lives in the
// frontend's sessionStorage (not a cookie, not localStorage) so it's wiped
// automatically when the browser/tab closes — this document is the
// server-side half of that: even a stolen/copied token stops working once
// this record expires or is deleted (logout).
const SessionSchema = new mongoose.Schema({
  token:     { type: String, required: true, unique: true, index: true },
  createdAt: { type: Date, default: Date.now },
  // Defense in depth beyond "browser close" — a session that's still open
  // in a browser that never closes shouldn't stay valid forever either.
  expiresAt: { type: Date, required: true, index: true },
  ip:        { type: String, default: null },
  userAgent: { type: String, default: null },
});

// TTL index — MongoDB automatically deletes a session document once
// expiresAt has passed, so expired tokens don't just get REJECTED, they
// stop existing at all.
SessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('Session', SessionSchema);
