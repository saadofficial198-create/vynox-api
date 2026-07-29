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
