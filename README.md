# Vynox API

Backend for the Vynox Security Monitor dashboard. Talks to WordPress sites running the **Vynox Connector** plugin, stores everything in **MongoDB**.

## Setup

```bash
cd "D:\VYNOX SECURITY\vynox-api"
npm install
```

Make sure MongoDB is running locally (default `mongodb://127.0.0.1:27017`).

## Run

```bash
npm run dev    # auto-restart on file changes
npm start      # production
```

Server: http://localhost:4000

## Endpoints

| Method | URL | Purpose |
|---|---|---|
| GET    | `/api/health`             | health check + mongo status |
| POST   | `/api/sites/test`         | test a (url, apiKey) BEFORE saving |
| GET    | `/api/sites`              | list all sites |
| POST   | `/api/sites`              | add new site (tests connection first) |
| GET    | `/api/sites/:id`          | single site |
| DELETE | `/api/sites/:id`          | remove site + all snapshots |
| POST   | `/api/sites/:id/sync`     | pull full `/data` from site, save snapshot |
| GET    | `/api/sites/:id/latest`   | latest snapshot |

## Collections (Compass)

DB name: **vynox**

- `sites`     — registered sites (URL, API key, status, last check time)
- `snapshots` — full `/data` dumps over time (history)

## .env

```
PORT=4000
MONGO_URI=mongodb://127.0.0.1:27017/vynox
CORS_ORIGIN=http://localhost:5174
```

## Change Log

Is section mein har baar jab koi meaningful backend change hota hai, ek chhoti entry likhi jaati hai — taake future mein poora code dobara parhne ki zaroorat na pade, sirf yahan dekh kar pata chal jaye kis file mein kya badla aur kyun.

### 2026-07-29 — Screenshot capture: real load-detection (no more fixed delay)

**File changed:** `services/screenshot.js`

**Problem:** Daily screenshot workflow (`.github/workflows/screenshots.yml` → `scripts/runScreenshots.js` → `captureAllSites()`) kabhi kabhi capture kar raha tha: (1) "Load More" ka khaali/incomplete area, (2) popup/subscribe modal ke sath screenshot, (3) images jo abhi load hi nahi hui thin (lazy-load ki wajah se). Root cause: purana code `tab.goto(..., { timeout: 25000 })` ko hi "load complete" ka signal maan raha tha — ek fixed guess, actual detection nahi.

**Fix — 4 naye helper functions added, sab REAL polling-based detection use karte hain, koi fixed "wait N seconds phir screenshot" logic nahi:**

1. `autoScroll(tab)` — page ko top se bottom scroll karta hai (chhote steps mein) taake lazy-load images trigger hon. Kabhi bhi "Load More"/"Show more" jaisa koi button click nahi karta — sirf scroll se jo image apne aap load hoti hai wahi lega.
2. `waitForImagesLoaded(tab, timeoutMs)` — real DOM check (`img.complete && img.naturalWidth > 0`) se poll karta hai jab tak har visible image actually load na ho jaye. `timeoutMs` sirf ek safety ceiling hai (agar koi image kabhi load hi na ho), asal decision hamesha real state check se hota hai.
3. `waitForNoActiveSpinners(tab, timeoutMs)` — generic heuristic (class/id mein "spinner"/"loading"/"loader"/"skeleton", ya `role="progressbar"`/`aria-busy="true"`) se check karta hai koi loading indicator visible to nahi — site-specific selectors kahin bhi hardcode nahi kiye.
4. `dismissOverlays(tab)` — koi bhi site ka popup/cookie-bar/subscribe-modal ho, uska ID/class kabhi maloom nahi hota, is liye **behavior-based detection** use kiya: `position: fixed/sticky` + screen ka bara hissa cover karna (ya full-width bar + high z-index) = overlay. Close button generic patterns se dhoondte hain (aria-label, "×"/"close"/"dismiss" text, ya class name mein close/dismiss), na milay to force-hide kar dete hain (`display:none !important`) — taake overlay kabhi screenshot mein na aaye chahe koi bhi site ho.

**`waitForRealPageReady(tab)`** in sab ko combine karta hai: overlay dismiss → auto-scroll → overlay dismiss dobara (scroll-triggered popups ke liye) → images ka real wait → spinners ka real wait → ek aakhri overlay sweep → tab jaake screenshot.

**Timeouts ab sirf ceiling hain, guess nahi:** `NAV_TIMEOUT_MS` (60s, pehle 25s tha), `IMAGE_SETTLE_TIMEOUT_MS` (45s), `OVERLAY_SETTLE_TIMEOUT_MS` (8s) — sab env se override ho sakte hain. In sab ka kaam sirf worst-case cap hai (ek atka hua/dead site poori run ko na roke), asal "ready hai ya nahi" ka faisla hamesha live page state check se hota hai.

**Verify kaisay kiya gaya:** Is dev sandbox mein Chromium download network-blocked hai, is liye live-browser test nahi ho saka. `node --check` se syntax verify kiya, aur overlay-coverage math + close-text matching ko standalone Node script se (bina browser ke) unit-test kiya — dono pass. **Pehla asal GitHub Actions run hi is logic ka real-world test hoga** — agar koi site abhi bhi galat/khaali screenshot de to `SCREENSHOT_NAV_TIMEOUT_MS` / `SCREENSHOT_IMAGE_SETTLE_TIMEOUT_MS` env vars badha kar dekhein, aur agar koi specific overlay phir bhi na hatay to uska structure (screenshot + HTML) share karein taake heuristic tighten ki ja sake.

### 2026-07-29 — PageSpeed: longer slow-server retry window + Health Status shows 0 on failure

**Problem 1:** Manual/daily PageSpeed (Lighthouse) checks kabhi kabhi is error ke sath fail ho jate thay: `FAILED_DOCUMENT_REQUEST ... net::ERR_TIMED_OUT` — matlab target site ka apna server itna slow/overloaded tha ke Lighthouse page load hi nahi kar saka, saari 5 attempts ke bawajood. Ye code ka bug nahi tha (comment mein already likha tha), lekin total retry window sirf ~3 minute (fixed 45s x 4 retries) tha — agar server 3 minute se zyada busy raha to sab attempts fail ho jatay.

**Fix 1 — `services/pagespeed.js`:** `slowServerDelayForAttempt(attempt)` add kiya — ab slow-server error par delay har attempt ke sath barhta hai (45s → 90s → 135s → 180s) instead of hamesha flat 45s. Attempts ki tadaad wahi 5 rakhi (Google API quota zyada consume nahi karna tha), sirf delays ko "grow" kiya. Total worst-case slow-server wait ab ~7.5 minute hai (pehle ~3 minute) — same number of API calls ke sath server ko double se zyada recovery time milta hai. Normal (non-slow-server) errors abhi bhi flat 20s delay use karte hain, unpe asar nahi.

**Problem 2:** Jab mobile ya desktop PageSpeed health check fail ho jaye (upar wala scenario), dashboard ke "Health Status" column (Dashboard/Sites/Scans, sab `ScoreRing` component use karte hain) mein sirf khaali "—" dikhta tha — ye "abhi check hi nahi hua" aur "check hua lekin fail ho gaya" mein farq nahi karta tha.

**Fix 2 — naya shared file `vynox-react/src/perfScore.js` (`resolveHomePerfScore`):** Health Status column ab is order mein score resolve karta hai: (1) 'desktop' score agar available ho, (2) na ho to 'mobile' score fallback, (3) dono strategies fail/missing ho **lekin dono attempt ho chuki hon** to `0` dikhata hai (khaali "—" ki jagah — red ring ke sath ek clear "failing" signal), (4) agar site kabhi check hi nahi hui (dono strategies ke liye koi record hi nahi) to abhi bhi "—" dikhega, taake naye site par foran alarming 0 na aaye. Ye logic `Dashboard.jsx`, `Sites.jsx`, aur `Scans.jsx` teenon mein same helper se use kiya — pehle teenon jagah duplicate/hardcoded 'desktop'-only fetch tha.

**Files changed:** `vynox-api/services/pagespeed.js`, `vynox-api/routes/pagespeed.js` (sirf comment update, worst-case time estimate), `vynox-react/src/perfScore.js` (naya file), `vynox-react/src/pages/Dashboard.jsx`, `vynox-react/src/pages/Sites.jsx`, `vynox-react/src/pages/Scans.jsx`.

**Verify kaisay kiya gaya:** `node --check` se dono backend files (`services/pagespeed.js`, `routes/pagespeed.js`) syntax-verify ki. React side is sandbox mein bundler (Vite/Rollup/ESLint) install/run nahi ho saka (Windows-installed `node_modules` ke platform-specific binaries is Linux sandbox mein nahi chal rahe — `@rollup/rollup-linux-x64-gnu` missing, esbuild bhi missing) — is liye manual diff review kiya: teenon `.jsx` files mein import path, function name, aur call signature match kar ke confirm kiya. **Suggestion: agli baar jab aap apne computer par `npm run dev` ya `npm run build` chalayein, ek baar console mein koi error na hone ka confirm kar lein** — is particular change ke liye ye hi asal verification hai jo yahan nahi ho saki.

### 2026-07-29 — Screenshot capture: detect + flag security-challenge pages (Cloudflare/Imunify360 "please wait, verifying...")

**Problem:** Ek cPanel/Imunify360 site par daily screenshot job ne "Please wait while your request is being verified..." wala verification/challenge splash page capture kar liya — real page ki jagah. Ye is liye hua kyunke us site ke hosting server ka firewall (Imunify360, ya kabhi Cloudflare jaisa koi aur) Playwright ke Chromium ko bot samajh kar ek verification challenge dikha raha tha, aur humara code isay "load complete" samajh kar seedha screenshot le raha tha — koi detection nahi tha ke ye asal page hai ya security-challenge splash.

**Fix — `services/screenshot.js`:**

1. `looksLikeSecurityChallenge(tab)` — naya generic detector, kisi ek provider (Cloudflare/Imunify360/hCaptcha/etc.) ke liye hardcode nahi kiya, balke page ke visible text mein common phrases dhoondta hai jo taqreeban har challenge-page mein hoti hain: "checking your browser", "just a moment", "please wait while your request is being verified", "verifying you are human", "ray id:" (Cloudflare), "access denied by imunify360", waghera. Isse **koi bhi** aisi challenge page (chahe naya provider ho jo abhi tak dekha na ho) generic pattern se pakri ja sakti hai.
2. `waitForChallengeToClear(tab, timeoutMs)` — agar challenge detect ho, foran fail nahi karte — real polling se wait karte hain (kyunke bohot se JS-based challenges khud hi kuch second mein clear ho jate hain ek real browser ke liye, aur Playwright ka Chromium exactly wahi hai). `SCREENSHOT_CHALLENGE_CLEAR_TIMEOUT_MS` (default 20s) tak wait karte hain.
3. Agar challenge is waqt ke andar clear na ho (matlab genuine standing block hai), to us page ki image bilkul upload/save NAHI ki jati — taake galat/misleading screenshot dashboard mein kabhi na aaye. Iski jagah `Screenshot` document `ok: false, challengeBlocked: true` ke sath save hota hai, aur purani (last-known-good) screenshot reference ke liye waisay hi rehti hai.

**Warning/Alert:** `models/Site.js` mein naya field `screenshotChallengeBlocked` add kiya (`imunify360Status` jaisa pattern) — agar site ke kisi bhi monitored page ne is run mein challenge-block dekha, ye `true` set ho jata hai, aur `routes/alerts.js`'s `deriveAlerts()` isay dashboard mein ek Alert ki tarah dikhata hai: **"Screenshots Blocked by Security Challenge"**. Ye alert khud clear ho jata hai jaise hi agli baar koi capture normal tarah se succeed ho jaye — manually "resolve" karne ki zaroorat nahi (Imunify360-OTP wale alert se alag, jahan user ko khud confirm karna parta hai, kyunke ye screenshot challenge kabhi temporary bhi ho sakta hai).

**Ye general-purpose hai, sirf Imunify360-specific nahi:** Jaisa poocha gaya tha — "kabhi koi aur aisi cheez ho to bhi resolve/warn kare" — is detector ka design hi generic hai (text-pattern based), is liye Cloudflare, hCaptcha, ya kal koi naya bot-protection service bhi isi mechanism se pakra/warn kiya jayega, bina naya code likhe. Agar future mein koi naya challenge-pattern miss ho jaye (jo abhi list mein nahi hai), `looksLikeSecurityChallenge()`'s `PATTERNS` array mein naya phrase add kar dena kaafi hoga.

**Files changed:** `vynox-api/services/screenshot.js`, `vynox-api/models/Screenshot.js` (naya `challengeBlocked` field), `vynox-api/models/Site.js` (naya `screenshotChallengeBlocked` field), `vynox-api/routes/alerts.js` (naya alert case).

**Verify kaisay kiya gaya:** `node --check` se `services/screenshot.js`, `models/Screenshot.js`, `models/Site.js`, `routes/alerts.js` — sab syntax-valid. Live-browser test yahan bhi nahi ho saka (Chromium download network-blocked). **Pehla real GitHub Actions run confirm karega ke ye kaam kar raha hai** — agar Health Status/Alerts mein "Screenshots Blocked by Security Challenge" dikhe to samajh lein ye naya detector kaam kar raha hai; agar phir bhi koi aisi challenge-page screenshot ban jaye jo naye detector ne na pakri ho, uska text/screenshot share kar dein taake `PATTERNS` list mein add kiya ja sake.
