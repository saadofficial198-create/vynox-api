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
  const plugins = Array.isArray(snapshotData?.plugins?.plugins) ? snapshotData.plugins.plugins : [];

  const otpPlugin  = plugins.find(p => OTP_PLUGIN_RE.test(p?.name || ''));
  const smtpPlugin = plugins.find(p => SMTP_PLUGIN_RE.test(p?.name || ''));

  const otpPluginActive  = otpPlugin  ? otpPlugin.status === 'active'  : null;
  const smtpPluginActive = smtpPlugin ? smtpPlugin.status === 'active' : null;

  const mailSmtp = snapshotData?.mail_smtp || null;
  const smtpConfigured = typeof mailSmtp?.configured === 'boolean' ? mailSmtp.configured : null;
  const smtpMailer = mailSmtp?.mailer ?? null;

  const readyForLayer3 = otpPluginActive === true && smtpPluginActive === true && smtpConfigured === true;

  return { otpPluginActive, smtpPluginActive, smtpConfigured, smtpMailer, readyForLayer3 };
}
