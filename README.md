# 🔍 WebsiteWatch — Website Change Detector

A self-hosted, full-stack tool that monitors public web pages and instantly alerts you to meaningful content changes — while ignoring noise like timestamps, counters, ads, and session tokens.
The link for the website is:- https://washday-other-resend.ngrok-free.dev
---

## ✨ Features

| Feature | Details |
|---|---|
| **Headless rendering** | Puppeteer renders JavaScript-heavy pages |
| **Per-site check interval** | 15 min → 24 h, fully configurable per site |
| **Sequential job queue** | Retries (3×), exponential back-off, no concurrent browser overload |
| **Noise filtering** | Strips timestamps, counters, ads, random tokens before hashing |
| **Sensitivity threshold** | Min characters changed before triggering an alert |
| **Watch / Ignore selectors** | Scope monitoring to specific CSS regions, exclude noise elements |
| **Visual Selector Proxy** | Interactive click-to-pick CSS selector inspector bypassing CSP (`/api/proxy`) |
| **Text diff** | Coloured `[+]` / `[-]` line diffs via `diffLines` |
| **Screenshot diff** | Pixel-level diff images via Jimp + interactive Before/After wipe comparison slider |
| **CAPTCHA / block detection** | Automatically flags blocked sites as `BLOCKED` |
| **Multi-channel alerts** | Email (Gmail), Telegram Bot, Discord, Slack, and Generic Webhooks |
| **Instant Alert Testing** | In-app 1-click test notifications for all alert channels |
| **Alert deduplication** | 30-minute cooldown between repeat alerts |
| **Daily digest** | Morning summary email/Telegram/Discord/Webhook at 8 AM |
| **Pause / Resume** | Suspend monitoring for any site without deleting it |
| **Site Settings Editor** | Inline editing of intervals, selectors, alerts, and keywords without re-adding |
| **Version timeline** | Up to 50 history entries per site with screenshots |
| **Diff viewer modal** | Side-by-side text, screenshot wipe comparison slider, and pixel diff |
| **Export / Import** | Full JSON backup and restore + CSV spreadsheet exports for sites & history |
| **Dashboard search** | Real-time filter by site name or URL |
| **🤖 AI One-Line Summaries** | Automatic 1-sentence synopsis of what changed (Gemini / NLP) |
| **🎯 Keyword-Only Alerts** | Alert only when specific keywords/terms appear in the diff |
| **📈 Number Tracking & Charts** | Interactive Chart.js trend graph of numeric/price values |
| **📡 Per-Page & Global RSS** | Standard RSS 2.0 XML feeds (`/api/sites/:id/rss`, `/api/rss`) |
| **🧩 Browser Extension** | Chrome / Edge companion extension for 1-click tab monitoring |

---

## 🚀 Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

```env
# Gmail App Password (https://myaccount.google.com/apppasswords)
EMAIL_USER=your-email@gmail.com
EMAIL_PASS=your-app-password

# Server port (default 3000)
PORT=3000
```

> **Note:** Email alerts are optional. Telegram and Discord credentials are configured per-site in the dashboard.

### 3. Run

```bash
# Production
npm start

# Development (auto-restarts on file change)
npm run dev
```

Open **http://localhost:3000** in your browser.

---

## 🖥️ Dashboard

### Adding a Site

1. Click **+ Add Site**
2. Fill in the URL, name, and check interval
3. (Optional) Add email / Telegram / Discord alert credentials
4. (Optional) Use **Watch Selectors** to monitor specific page regions
5. (Optional) Use **Ignore Selectors** to exclude noisy areas (e.g. `.ads`, `#cookie-banner`)
6. Click **🚀 Start Monitoring** — an immediate check is queued

### Dashboard Actions

| Button | Action |
|---|---|
| ⟳ Check | Immediately queue a manual check |
| ⏸ Pause | Suspend scheduled monitoring (check button disabled) |
| ▶ Resume | Resume monitoring + queue an immediate check |
| ▼ History | Expand version timeline for the site |
| 🗑 | Permanently remove the site |

### Export / Import

- **⬇ Export** — downloads a full JSON backup of all sites + history
- **⬆ Import** — upload a backup JSON to restore sites (skips duplicates)

---

## 🔔 Alert Setup

### Gmail (Email)

1. Enable 2-Step Verification on your Google account
2. Go to [App Passwords](https://myaccount.google.com/apppasswords)
3. Generate a password for "Mail" → copy it
4. Set `EMAIL_USER` and `EMAIL_PASS` in `.env`

### Telegram

1. Message `@BotFather` → `/newbot` → copy the token
2. Get your Chat ID from `@userinfobot` or the Telegram API
3. Enter both in the **Alert Integrations** section when adding a site

### Discord

1. Go to your server's channel settings → **Integrations** → **Webhooks** → **New Webhook**
2. Copy the webhook URL
3. Paste it in the **Alert Integrations** section when adding a site

---

## 📁 Project Structure

```
website-change-detector/
├── server.js          # Express server, Puppeteer scraper, scheduler, APIs
├── public/
│   └── index.html     # Single-page dashboard (vanilla JS + CSS + Chart.js)
├── extension/         # Chrome / Edge Browser Extension (Manifest V3)
│   ├── manifest.json  # Extension manifest
│   ├── popup.html     # Extension popup interface
│   ├── popup.js       # Auto-detect tab & submit to API
│   └── README.md      # Installation instructions
├── snapshots/         # Screenshot files (auto-created)
├── sites.json         # Persisted site data (auto-created)
├── .env               # Your secrets (not committed)
├── .env.example       # Template
└── package.json
```

---

## 🛠️ API Reference

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/track` | Register or update a site (supports keywords & selectors) |
| `GET` | `/api/sites` | List all sites |
| `GET` | `/api/sites/:id` | Get a single site |
| `DELETE` | `/api/sites/:id` | Remove a site |
| `POST` | `/api/sites/:id/check` | Manually trigger a check |
| `POST` | `/api/sites/:id/pause` | Toggle pause/resume |
| `GET` | `/api/sites/:id/history/:vid` | Get a history entry |
| `POST` | `/api/sites/:id/compare` | Compare two versions |
| `PATCH` | `/api/sites/:id/selectors` | Update watch/ignore selectors |
| `GET` | `/api/sites/:id/metrics` | Retrieve numeric / price tracking history for charts |
| `GET` | `/api/sites/:id/rss` | RSS 2.0 XML feed for this site |
| `GET` | `/api/rss` | Aggregated RSS 2.0 XML feed across all sites |
| `GET` | `/api/proxy` | Server proxy with injected interactive visual selector inspector |
| `POST` | `/api/test-alert` | Test notifications for Email, Telegram, Discord, or Webhooks |
| `GET` | `/api/export` | Download full JSON backup |
| `GET` | `/api/export/csv` | Download CSV spreadsheet of all monitored sites |
| `GET` | `/api/sites/:id/export/csv` | Download CSV spreadsheet of an individual site's history |
| `POST` | `/api/import` | Import sites from backup |

---

## ⚙️ Configuration Reference

### Site Object (POST `/api/track`)

```json
{
  "url":             "https://example.com",
  "name":            "My Site",
  "intervalMs":      3600000,
  "sensitivity":     20,
  "watchSelectors":  [".main-content"],
  "ignoreSelectors": [".ads", "#cookie-banner"],
  "email":           "you@gmail.com",
  "telegramToken":   "123:ABC...",
  "telegramChatId":  "-100123456",
  "discordWebhook":  "https://discord.com/api/webhooks/..."
}
```

| Field | Default | Description |
|---|---|---|
| `intervalMs` | `3600000` (1h) | Minimum 900000 (15 min) |
| `sensitivity` | `20` | Min characters added to trigger alert |
| `watchSelectors` | `[]` | Empty = monitor full page |
| `ignoreSelectors` | `[]` | Elements removed before scraping |

---

## 📋 Status Codes

| Status | Meaning |
|---|---|
| `PENDING` | Site registered, first check not yet complete |
| `OK` | Last check succeeded |
| `ERROR` | All retry attempts failed |
| `BLOCKED` | CAPTCHA or Cloudflare block detected |
| `PAUSED` | Monitoring suspended by user |

---

## 🔒 Security Notes

- URLs with embedded credentials (`user:pass@host`) are rejected
- No credentials are stored in the site data file — only `.env` holds secrets
- The snapshot directory is served statically; don't expose your server publicly without auth

---

## 📄 License

MIT
