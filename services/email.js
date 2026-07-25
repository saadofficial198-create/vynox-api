import nodemailer from 'nodemailer';

// Builds a transporter lazily from env vars — if SMTP isn't configured yet
// (fresh install, credentials not filled in), we just log and no-op instead
// of throwing, so the rest of the app (scans, alerts) keeps working fine
// without email wired up.
let transporter = null;
let warnedMissingConfig = false;

function getTransporter() {
  if (transporter) return transporter;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD } = process.env;
  if (!SMTP_HOST) return null;

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT || '587', 10),
    secure: parseInt(SMTP_PORT || '587', 10) === 465, // true for 465, false for 587/25 (STARTTLS)
    auth: (SMTP_USER && SMTP_PASSWORD) ? { user: SMTP_USER, pass: SMTP_PASSWORD } : undefined,
  });
  return transporter;
}

// No persisted "who gets emailed" mechanism exists anywhere in the codebase
// today (checked frontend Settings/Notifications pages — the "Email
// Notifications" bits there are static hardcoded UI, not backed by a DB
// field or API). So recipients come from this static .env list for now.
function getRecipients() {
  return String(process.env.ALERT_EMAIL_RECIPIENTS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

// sendAlertEmail({ subject, html, text }) — logs + no-ops if SMTP isn't
// configured or there are no recipients, so callers never need to check
// first or wrap this in try/catch for "not configured yet".
export async function sendAlertEmail({ subject, html, text }) {
  const t = getTransporter();
  const recipients = getRecipients();

  if (!t) {
    if (!warnedMissingConfig) {
      console.warn('[email] SMTP_HOST not configured — skipping email:', subject);
      warnedMissingConfig = true;
    }
    return { sent: false, reason: 'smtp-not-configured' };
  }
  if (!recipients.length) {
    console.warn('[email] No ALERT_EMAIL_RECIPIENTS configured — skipping email:', subject);
    return { sent: false, reason: 'no-recipients' };
  }

  try {
    await t.sendMail({
      from: process.env.SMTP_FROM || SMTP_USER_FALLBACK(),
      to: recipients.join(','),
      subject,
      text: text || undefined,
      html: html || undefined,
    });
    return { sent: true };
  } catch (e) {
    console.error('[email] send failed:', e.message);
    return { sent: false, reason: e.message };
  }
}

function SMTP_USER_FALLBACK() {
  return process.env.SMTP_USER || 'alerts@vynox.local';
}
