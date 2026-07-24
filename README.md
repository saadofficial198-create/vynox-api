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
