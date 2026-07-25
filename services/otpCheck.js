import { chromium } from 'playwright';
import { checkForOtpEmail } from './imapCheck.js';

// Layer 3 of the OTP-email-delivery monitor: actually drives the BoloCart
// checkout flow end-to-end (add to cart -> checkout -> fill form -> place
// order) and confirms the OTP popup appears, then checks the test inbox via
// IMAP to confirm the email actually arrived. See services/imapCheck.js for
// the IMAP half and services/otpLayers.js for the cheap Layer 1/2 checks
// that gate whether this even runs.
//
// IMPORTANT: this deliberately stops the moment #otp-popup appears. It never
// fills in the OTP code or clicks "Verify OTP" — confirmed via live manual
// testing that no WooCommerce order is created unless the OTP is verified,
// so no cleanup logic is needed here.

const SHOP_URL     = process.env.BOLOCART_SHOP_URL || 'https://bolocart.com/shop/';
const CHECKOUT_URL = process.env.BOLOCART_CHECKOUT_URL || 'https://bolocart.com/checkout/';
const TEST_CITY    = process.env.OTP_TEST_CITY || 'Karachi';

const POPUP_TIMEOUT_MS = 20_000;
const NAV_TIMEOUT_MS = 45_000;

function billingFixtures() {
  const email = process.env.OTP_TEST_EMAIL;
  if (!email) {
    throw new Error('OTP_TEST_EMAIL is not set — required as the checkout billing email and IMAP mailbox to poll');
  }
  return {
    firstName: 'Vynox',
    lastName: 'Test',
    address1: 'Test Street 123',
    city: TEST_CITY,
    postcode: '75000',
    phone: '03001234567',
    email,
  };
}

/** Adds the first available product to the cart from the shop page. Falls back to a retry if the click is flaky. */
async function addFirstProductToCart(page) {
  await page.goto(SHOP_URL, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT_MS });

  const addToCartBtn = page.locator('.add_to_cart_button').first();
  await addToCartBtn.waitFor({ state: 'visible', timeout: NAV_TIMEOUT_MS });

  // One retry: WooCommerce AJAX add-to-cart buttons occasionally need a
  // second click if the first fires before the button's JS handler is bound.
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await addToCartBtn.click({ timeout: 10_000 });
      // WooCommerce adds an "added" class / shows a "View cart" link on success.
      await page.waitForTimeout(2000);
      return;
    } catch (e) {
      lastErr = e;
      await page.waitForTimeout(1000);
    }
  }
  throw lastErr || new Error('add_to_cart_button click failed');
}

async function fillCheckoutForm(page, fixtures) {
  await page.goto(CHECKOUT_URL, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT_MS });

  await page.locator('#billing_first_name').fill(fixtures.firstName);
  await page.locator('#billing_last_name').fill(fixtures.lastName);
  // billing_country / billing_state left untouched — already default to
  // Pakistan / Sindh per the confirmed live DOM inspection.
  await page.locator('#billing_address_1').fill(fixtures.address1);
  await page.locator('#billing_city').fill(fixtures.city);
  await page.locator('#billing_postcode').fill(fixtures.postcode);
  await page.locator('#billing_phone').fill(fixtures.phone);
  await page.locator('#billing_email').fill(fixtures.email);

  const terms = page.locator('#terms');
  if (await terms.count()) {
    await terms.check({ force: true });
  }

  // Payment method: "Cash on delivery" is already selected by default —
  // intentionally not touched here.
}

/**
 * Runs the full Layer 3 checkout-trigger + IMAP verification.
 * @returns {Promise<{
 *   triggeredAt: Date,
 *   popupAppeared: boolean,
 *   popupError: string|null,
 *   emailFound: boolean|null,
 *   emailCheckError: string|null,
 *   emailReceivedAt: Date|null,
 *   otpCode: string|null,
 * }>}
 */
export async function runOtpCheck() {
  const fixtures = billingFixtures(); // throws early with a clear error if OTP_TEST_EMAIL is missing

  let browser;
  let result = {
    triggeredAt: null,
    popupAppeared: false,
    popupError: null,
    emailFound: null,
    emailCheckError: null,
    emailReceivedAt: null,
    otpCode: null,
  };

  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await ctx.newPage();

    try {
      await addFirstProductToCart(page);
    } catch (e) {
      // Fallback: navigate straight to checkout anyway — some carts persist
      // via session/cookies from an earlier redirect, or the site allows
      // checkout to proceed to an empty-cart notice we can still detect via
      // the popup timeout below. Better to attempt checkout than to abort
      // entirely on a flaky add-to-cart click.
      console.warn('[otpCheck] addFirstProductToCart failed, attempting checkout anyway:', e.message);
    }

    await fillCheckoutForm(page, fixtures);

    const placeOrderBtn = page.locator('#place_order');
    await placeOrderBtn.waitFor({ state: 'visible', timeout: NAV_TIMEOUT_MS });

    result.triggeredAt = new Date();
    await placeOrderBtn.click();

    try {
      await page.waitForSelector('#otp-popup', { state: 'visible', timeout: POPUP_TIMEOUT_MS });
      result.popupAppeared = true;
    } catch (e) {
      result.popupAppeared = false;
      result.popupError = `#otp-popup did not appear within ${POPUP_TIMEOUT_MS}ms: ${e.message}`;
    }
  } catch (e) {
    result.popupAppeared = false;
    result.popupError = e.message;
  } finally {
    await browser?.close().catch(() => {});
  }

  if (!result.popupAppeared) {
    // Layer 3 "checkout_trigger_failed" — don't bother polling IMAP.
    return result;
  }

  const imapResult = await checkForOtpEmail(result.triggeredAt);
  result.emailFound = imapResult.emailFound;
  result.emailCheckError = imapResult.emailCheckError;
  result.emailReceivedAt = imapResult.emailReceivedAt;
  result.otpCode = imapResult.otpCode;

  return result;
}
