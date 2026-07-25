import mongoose from 'mongoose';

// One document per OTP-email-delivery monitor run (see services/otpCheck.js,
// services/otpLayers.js, scripts/runOtpCheck.js). Captures the full layered
// result so a failure is diagnosable — WHY it failed, not just that it did.
const OtpCheckSchema = new mongoose.Schema(
  {
    site:       { type: mongoose.Schema.Types.ObjectId, ref: 'Site', required: true, index: true },
    checkedAt:  { type: Date, default: Date.now, index: true },

    // Layer 1 — plugin active/inactive, read straight from the most recent
    // Snapshot's data.plugins.plugins list. null = plugin not found at all.
    otpPluginActive:  { type: Boolean, default: null },
    smtpPluginActive: { type: Boolean, default: null },

    // Layer 2 — WP Mail SMTP actually configured, from data.mail_smtp.
    smtpConfigured: { type: Boolean, default: null },
    smtpMailer:     { type: String, default: null },

    // Layer 3 — checkout automation + IMAP inbox check. layer3Attempted is
    // false whenever Layer 1/2 already failed (no point spinning up a browser).
    layer3Attempted: { type: Boolean, default: false },
    popupAppeared:   { type: Boolean, default: null },
    popupError:      { type: String, default: null },
    emailFound:      { type: Boolean, default: null },
    emailCheckError: { type: String, default: null },
    emailReceivedAt: { type: Date, default: null },
    deliveryLatencyMs: { type: Number, default: null }, // emailReceivedAt - triggeredAt, when both present

    overallStatus: {
      type: String,
      enum: ['pass', 'fail_plugin_inactive', 'fail_smtp_not_configured', 'fail_checkout_trigger', 'fail_email_not_received', 'error'],
      required: true,
    },
  },
  { timestamps: true }
);

OtpCheckSchema.index({ site: 1, checkedAt: -1 });

export default mongoose.model('OtpCheck', OtpCheckSchema);
