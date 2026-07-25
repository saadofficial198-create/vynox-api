import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

// Regex for "Your One-Time Password (OTP) for verifying the order is:
// 312847" — extracted for logging/debugging only, never acted upon.
const OTP_CODE_RE = /is:\s*(\d{6})/i;
const SUBJECT_RE = /otp/i; // matches "Your OTP for Checkout" and "OTP" generally

const POLL_INTERVAL_MS = 10_000;
const POLL_TOTAL_MS = 120_000; // ~2 minutes total, matching the spec
const CLOCK_SKEW_BUFFER_MS = 30_000;
const SEARCH_WINDOW_MS = 10 * 60 * 1000; // only look at the last 10 minutes of mail

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls an IMAP inbox for the OTP email sent after `triggeredAt`. Retries a
 * few times (email delivery isn't instant) before giving up.
 *
 * @param {Date} triggeredAt - timestamp the checkout "Place order" click happened
 * @returns {Promise<{
 *   emailFound: boolean,
 *   emailCheckError: string|null,
 *   emailReceivedAt: Date|null,
 *   otpCode: string|null,
 * }>}
 */
export async function checkForOtpEmail(triggeredAt) {
  const host = process.env.OTP_IMAP_HOST;
  const port = Number(process.env.OTP_IMAP_PORT || 993);
  const user = process.env.OTP_TEST_EMAIL;
  const pass = process.env.OTP_TEST_EMAIL_PASSWORD;

  if (!host || !user || !pass) {
    return {
      emailFound: false,
      emailCheckError: 'IMAP not configured — set OTP_IMAP_HOST, OTP_TEST_EMAIL, OTP_TEST_EMAIL_PASSWORD in .env',
      emailReceivedAt: null,
      otpCode: null,
    };
  }

  const since = new Date((triggeredAt?.getTime?.() || Date.now()) - CLOCK_SKEW_BUFFER_MS - SEARCH_WINDOW_MS);
  const deadline = Date.now() + POLL_TOTAL_MS;

  let client;
  try {
    client = new ImapFlow({
      host,
      port,
      secure: port === 993,
      auth: { user, pass },
      logger: false,
    });
    await client.connect();

    while (true) {
      const found = await searchOnce(client, since, triggeredAt);
      if (found.emailFound || Date.now() >= deadline) {
        return found;
      }
      await sleep(POLL_INTERVAL_MS);
    }
  } catch (e) {
    return {
      emailFound: false,
      emailCheckError: e.message,
      emailReceivedAt: null,
      otpCode: null,
    };
  } finally {
    await client?.logout().catch(() => {});
  }
}

async function searchOnce(client, since, triggeredAt) {
  const lock = await client.getMailboxLock('INBOX');
  try {
    // SINCE is date-only granularity in IMAP SEARCH, so we over-fetch by date
    // then filter precisely by triggeredAt in JS below.
    const uids = await client.search({ since }, { uid: true });
    if (!uids || uids.length === 0) {
      return { emailFound: false, emailCheckError: null, emailReceivedAt: null, otpCode: null };
    }

    // Check newest first.
    const sorted = [...uids].sort((a, b) => b - a);
    for (const uid of sorted) {
      const msg = await client.fetchOne(uid, { envelope: true, source: true }, { uid: true });
      if (!msg) continue;

      const subject = msg.envelope?.subject || '';
      if (!SUBJECT_RE.test(subject)) continue;

      const receivedAt = msg.envelope?.date ? new Date(msg.envelope.date) : null;
      const triggerBuffered = new Date((triggeredAt?.getTime?.() || 0) - CLOCK_SKEW_BUFFER_MS);
      if (receivedAt && receivedAt < triggerBuffered) continue; // too old — not from this run

      let otpCode = null;
      try {
        const parsed = await simpleParser(msg.source);
        const body = parsed.text || parsed.html || '';
        const match = OTP_CODE_RE.exec(body);
        if (match) otpCode = match[1];
      } catch {
        // parsing failure shouldn't fail the whole check — we already know the email exists
      }

      return { emailFound: true, emailCheckError: null, emailReceivedAt: receivedAt, otpCode };
    }

    return { emailFound: false, emailCheckError: null, emailReceivedAt: null, otpCode: null };
  } finally {
    lock.release();
  }
}
