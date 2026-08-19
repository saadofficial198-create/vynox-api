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

// Our own checkout plugin — ships as either the older "vynox-checkout" or
// the newer "vynox-commerce" folder, but BOTH register under this exact
// same WP plugin display name on purpose (see vynox-commerce.php's own
// header comment: "Both ship ... the same 'Vynox Commerce' display name" —
// they're mutually exclusive on a given site, so there's never a need to
// tell them apart). Both send OTP through the identical `vynox_request_otp`
// / `vynox_otp_monitor_check` AJAX actions, so one regex covers either.
const VYNOX_COMMERCE_PLUGIN_RE = /^vynox commerce$/i;

/**
 * @param {object|null|undefined} snapshotData - snap.data from the most recent Snapshot doc
 * @returns {{
 *   otpPluginActive: boolean|null,
 *   otpProvider: 'legacy'|'vynox'|null,
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
    return { otpPluginActive: null, otpProvider: null, smtpPluginActive: null, smtpConfigured: null, smtpMailer: null, readyForLayer3: false };
  }

  const plugins = Array.isArray(snapshotData?.plugins?.plugins) ? snapshotData.plugins.plugins : [];

  const legacyPlugin = plugins.find(p => OTP_PLUGIN_RE.test(p?.name || ''));
  const vynoxPlugin  = plugins.find(p => VYNOX_COMMERCE_PLUGIN_RE.test((p?.name || '').trim()));
  const smtpPlugin   = plugins.find(p => SMTP_PLUGIN_RE.test(p?.name || ''));

  // false (not null) when the plugin isn't in the list at all — "not
  // installed" and "installed but deactivated" both mean "OTP flow can't
  // possibly work right now", and the caller (scripts/runOtpCheck.js) needs
  // to tell "this site simply doesn't have the OTP feature" (not_applicable)
  // apart from "no plugin data yet" (only possible via a missing snapshot,
  // handled separately below by returning null when snapshotData itself is
  // absent).
  const legacyActive = legacyPlugin ? legacyPlugin.status === 'active' : false;
  const vynoxActive  = vynoxPlugin  ? vynoxPlugin.status  === 'active' : false;

  // Prefer 'legacy' if somehow both are ever active at once — shouldn't
  // happen (vynox-commerce.php's own header warns against running
  // vynox-checkout alongside it), but pick a deterministic winner rather
  // than silently depending on plugin-list ordering.
  const otpProvider     = legacyActive ? 'legacy' : vynoxActive ? 'vynox' : null;
  const otpPluginActive = legacyActive || vynoxActive;

  const smtpPluginActive = smtpPlugin ? smtpPlugin.status === 'active' : false;

  const mailSmtp = snapshotData?.mail_smtp || null;
  const smtpConfigured = typeof mailSmtp?.configured === 'boolean' ? mailSmtp.configured : null;
  const smtpMailer = mailSmtp?.mailer ?? null;

  const readyForLayer3 = otpPluginActive === true && smtpPluginActive === true && smtpConfigured === true;

  return { otpPluginActive, otpProvider, smtpPluginActive, smtpConfigured, smtpMailer, readyForLayer3 };
}
