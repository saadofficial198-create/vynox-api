import mongoose from 'mongoose';

// One row per dashboard login attempt (success AND failure) — see
// routes/auth.js. This is the "who tried to log in, from where" audit log
// the user asked for: viewable via GET /api/auth/logins (Settings page's
// "Recent Login Attempts" table).
const LoginAttemptSchema = new mongoose.Schema({
  ip:          { type: String, default: 'unknown' },
  userAgent:   { type: String, default: null },
  success:     { type: Boolean, required: true },
  attemptedAt: { type: Date, default: Date.now, index: true },
});

// Auto-expire after 90 days — this is an audit trail, not something that
// needs to grow forever, and an unbounded collection of repeated
// brute-force noise would otherwise never get cleaned up.
LoginAttemptSchema.index({ attemptedAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export default mongoose.model('LoginAttempt', LoginAttemptSchema);
