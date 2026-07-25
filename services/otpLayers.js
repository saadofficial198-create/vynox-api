// Pure helper — derives the Layer 1 (plugin active/inactive) and Layer 2
// (WP Mail SMTP configured) prerequisite status for the OTP-email-delivery
// monitor from a Snapshot's raw payload. No I/O, no browser, no network —
// just reads what the daily scan already pulled from
// /wp-json/vynox/v1/data (data.plugins.plugins + data.mail_smtp).
//
// Matching is case-insensitive and substring-tolerant since plugin display
// names can vary slightly between installs/versions.
const OTP_PLUGIN_RE  = /woocommerce email otp verification/i;
const SMTP_PLUGIN_RE = /wp mail smtp/i;

/**
 * @param {object|null|undefined} snapshotData - snap.data from the most recent Snapshot doc
 * @returns {{
 *   otpPluginActive: boolean|null,
 *   smtpPluginActive: boolean|null,
 *   smtpConfigured: boolean|null,
 *   smtpMailer: string|null,
 *   readyForLayer3: boolean,
 * }}
 */
export function deriveOtpPrereqStatus(snapshotData) {
  // No snapshot at all yet (brand-new site, first scan hasn't run) — we
  // genuinely don't know anything, so everything stays null rather than
  // being reported as "plugin not active" (which would be misleading).
  if (!snapshotData) {
    return { otpPluginActive: null, smtpPluginActive: null, smtpConfigured: null, smtpMailer: null, readyForLayer3: false };
  }

  const plugins = Array.isArray(snapshotData?.plugins?.plugins) ? snapshotData.plugins.plugins : [];

  const otpPlugin  = plugins.find(p => OTP_PLUGIN_RE.test(p?.name || ''));
  const smtpPlugin = plugins.find(p => SMTP_PLUGIN_RE.test(p?.name || ''));

  // false (not null) when the plugin isn't in the list at all — "not
  // installed" and "installed but deactivated" both mean "OTP flow can't
  // possibly work right now", and the caller (scripts/runOtpCheck.js) needs
  // to tell "this site simply doesn't have the OTP feature" (not_applicable)
  // apart from "no plugin data yet" (only possible via a missing snapshot,
  // handled separately below by returning null when snapshotData itself is
  // absent).
  const otpPluginActive  = otpPlugin  ? otpPlugin.status === 'active'  : false;
  const smtpPluginActive = smtpPlugin ? smtpPlugin.status === 'active' : false;

  const mailSmtp = snapshotData?.mail_smtp || null;
  const smtpConfigured = typeof mailSmtp?.configured === 'boolean' ? mailSmtp.configured : null;
  const smtpMailer = mailSmtp?.mailer ?? null;

  const readyForLayer3 = otpPluginActive === true && smtpPluginActive === true && smtpConfigured === true;

  return { otpPluginActive, smtpPluginActive, smtpConfigured, smtpMailer, readyForLayer3 };
}
