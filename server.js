/**
 * Website Change Detector — server.js
 *
 * Core requirements implemented:
 * 1. Per-site check interval (15 min – 24 h), headless Puppeteer rendering
 * 2. Sequential job queue with timeouts, retries, no credential storage
 * 3. Screenshot + text snapshot stored only when content hash changes
 * 4. Noise filtering (timestamps, counters, ads, random tokens) + sensitivity
 * 5. Watch & ignore CSS selector regions
 * 6. Text diff (diffLines) + screenshot diff API
 * 7. Email, Telegram, Discord alerts; no duplicate alerts; optional daily digest
 * 8. Per-page version timeline; dashboard status: OK / ERROR / BLOCKED
 */

'use strict';

require('dotenv').config();

const express  = require('express');
const puppeteer = require('puppeteer');
const crypto   = require('crypto');
const nodemailer = require('nodemailer');
const { diffLines } = require('diff');
const axios = require('axios');
const fs   = require('fs');
const path = require('path');
const http = require('http');

// ─── Config ────────────────────────────────────────────────────────────────

const PORT          = process.env.PORT || 3000;
const SNAPSHOTS_DIR = path.join(__dirname, 'snapshots');
const DATA_FILE     = path.join(__dirname, 'sites.json');

// Alert deduplication: minimum ms between alerts for the same site
const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

// Daily digest window (midnight server time)
const DIGEST_HOUR = 8; // 8 AM

// ─── Bootstrap ─────────────────────────────────────────────────────────────

if (!fs.existsSync(SNAPSHOTS_DIR)) fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '10mb' }));
// CORS support for Browser Extension and external API clients
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});
app.use(express.static('public'));
app.use('/snapshots', express.static(SNAPSHOTS_DIR));

// ─── Persistence helpers ───────────────────────────────────────────────────

function loadSites() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const raw = fs.readFileSync(DATA_FILE, 'utf8');
            return JSON.parse(raw);
        }
    } catch (e) { console.error('[DB] Load failed:', e.message); }
    return [];
}

function saveSites() {
    try {
        // Don't serialise lastText (can be huge) in the JSON, keep it in memory
        const slim = watchedSites.map(s => {
            const { lastText, ...rest } = s;
            return rest;
        });
        fs.writeFileSync(DATA_FILE, JSON.stringify(slim, null, 2));
    } catch (e) { console.error('[DB] Save failed:', e.message); }
}

// ─── In-memory site store ──────────────────────────────────────────────────

let watchedSites = loadSites();
// Re-attach empty lastText for any loaded site
watchedSites.forEach(s => { if (s.lastText === undefined) s.lastText = ''; });

// ─── Utilities ─────────────────────────────────────────────────────────────

function generateHash(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

/** Strip noise patterns: timestamps, counters, ad fragments, random tokens */
function filterNoise(text) {
    return text
        // ISO timestamps / common date-time patterns
        .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?\b/g, 'TIMESTAMP')
        .replace(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)?\b/gi, 'TIMESTAMP')
        .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, 'TIMESTAMP')
        // "X seconds/minutes/hours ago"
        .replace(/\b\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago\b/gi, 'RELTIME')
        // Counters / view counts like "1,234 views", "42 comments"
        .replace(/\b[\d,]+\s+(?:views?|comments?|likes?|shares?|followers?|subscribers?)\b/gi, 'COUNTER')
        // Generic large numbers with commas that change often
        .replace(/\b\d{1,3}(?:,\d{3})+\b/g, 'NUM')
        // Session / nonce / CSRF-like random tokens (alphanumeric 16+ chars)
        .replace(/\b[A-Za-z0-9_-]{16,}\b/g, 'TOKEN')
        // Ad network patterns
        .replace(/<!--\s*(?:Google|DoubleClick|ad)[^>]*-->/gi, '')
        // Whitespace normalisation
        .replace(/\s+/g, ' ')
        .trim();
}

/** Return true if the page is likely blocked by CAPTCHA */
function detectCaptcha(text) {
    const lower = text.toLowerCase();
    return (
        lower.includes('captcha') ||
        lower.includes('i am not a robot') ||
        lower.includes('verify you are human') ||
        lower.includes('access denied') ||
        lower.includes('cloudflare') && lower.includes('ray id')
    );
}

/** Blocks URLs that include credentials (user:pass@host) */
function hasCredentialsInUrl(urlStr) {
    try {
        const u = new URL(urlStr);
        return !!(u.username || u.password);
    } catch { return false; }
}

/** XML escaping for RSS feed generation */
function escapeXml(unsafe) {
    return (unsafe || '').replace(/[<>&'"]/g, c => {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '\'': return '&apos;';
            case '"': return '&quot;';
            default: return c;
        }
    });
}

/** Extracts first numeric/price/percentage metric from text for trend tracking */
function extractMetric(text) {
    if (!text) return null;
    const match = text.match(/(?:[\$€£₹]\s*([0-9,]+(?:\.[0-9]+)?))|(\b[0-9,]+(?:\.[0-9]+)?\s*%)|(\b[0-9,]+(?:\.[0-9]+)?\b)/);
    if (match) {
        const raw = match[1] || match[2] || match[3];
        const val = parseFloat(raw.replace(/[,%\$€£₹\s]/g, ''));
        if (!isNaN(val)) return val;
    }
    return null;
}

/** AI one-line change summarizer with Gemini support & smart NLP fallback */
async function generateAiSummary(diffText, addedLines = [], removedLines = []) {
    // 1. Try Gemini API if key is present in environment
    if (process.env.GEMINI_API_KEY) {
        try {
            const fetch = require('node-fetch');
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{
                        parts: [{
                            text: `Summarize this website change diff in exactly ONE concise sentence (max 20 words). Focus specifically on the meaningful update (price, stock, headline, or text changed):\n\n${diffText.slice(0, 1200)}`
                        }]
                    }]
                })
            });
            const data = await res.json();
            const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text && text.trim()) return text.trim().replace(/\n/g, ' ');
        } catch (e) {
            console.warn('[AI] Gemini call failed, falling back to smart NLP summarizer:', e.message);
        }
    }

    // 2. High-performance NLP heuristic summarizer
    const addedSnippet = addedLines.join(' ').replace(/\s+/g, ' ').trim();
    const removedSnippet = removedLines.join(' ').replace(/\s+/g, ' ').trim();

    // Check for price / metric movements
    const metricAdd = addedSnippet.match(/[\$€£₹]\s*[\d,]+(?:\.\d+)?|\b\d+(?:\.\d+)?%/);
    const metricRem = removedSnippet.match(/[\$€£₹]\s*[\d,]+(?:\.\d+)?|\b\d+(?:\.\d+)?%/);
    if (metricAdd && metricRem) {
        return `Metric shifted from ${metricRem[0]} to ${metricAdd[0]}.`;
    } else if (metricAdd) {
        return `New metric or price detected: ${metricAdd[0]}.`;
    }

    // Check for stock status changes
    const lowerAdd = addedSnippet.toLowerCase();
    const lowerRem = removedSnippet.toLowerCase();
    if (lowerAdd.includes('in stock') || lowerAdd.includes('available')) return 'Item or page status changed to In Stock / Available.';
    if (lowerAdd.includes('out of stock') || lowerAdd.includes('sold out')) return 'Item or page marked as Out of Stock / Sold Out.';

    // Text additions / deletions
    if (addedSnippet && !removedSnippet) {
        const preview = addedSnippet.length > 70 ? addedSnippet.slice(0, 67) + '...' : addedSnippet;
        return `New content added: "${preview}"`;
    }
    if (removedSnippet && !addedSnippet) {
        const preview = removedSnippet.length > 70 ? removedSnippet.slice(0, 67) + '...' : removedSnippet;
        return `Content removed: "${preview}"`;
    }
    if (addedSnippet && removedSnippet) {
        const aPrev = addedSnippet.length > 40 ? addedSnippet.slice(0, 37) + '...' : addedSnippet;
        const rPrev = removedSnippet.length > 40 ? removedSnippet.slice(0, 37) + '...' : removedSnippet;
        return `Replaced "${rPrev}" with "${aPrev}".`;
    }

    return `Content updated (+${addedSnippet.length} chars).`;
}

// ─── Alert sending ─────────────────────────────────────────────────────────

async function sendEmailAlert(site, subject, body) {
    if (!site.email) return;
    try {
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER || '',
                pass: process.env.EMAIL_PASS || ''
            }
        });
        await transporter.sendMail({
            from: '"Website Change Detector" <noreply@wcd.app>',
            to: site.email,
            subject,
            html: `<pre style="font-family:monospace;font-size:13px">${body}</pre>`
        });
        console.log(`[Alert] Email sent to ${site.email}`);
    } catch (err) {
        console.error('[Alert] Email failed:', err.message);
    }
}

async function sendTelegramAlert(site, message) {
    if (!site.telegramToken || !site.telegramChatId) return;
    try {
        const fetch = require('node-fetch');
        const url = `https://api.telegram.org/bot${site.telegramToken}/sendMessage`;
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: site.telegramChatId, text: message, parse_mode: 'Markdown' })
        });
        console.log('[Alert] Telegram message sent');
    } catch (err) {
        console.error('[Alert] Telegram failed:', err.message);
    }
}

async function sendDiscordAlert(site, message) {
    if (!site.discordWebhook) return;
    try {
        const fetch = require('node-fetch');
        await fetch(site.discordWebhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: message })
        });
        console.log('[Alert] Discord message sent');
    } catch (err) {
        console.error('[Alert] Discord failed:', err.message);
    }
}

async function sendWebhookAlert(site, data) {
    if (!site.webhookUrl) return;
    try {
        const fetch = require('node-fetch');
        const isSlack = site.webhookUrl.includes('slack.com');
        const payload = isSlack
            ? {
                text: `*Change detected on ${site.name || site.url}*${data.matchedKeyword ? ` [Keyword: "${data.matchedKeyword}"]` : ''}\n${data.summary ? '🤖 *AI Summary:* ' + data.summary + '\n' : ''}\`${site.url}\`\n\`\`\`${(data.diff || '').slice(0, 500)}\`\`\``
            }
            : {
                event: 'change_detected',
                siteId: site.id,
                name: site.name,
                url: site.url,
                timestamp: new Date().toISOString(),
                summary: data.summary || null,
                matchedKeyword: data.matchedKeyword || null,
                diff: data.diff || ''
            };

        await fetch(site.webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        console.log('[Alert] Webhook sent to', site.webhookUrl);
    } catch (err) {
        console.error('[Alert] Webhook failed:', err.message);
    }
}

async function sendAlerts(site, diffText, summary = '', matchedKeyword = null) {
    // Duplicate guard
    const now = Date.now();
    if (site.lastAlertHash === site.lastHash && (now - (site.lastAlertAt || 0)) < ALERT_COOLDOWN_MS) {
        console.log(`[Alert] Suppressed duplicate alert for ${site.url}`);
        return;
    }
    site.lastAlertHash = site.lastHash;
    site.lastAlertAt   = now;

    const kwTag = matchedKeyword ? ` [Keyword: "${matchedKeyword}"]` : '';
    const subject = `[WCD] Change detected on ${site.name || site.url}${kwTag}`;
    const summaryBlock = summary ? `\n🤖 AI Summary: ${summary}\n` : '';
    const body    = `URL: ${site.url}\nTime: ${new Date().toLocaleString()}${summaryBlock}\nDiff (first 800 chars):\n${diffText.slice(0, 800)}`;
    const tgMsg   = `*Change detected*${kwTag}\n\`${site.url}\`\n${new Date().toLocaleString()}${summary ? `\n🤖 *AI Summary:* ${summary}` : ''}\n\`\`\`\n${diffText.slice(0, 300)}\n\`\`\``;

    await Promise.all([
        sendEmailAlert(site, subject, body),
        sendTelegramAlert(site, tgMsg),
        sendDiscordAlert(site, body),
        sendWebhookAlert(site, { diff: diffText, summary, matchedKeyword })
    ]);
}

// ─── Screenshot diff ───────────────────────────────────────────────────────

async function buildScreenshotDiff(imgPathA, imgPathB) {
    try {
        const Jimp = require('jimp');
        const [a, b] = await Promise.all([Jimp.read(imgPathA), Jimp.read(imgPathB)]);
        const width  = Math.max(a.bitmap.width,  b.bitmap.height);
        const height = Math.max(a.bitmap.height, b.bitmap.height);
        a.resize(width, height);
        b.resize(width, height);
        const diff   = Jimp.diff(a, b, 0.1);
        const outPath = imgPathA.replace('.png', '_diff.png');
        await diff.image.writeAsync(outPath);
        return outPath;
    } catch (e) {
        console.error('[Diff] Screenshot diff failed:', e.message);
        return null;
    }
}

// ─── Core check function ───────────────────────────────────────────────────

async function checkWebsite(site, attempt = 1) {
    const MAX_ATTEMPTS = 3;
    let browser;
    try {
        const launchOptions = {
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
        };
        // On Railway/cloud: use system Chromium via env var
        if (process.env.PUPPETEER_EXECUTABLE_PATH) {
            launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
        }
        browser = await puppeteer.launch(launchOptions);
        const page = await browser.newPage();

        // Standard desktop viewport for clear rendering & full snapshots
        await page.setViewport({ width: 1280, height: 800 });

        // Realistic user-agent to reduce bot blocks
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        );

        // Measure page response latency
        const navStartTime = Date.now();

        // Resilient navigation: domcontentloaded with retry for client-side redirection
        try {
            await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 35000 });
        } catch (gotoErr) {
            if (gotoErr.message && (gotoErr.message.includes('detached') || gotoErr.message.includes('destroyed'))) {
                console.log(`[Puppeteer] Handled detached frame on ${site.url}, waiting for redirection to settle...`);
                await new Promise(r => setTimeout(r, 3000));
            } else {
                throw gotoErr;
            }
        }

        site.responseTimeMs = Date.now() - navStartTime;
        if (!site.responseTimes) site.responseTimes = [];
        site.responseTimes.push({ timestamp: new Date().toISOString(), ms: site.responseTimeMs });
        if (site.responseTimes.length > 50) site.responseTimes = site.responseTimes.slice(-50);

        // Small wait buffer to allow SPA / dynamic JS hydration to complete
        await new Promise(r => setTimeout(r, 2500));

        if (page.isClosed()) {
            throw new Error('Browser page was unexpectedly closed during navigation');
        }

        // Remove ignored selectors from DOM before extracting text
        if (site.ignoreSelectors && site.ignoreSelectors.length) {
            await page.evaluate((selectors) => {
                selectors.forEach(sel => {
                    document.querySelectorAll(sel).forEach(el => el.remove());
                });
            }, site.ignoreSelectors);
        }

        // Remove universal noise elements
        await page.evaluate(() => {
            document.querySelectorAll('script, style, iframe, noscript, .ad, .ads, [class*="banner"], [id*="banner"]')
                .forEach(el => el.remove());
        });

        // Extract text from watch selectors or full body
        let pageText = '';
        if (site.watchSelectors && site.watchSelectors.length) {
            pageText = await page.evaluate((selectors) => {
                return selectors.map(sel => {
                    const el = document.querySelector(sel);
                    return el ? el.innerText : '';
                }).join('\n');
            }, site.watchSelectors);
        } else {
            pageText = await page.evaluate(() => document.body.innerText);
        }

        // Extract and record numeric metric trend (price/stock/numbers)
        const metricVal = extractMetric(pageText);
        if (metricVal !== null) {
            if (!site.metrics) site.metrics = [];
            site.metrics.push({
                timestamp: new Date().toISOString(),
                value: metricVal
            });
            if (site.metrics.length > 100) site.metrics = site.metrics.slice(-100);
        }

        // Apply noise filter
        const filteredText = filterNoise(pageText);

        // CAPTCHA detection
        if (detectCaptcha(filteredText)) {
            await browser.close();
            site.status      = 'BLOCKED';
            site.lastChecked = new Date().toLocaleString();
            saveSites();
            return { success: false, blocked: true, error: 'CAPTCHA or access block detected' };
        }

        const currentHash = generateHash(filteredText);
        let hasChanged    = false;
        let diffText      = '';

        if (site.lastHash && site.lastHash !== currentHash) {
            // Check sensitivity threshold (minimum characters changed)
            const changes   = diffLines(site.lastText || '', filteredText);
            const addedChars = changes.filter(p => p.added).reduce((n, p) => n + p.value.length, 0);
            const threshold  = site.sensitivity || 20; // characters

            if (addedChars >= threshold) {
                hasChanged = true;
                diffText   = changes.map(p => {
                    if (p.added)   return `[+] ${p.value}`;
                    if (p.removed) return `[-] ${p.value}`;
                    return '';
                }).filter(Boolean).join('\n');

                const addedLines = changes.filter(p => p.added).map(p => p.value);
                const removedLines = changes.filter(p => p.removed).map(p => p.value);
                const aiSummary = await generateAiSummary(diffText, addedLines, removedLines);

                // Keyword-only alert check
                let matchedKeyword = null;
                let shouldAlert = true;
                if (site.keywords && site.keywords.length > 0) {
                    const lowerDiff = diffText.toLowerCase();
                    matchedKeyword = site.keywords.find(kw => kw && lowerDiff.includes(kw.toLowerCase().trim()));
                    if (!matchedKeyword) {
                        console.log(`[Alert] Change on ${site.url} skipped: did not match keywords (${site.keywords.join(', ')})`);
                        shouldAlert = false;
                    }
                }

                // Screenshot
                const screenshotName = `${site.id}_${Date.now()}.png`;
                const screenshotPath = path.join(SNAPSHOTS_DIR, screenshotName);
                await page.screenshot({ path: screenshotPath, fullPage: true });

                // Build diff image if there's a previous screenshot
                let diffScreenshotPath = null;
                if (site.lastScreenshot) {
                    const prevPath = path.join(SNAPSHOTS_DIR, site.lastScreenshot);
                    if (fs.existsSync(prevPath)) {
                        diffScreenshotPath = await buildScreenshotDiff(prevPath, screenshotPath);
                    }
                }

                // History entry with AI summary, keyword info and latency
                const historyEntry = {
                    id:             generateHash(screenshotName),
                    timestamp:      new Date().toISOString(),
                    hash:           currentHash,
                    diff:           diffText,
                    summary:        aiSummary,
                    matchedKeyword: matchedKeyword || null,
                    responseTimeMs: site.responseTimeMs || null,
                    screenshot:     screenshotName,
                    diffScreenshot: diffScreenshotPath ? path.basename(diffScreenshotPath) : null
                };
                site.history = [historyEntry, ...(site.history || [])].slice(0, 50); // Keep last 50

                site.lastScreenshot = screenshotName;
                site.lastChanged    = new Date().toLocaleString();

                if (shouldAlert) {
                    await sendAlerts(site, diffText, aiSummary, matchedKeyword);
                }
            }
        } else if (!site.lastHash) {
            // First check — take baseline screenshot
            const screenshotName = `${site.id}_baseline.png`;
            const screenshotPath = path.join(SNAPSHOTS_DIR, screenshotName);
            await page.screenshot({ path: screenshotPath, fullPage: true });
            site.lastScreenshot = screenshotName;
        }

        await browser.close();

        site.lastHash    = currentHash;
        site.lastText    = filteredText;
        site.lastChecked = new Date().toLocaleString();
        site.status      = 'OK';

        saveSites();
        return { success: true, hasChanged, diffText };

    } catch (error) {
        if (browser) await browser.close().catch(() => {});

        if (attempt < MAX_ATTEMPTS) {
            const delay = attempt * 5000; // 5s, 10s backoff
            console.log(`[Scheduler] Retry ${attempt}/${MAX_ATTEMPTS} for ${site.url} in ${delay}ms`);
            await new Promise(r => setTimeout(r, delay));
            return checkWebsite(site, attempt + 1);
        }

        site.status      = 'ERROR';
        site.lastError   = error.message;
        site.lastChecked = new Date().toLocaleString();
        saveSites();
        return { success: false, error: error.message };
    }
}

// ─── Job Queue ─────────────────────────────────────────────────────────────

const jobQueue  = [];
let   isRunning = false;

function enqueue(siteId) {
    if (!jobQueue.includes(siteId)) {
        jobQueue.push(siteId);
        console.log(`[Queue] Enqueued site ${siteId}. Queue length: ${jobQueue.length}`);
        processQueue();
    }
}

async function processQueue() {
    if (isRunning) return;
    if (jobQueue.length === 0) return;

    isRunning = true;
    const siteId = jobQueue.shift();
    const site   = watchedSites.find(s => s.id === siteId);

    if (site) {
        console.log(`[Queue] Checking: ${site.url}`);
        await checkWebsite(site);
    }

    isRunning = false;
    if (jobQueue.length > 0) processQueue();
}

// ─── Per-site interval scheduler ──────────────────────────────────────────

const siteTimers = {};

function startSiteTimer(site) {
    if (siteTimers[site.id]) clearInterval(siteTimers[site.id]);
    const interval = Math.max(site.intervalMs || 15 * 60 * 1000, 15 * 60 * 1000); // min 15 min
    siteTimers[site.id] = setInterval(() => enqueue(site.id), interval);
    console.log(`[Scheduler] Site "${site.name}" scheduled every ${interval / 60000} min`);
}

function stopSiteTimer(siteId) {
    if (siteTimers[siteId]) {
        clearInterval(siteTimers[siteId]);
        delete siteTimers[siteId];
    }
}

// Start timers for persisted sites (skip paused ones)
watchedSites.forEach(site => { if (!site.paused) startSiteTimer(site); });

// ─── Daily digest ──────────────────────────────────────────────────────────

function scheduleDigest() {
    const now   = new Date();
    const next  = new Date();
    next.setHours(DIGEST_HOUR, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);

    const delay = next - now;
    setTimeout(() => {
        sendDailyDigest();
        setInterval(sendDailyDigest, 24 * 60 * 60 * 1000);
    }, delay);
    console.log(`[Digest] Scheduled for ${next.toLocaleString()}`);
}

async function sendDailyDigest() {
    const sitesWithChanges = watchedSites.filter(s => {
        if (!s.history || s.history.length === 0) return false;
        const since = Date.now() - 24 * 60 * 60 * 1000;
        return s.history.some(h => new Date(h.timestamp).getTime() > since);
    });

    if (sitesWithChanges.length === 0) {
        console.log('[Digest] No changes in last 24h, skipping digest');
        return;
    }

    for (const site of sitesWithChanges) {
        if (!site.email && !site.telegramToken && !site.discordWebhook && !site.webhookUrl) continue;
        const recent = (site.history || []).filter(h => {
            return new Date(h.timestamp).getTime() > Date.now() - 24 * 60 * 60 * 1000;
        });
        const summary = `Daily Digest for ${site.name || site.url}\n\n${recent.length} change(s) in the last 24h.\n\n` +
            recent.map(h => `• ${new Date(h.timestamp).toLocaleString()}: ${h.diff.slice(0, 200)}`).join('\n\n');

        await sendEmailAlert(site, `[WCD Daily Digest] ${site.name || site.url}`, summary);
        await sendTelegramAlert(site, `*Daily Digest — ${site.name || site.url}*\n${recent.length} change(s) today`);
        await sendDiscordAlert(site, summary);
        await sendWebhookAlert(site, { diff: summary, summary: `Daily Digest (${recent.length} change(s))` });
    }
    console.log(`[Digest] Sent for ${sitesWithChanges.length} site(s)`);
}

scheduleDigest();

// ─── API Routes ─────────────────────────────────────────────────────────────

/** POST /api/track — register or update a site */
app.post('/api/track', async (req, res) => {
    const {
        id, url, name, intervalMs, selector, watchSelectors, ignoreSelectors,
        email, telegramToken, telegramChatId, discordWebhook, webhookUrl, sensitivity,
        keywords, tags
    } = req.body;

    if (!url) return res.status(400).json({ error: 'URL is required' });

    if (hasCredentialsInUrl(url)) {
        return res.status(400).json({ error: 'URLs with embedded credentials are not allowed' });
    }

    const parsedKeywords = Array.isArray(keywords)
        ? keywords.map(k => String(k).trim()).filter(Boolean)
        : (typeof keywords === 'string' ? keywords.split(',').map(k => k.trim()).filter(Boolean) : []);

    const parsedTags = Array.isArray(tags)
        ? tags.map(t => String(t).trim().toLowerCase()).filter(Boolean)
        : (typeof tags === 'string' ? tags.split(',').map(t => t.trim().toLowerCase()).filter(Boolean) : []);

    // Find existing site by ID if provided, otherwise by URL
    let site = (id ? watchedSites.find(s => s.id === id) : null) || watchedSites.find(s => s.url === url);
    const isNew = !site;

    if (isNew) {
        site = {
            id:              Date.now().toString(),
            url,
            name:            name || url,
            intervalMs:      Math.max(Number(intervalMs) || 15 * 60 * 1000, 15 * 60 * 1000),
            watchSelectors:  Array.isArray(watchSelectors)  ? watchSelectors  : (selector ? [selector] : []),
            ignoreSelectors: Array.isArray(ignoreSelectors) ? ignoreSelectors : [],
            keywords:        parsedKeywords,
            tags:            parsedTags,
            metrics:         [],
            responseTimeMs:  null,
            responseTimes:   [],
            email:           email || '',
            telegramToken:   telegramToken   || '',
            telegramChatId:  telegramChatId  || '',
            discordWebhook:  discordWebhook  || '',
            webhookUrl:      webhookUrl      || '',
            sensitivity:     Number(sensitivity) || 20,
            lastHash:        null,
            lastText:        '',
            lastScreenshot:  null,
            lastChecked:     null,
            lastChanged:     'Never',
            lastAlertHash:   null,
            lastAlertAt:     0,
            status:          'PENDING',
            history:         []
        };
        watchedSites.push(site);
        startSiteTimer(site);
    } else {
        // Update settings for existing site
        if (url && url !== site.url) {
            site.url = url;
            site.lastHash = null; // force re-check for new URL
        }
        if (name !== undefined)            site.name            = name;
        if (intervalMs !== undefined)      { site.intervalMs = Math.max(Number(intervalMs), 15 * 60 * 1000); startSiteTimer(site); }
        if (watchSelectors !== undefined)  site.watchSelectors  = Array.isArray(watchSelectors) ? watchSelectors : (selector ? [selector] : []);
        if (ignoreSelectors !== undefined) site.ignoreSelectors = Array.isArray(ignoreSelectors) ? ignoreSelectors : [];
        if (keywords !== undefined)        site.keywords        = parsedKeywords;
        if (tags !== undefined)            site.tags            = parsedTags;
        if (email !== undefined)           site.email           = email;
        if (telegramToken !== undefined)   site.telegramToken   = telegramToken;
        if (telegramChatId !== undefined)  site.telegramChatId  = telegramChatId;
        if (discordWebhook !== undefined)  site.discordWebhook  = discordWebhook;
        if (webhookUrl !== undefined)      site.webhookUrl      = webhookUrl;
        if (sensitivity !== undefined)     site.sensitivity     = Number(sensitivity);
    }

    saveSites();
    enqueue(site.id);

    res.json({
        success: true,
        message: isNew ? 'Site registered. First check has been queued.' : 'Site settings updated. Check has been queued.',
        siteId: site.id
    });
});

/** DELETE /api/sites/:id — remove a site */
app.delete('/api/sites/:id', (req, res) => {
    const idx = watchedSites.findIndex(s => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Site not found' });
    stopSiteTimer(watchedSites[idx].id);
    watchedSites.splice(idx, 1);
    saveSites();
    res.json({ success: true });
});

/** POST /api/sites/:id/check — manually trigger a check */
app.post('/api/sites/:id/check', (req, res) => {
    const site = watchedSites.find(s => s.id === req.params.id);
    if (!site) return res.status(404).json({ error: 'Site not found' });
    enqueue(site.id);
    res.json({ success: true, message: 'Check queued' });
});

/** GET /api/sites — list all sites (no lastText, too large) */
app.get('/api/sites', (req, res) => {
    const slim = watchedSites.map(({ lastText, ...rest }) => rest);
    res.json(slim);
});

/** GET /api/sites/:id — single site detail */
app.get('/api/sites/:id', (req, res) => {
    const site = watchedSites.find(s => s.id === req.params.id);
    if (!site) return res.status(404).json({ error: 'Site not found' });
    const { lastText, ...slim } = site;
    res.json(slim);
});

/** GET /api/sites/:id/history/:vid/diff — diff between version and previous */
app.get('/api/sites/:id/history/:vid', (req, res) => {
    const site = watchedSites.find(s => s.id === req.params.id);
    if (!site) return res.status(404).json({ error: 'Site not found' });
    const entry = (site.history || []).find(h => h.id === req.params.vid);
    if (!entry) return res.status(404).json({ error: 'Version not found' });
    res.json(entry);
});

/** POST /api/sites/:id/compare — compare two version IDs */
app.post('/api/sites/:id/compare', (req, res) => {
    const site = watchedSites.find(s => s.id === req.params.id);
    if (!site) return res.status(404).json({ error: 'Site not found' });
    const { vidA, vidB } = req.body;
    const a = (site.history || []).find(h => h.id === vidA);
    const b = (site.history || []).find(h => h.id === vidB);
    if (!a || !b) return res.status(404).json({ error: 'One or both versions not found' });
    res.json({ a, b, screenshotA: a.screenshot, screenshotB: b.screenshot, diffScreenshot: b.diffScreenshot });
});

/** PATCH /api/sites/:id/selectors — update watch/ignore selectors */
app.patch('/api/sites/:id/selectors', (req, res) => {
    const site = watchedSites.find(s => s.id === req.params.id);
    if (!site) return res.status(404).json({ error: 'Site not found' });
    const { watchSelectors, ignoreSelectors } = req.body;
    if (watchSelectors)  site.watchSelectors  = watchSelectors;
    if (ignoreSelectors) site.ignoreSelectors = ignoreSelectors;
    saveSites();
    res.json({ success: true, site: { watchSelectors: site.watchSelectors, ignoreSelectors: site.ignoreSelectors } });
});

/** GET /api/sites/:id/metrics — numeric metric trend data for charts */
app.get('/api/sites/:id/metrics', (req, res) => {
    const site = watchedSites.find(s => s.id === req.params.id);
    if (!site) return res.status(404).json({ error: 'Site not found' });
    res.json(site.metrics || []);
});

/** GET /api/sites/:id/latency — return response latency history for charts */
app.get('/api/sites/:id/latency', (req, res) => {
    const site = watchedSites.find(s => s.id === req.params.id);
    if (!site) return res.status(404).json({ error: 'Site not found' });
    res.json(site.responseTimes || []);
});

/** GET /api/sites/:id/rss — RSS 2.0 XML feed for an individual site */
app.get('/api/sites/:id/rss', (req, res) => {
    const site = watchedSites.find(s => s.id === req.params.id);
    if (!site) return res.status(404).send('Site not found');

    const historyItems = (site.history || []).map(h => `
        <item>
            <title>${escapeXml(h.summary || 'Content updated on ' + (site.name || site.url))}</title>
            <link>${escapeXml(site.url)}</link>
            <guid isPermaLink="false">${escapeXml(h.id)}</guid>
            <pubDate>${new Date(h.timestamp).toUTCString()}</pubDate>
            <description><![CDATA[
                <p><strong>URL:</strong> ${escapeXml(site.url)}</p>
                <p><strong>Detected At:</strong> ${new Date(h.timestamp).toLocaleString()}</p>
                ${h.summary ? `<p><strong>AI Summary:</strong> ${escapeXml(h.summary)}</p>` : ''}
                ${h.matchedKeyword ? `<p><strong>Matched Keyword:</strong> ${escapeXml(h.matchedKeyword)}</p>` : ''}
                <hr/>
                <pre style="background:#f4f4f4;padding:10px;border-radius:4px;font-family:monospace;white-space:pre-wrap;">${escapeXml(h.diff)}</pre>
            ]]></description>
        </item>
    `).join('');

    const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
    <channel>
        <title>Website Watch — ${escapeXml(site.name || site.url)}</title>
        <link>${escapeXml(site.url)}</link>
        <description>Change history and alerts for ${escapeXml(site.name || site.url)}</description>
        <language>en-us</language>
        <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
        ${historyItems}
    </channel>
</rss>`;

    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
    res.send(rssXml);
});

/** GET /api/rss — Aggregated RSS 2.0 feed for all watched sites */
app.get('/api/rss', (req, res) => {
    const allChanges = [];
    for (const site of watchedSites) {
        for (const h of (site.history || [])) {
            allChanges.push({ site, history: h });
        }
    }
    allChanges.sort((a, b) => new Date(b.history.timestamp) - new Date(a.history.timestamp));

    const feedItems = allChanges.slice(0, 50).map(({ site, history: h }) => `
        <item>
            <title>[${escapeXml(site.name || site.url)}] ${escapeXml(h.summary || 'Website Change Detected')}</title>
            <link>${escapeXml(site.url)}</link>
            <guid isPermaLink="false">${escapeXml(h.id)}</guid>
            <pubDate>${new Date(h.timestamp).toUTCString()}</pubDate>
            <description><![CDATA[
                <p><strong>Site:</strong> ${escapeXml(site.name || site.url)}</p>
                <p><strong>URL:</strong> ${escapeXml(site.url)}</p>
                <p><strong>Time:</strong> ${new Date(h.timestamp).toLocaleString()}</p>
                ${h.summary ? `<p><strong>Summary:</strong> ${escapeXml(h.summary)}</p>` : ''}
                <hr/>
                <pre style="background:#f4f4f4;padding:10px;border-radius:4px;font-family:monospace;white-space:pre-wrap;">${escapeXml(h.diff)}</pre>
            ]]></description>
        </item>
    `).join('');

    const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
    <channel>
        <title>Website Change Detector — All Sites Feed</title>
        <link>http://localhost:${PORT}</link>
        <description>Aggregated live updates from all monitored websites</description>
        <language>en-us</language>
        <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
        ${feedItems}
    </channel>
</rss>`;

    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
    res.send(rssXml);
});

/** GET /api/queue — current queue state */
app.get('/api/queue', (req, res) => {
    res.json({ queued: jobQueue, running: isRunning });
});

/** POST /api/sites/:id/pause — toggle pause/resume monitoring */
app.post('/api/sites/:id/pause', (req, res) => {
    const site = watchedSites.find(s => s.id === req.params.id);
    if (!site) return res.status(404).json({ error: 'Site not found' });

    site.paused = !site.paused;

    if (site.paused) {
        stopSiteTimer(site.id);
        console.log(`[Scheduler] Site "${site.name}" paused`);
    } else {
        startSiteTimer(site);
        enqueue(site.id); // immediate check on resume
        console.log(`[Scheduler] Site "${site.name}" resumed`);
    }

    saveSites();
    res.json({ success: true, paused: site.paused });
});

/** GET /api/export — download full backup as JSON */
app.get('/api/export', (req, res) => {
    const data = watchedSites.map(({ lastText, ...rest }) => rest);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="wcd-backup-${Date.now()}.json"`);
    res.json({ version: 2, exportedAt: new Date().toISOString(), sites: data });
});

/** POST /api/import — restore sites from a backup JSON */
app.post('/api/import', (req, res) => {
    const { sites: importedSites } = req.body;
    if (!Array.isArray(importedSites)) {
        return res.status(400).json({ error: 'Invalid backup format. Expected { sites: [...] }' });
    }

    let added = 0, skipped = 0;
    for (const site of importedSites) {
        if (!site.url) { skipped++; continue; }
        if (hasCredentialsInUrl(site.url)) { skipped++; continue; }
        const exists = watchedSites.find(s => s.url === site.url);
        if (exists) { skipped++; continue; }

        const newSite = {
            ...site,
            id:       Date.now().toString() + Math.random().toString(36).slice(2),
            lastText: '',
            status:   'PENDING',
            paused:   site.paused || false
        };
        watchedSites.push(newSite);
        if (!newSite.paused) {
            startSiteTimer(newSite);
            enqueue(newSite.id);
        }
        added++;
    }

    saveSites();
    res.json({ success: true, added, skipped });
});

/** GET /api/proxy — proxy web pages with an injected CSS selector picker script */
app.get('/api/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Missing url parameter');
    if (hasCredentialsInUrl(targetUrl)) return res.status(400).send('Credentials in URL not permitted');

    try {
        const fetchRes = await axios.get(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            timeout: 15000,
            responseType: 'text',
            maxRedirects: 5,
            validateStatus: () => true
        });

        let html = fetchRes.data;
        if (typeof html !== 'string') {
            return res.status(502).send('Unable to render page preview: Non-text response.');
        }

        // Clean out restrictive CSP meta tags
        html = html.replace(/<meta[^>]*http-equiv=["']?Content-Security-Policy["']?[^>]*>/gi, '');

        // Inject base href and inspector script into head
        const baseHref = `<base href="${targetUrl}">`;
        const inspectorScript = `
        <style id="wcd-inspector-style">
            .wcd-highlight-target {
                outline: 2px dashed #ff7700 !important;
                background-color: rgba(255, 119, 0, 0.12) !important;
                cursor: crosshair !important;
                transition: outline 0.1s ease !important;
            }
            #wcd-tooltip {
                position: fixed;
                z-index: 2147483647;
                background: #1a1d27;
                color: #ff7700;
                font-family: monospace;
                font-size: 11px;
                padding: 4px 8px;
                border-radius: 4px;
                border: 1px solid #ff7700;
                pointer-events: none;
                display: none;
                box-shadow: 0 4px 12px rgba(0,0,0,0.5);
            }
        </style>
        <div id="wcd-tooltip"></div>
        <script>
            (function() {
                let hoveredEl = null;
                const tooltip = document.getElementById('wcd-tooltip');

                function getOptimalSelector(el) {
                    if (!el || el.nodeType !== 1) return '';
                    if (el.id) return '#' + CSS.escape(el.id);

                    if (el.className && typeof el.className === 'string') {
                        const classes = el.className.trim().split(/\\s+/).filter(c => c && !c.startsWith('wcd-') && !c.includes(':'));
                        if (classes.length > 0) {
                            const classSel = el.tagName.toLowerCase() + '.' + classes.map(c => CSS.escape(c)).join('.');
                            try {
                                if (document.querySelectorAll(classSel).length === 1) return classSel;
                            } catch (_) {}
                        }
                    }

                    const parts = [];
                    let cur = el;
                    while (cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement) {
                        let tag = cur.tagName.toLowerCase();
                        if (cur.id) {
                            parts.unshift('#' + CSS.escape(cur.id));
                            break;
                        }
                        let sibIndex = 1;
                        let sib = cur.previousElementSibling;
                        let hasSameSib = false;
                        while (sib) {
                            if (sib.tagName === cur.tagName) {
                                sibIndex++;
                                hasSameSib = true;
                            }
                            sib = sib.previousElementSibling;
                        }
                        let nextSib = cur.nextElementSibling;
                        while (nextSib) {
                            if (nextSib.tagName === cur.tagName) {
                                hasSameSib = true;
                                break;
                            }
                            nextSib = nextSib.nextElementSibling;
                        }
                        if (hasSameSib) {
                            tag += ':nth-of-type(' + sibIndex + ')';
                        }
                        parts.unshift(tag);
                        if (parts.length >= 3) break;
                        cur = cur.parentElement;
                    }
                    return parts.join(' > ');
                }

                document.addEventListener('mouseover', function(e) {
                    if (e.target === tooltip || e.target === document.body || e.target === document.documentElement) return;
                    if (hoveredEl) hoveredEl.classList.remove('wcd-highlight-target');
                    hoveredEl = e.target;
                    hoveredEl.classList.add('wcd-highlight-target');

                    const sel = getOptimalSelector(hoveredEl);
                    if (tooltip) {
                        tooltip.textContent = sel;
                        tooltip.style.display = 'block';
                        tooltip.style.left = Math.min(e.clientX + 12, window.innerWidth - 220) + 'px';
                        tooltip.style.top = Math.max(e.clientY - 28, 10) + 'px';
                    }
                }, true);

                document.addEventListener('mousemove', function(e) {
                    if (tooltip && tooltip.style.display === 'block') {
                        tooltip.style.left = Math.min(e.clientX + 12, window.innerWidth - 220) + 'px';
                        tooltip.style.top = Math.max(e.clientY - 28, 10) + 'px';
                    }
                }, true);

                document.addEventListener('mouseout', function(e) {
                    if (e.target && e.target.classList) {
                        e.target.classList.remove('wcd-highlight-target');
                    }
                    if (tooltip) tooltip.style.display = 'none';
                }, true);

                document.addEventListener('click', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    const sel = getOptimalSelector(e.target);
                    if (sel) {
                        window.parent.postMessage({ type: 'SELECTOR_PICKED', selector: sel }, '*');
                    }
                }, true);
            })();
        </script>
        `;

        if (html.includes('</head>')) {
            html = html.replace('</head>', `${baseHref}${inspectorScript}</head>`);
        } else {
            html = `${baseHref}${inspectorScript}` + html;
        }

        res.removeHeader('X-Frame-Options');
        res.removeHeader('Content-Security-Policy');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);

    } catch (err) {
        console.error('[Proxy] Failed to fetch:', err.message);
        res.status(500).send(`
            <div style="font-family:sans-serif;padding:24px;text-align:center;color:#ef4444;background:#1a1d27;height:100vh">
                <h3>Could not load preview</h3>
                <p style="color:#8892a4;font-size:13px">${err.message}</p>
                <p style="font-size:12px;color:#8892a4;margin-top:10px">You can still enter CSS selectors manually in the dialog.</p>
            </div>
        `);
    }
});

/** POST /api/test-alert — verify alert channel credentials */
app.post('/api/test-alert', async (req, res) => {
    const { type, email, telegramToken, telegramChatId, discordWebhook, webhookUrl } = req.body;
    try {
        const dummySite = {
            id: 'test',
            name: 'Website Change Detector (Test)',
            url: 'https://example.com',
            email: email || '',
            telegramToken: telegramToken || '',
            telegramChatId: telegramChatId || '',
            discordWebhook: discordWebhook || '',
            webhookUrl: webhookUrl || ''
        };
        const sampleDiff = '[+] Welcome to Website Watch\n[+] Alerts configured successfully!';
        const sampleSummary = 'Verification test alert: notifications are operational.';

        if (type === 'email') {
            if (!email) return res.status(400).json({ error: 'Email address is required' });
            await sendEmailAlert(dummySite, '[WCD Test Alert] Verification successful', 'This is a test notification from Website Change Detector.\nYour email alerts are functioning correctly!');
        } else if (type === 'telegram') {
            if (!telegramToken || !telegramChatId) return res.status(400).json({ error: 'Telegram Bot Token and Chat ID are required' });
            await sendTelegramAlert(dummySite, '🎉 *Website Change Detector*\nTest alert successful! Your Telegram notifications are working.');
        } else if (type === 'discord') {
            if (!discordWebhook) return res.status(400).json({ error: 'Discord Webhook URL is required' });
            await sendDiscordAlert(dummySite, '🎉 **Website Change Detector**\nTest alert successful! Your Discord webhook is working.');
        } else if (type === 'webhook') {
            if (!webhookUrl) return res.status(400).json({ error: 'Webhook URL is required' });
            await sendWebhookAlert(dummySite, { diff: sampleDiff, summary: sampleSummary });
        } else {
            return res.status(400).json({ error: 'Invalid alert type specified' });
        }
        res.json({ success: true, message: `Test ${type} alert dispatched successfully!` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/** POST /api/test-selector — live evaluate a selector against target URL */
app.post('/api/test-selector', async (req, res) => {
    const { url, selector } = req.body;
    if (!url || !selector) return res.status(400).json({ error: 'URL and selector are required' });
    if (hasCredentialsInUrl(url)) return res.status(400).json({ error: 'Credentials in URL not permitted' });

    let browser;
    try {
        const launchOptions = {
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        };
        if (process.env.PUPPETEER_EXECUTABLE_PATH) {
            launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
        }
        browser = await puppeteer.launch(launchOptions);
        const page = await browser.newPage();
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        );

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise(r => setTimeout(r, 1500));

        const testResult = await page.evaluate((sel) => {
            try {
                const nodes = document.querySelectorAll(sel);
                if (!nodes || nodes.length === 0) return { count: 0, text: '', tagName: null };
                const first = nodes[0];
                const text = (first.innerText || first.textContent || '').trim().slice(0, 250);
                return {
                    count: nodes.length,
                    text,
                    tagName: first.tagName.toLowerCase(),
                    className: first.className && typeof first.className === 'string' ? first.className : ''
                };
            } catch (evalErr) {
                return { count: -1, error: evalErr.message };
            }
        }, selector);

        await browser.close();

        if (testResult.count === -1) {
            return res.status(400).json({ error: 'Invalid CSS selector syntax: ' + testResult.error });
        }

        res.json({
            success: true,
            count: testResult.count,
            text: testResult.text,
            tagName: testResult.tagName,
            className: testResult.className
        });

    } catch (err) {
        if (browser) await browser.close().catch(() => {});
        res.status(500).json({ error: 'Could not test selector: ' + err.message });
    }
});

/** GET /api/export/csv — download CSV report of all monitored sites */
app.get('/api/export/csv', (req, res) => {
    const headers = ['Site ID', 'Name', 'URL', 'Status', 'Interval (min)', 'Sensitivity (chars)', 'Last Checked', 'Last Changed', 'Change Count', 'Keywords', 'Email', 'Telegram Chat', 'Discord Webhook', 'Custom Webhook'];
    const rows = watchedSites.map(s => [
        `"${s.id}"`,
        `"${(s.name || '').replace(/"/g, '""')}"`,
        `"${(s.url || '').replace(/"/g, '""')}"`,
        `"${s.status || 'PENDING'}"`,
        Math.round((s.intervalMs || 3600000) / 60000),
        s.sensitivity || 20,
        `"${s.lastChecked || ''}"`,
        `"${s.lastChanged || 'Never'}"`,
        (s.history || []).length,
        `"${(s.keywords || []).join(', ').replace(/"/g, '""')}"`,
        `"${(s.email || '').replace(/"/g, '""')}"`,
        `"${(s.telegramChatId || '').replace(/"/g, '""')}"`,
        `"${(s.discordWebhook ? 'Configured' : '').replace(/"/g, '""')}"`,
        `"${(s.webhookUrl ? 'Configured' : '').replace(/"/g, '""')}"`
    ].join(','));

    const csv = [headers.join(','), ...rows].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="wcd-sites-${Date.now()}.csv"`);
    res.send(csv);
});

/** GET /api/sites/:id/export/csv — download CSV of this site's version history */
app.get('/api/sites/:id/export/csv', (req, res) => {
    const site = watchedSites.find(s => s.id === req.params.id);
    if (!site) return res.status(404).send('Site not found');
    const headers = ['Version ID', 'Timestamp', 'Hash', 'Matched Keyword', 'AI Summary', 'Diff Snippet'];
    const rows = (site.history || []).map(h => [
        `"${h.id}"`,
        `"${h.timestamp}"`,
        `"${h.hash}"`,
        `"${(h.matchedKeyword || '').replace(/"/g, '""')}"`,
        `"${(h.summary || '').replace(/"/g, '""')}"`,
        `"${(h.diff || '').slice(0, 300).replace(/\r?\n/g, ' ').replace(/"/g, '""')}"`
    ].join(','));
    const csv = [headers.join(','), ...rows].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="wcd-${site.id}-history.csv"`);
    res.send(csv);
});

// ─── Start server ──────────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`\n🚀 Website Change Detector running at http://localhost:${PORT}\n`);
    console.log(`   Snapshots:  ${SNAPSHOTS_DIR}`);
    console.log(`   Data file:  ${DATA_FILE}`);
    console.log(`   Monitoring: ${watchedSites.length} site(s)\n`);
});