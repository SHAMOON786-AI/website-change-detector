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
        sendDiscordAlert(site, body)
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
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--single-process'
            ]
        };
        // On Railway/cloud: use system Chromium via env var
        if (process.env.PUPPETEER_EXECUTABLE_PATH) {
            launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
        }
        browser = await puppeteer.launch(launchOptions);
        const page = await browser.newPage();

        // Set a realistic user-agent to reduce bot blocks
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        );

        await page.goto(site.url, { waitUntil: 'networkidle2', timeout: 30000 });

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

                // History entry with AI summary and keyword info
                const historyEntry = {
                    id:             generateHash(screenshotName),
                    timestamp:      new Date().toISOString(),
                    hash:           currentHash,
                    diff:           diffText,
                    summary:        aiSummary,
                    matchedKeyword: matchedKeyword || null,
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
        if (!site.email && !site.telegramToken && !site.discordWebhook) continue;
        const recent = (site.history || []).filter(h => {
            return new Date(h.timestamp).getTime() > Date.now() - 24 * 60 * 60 * 1000;
        });
        const summary = `Daily Digest for ${site.name || site.url}\n\n${recent.length} change(s) in the last 24h.\n\n` +
            recent.map(h => `• ${new Date(h.timestamp).toLocaleString()}: ${h.diff.slice(0, 200)}`).join('\n\n');

        await sendEmailAlert(site, `[WCD Daily Digest] ${site.name || site.url}`, summary);
        await sendTelegramAlert(site, `*Daily Digest — ${site.name || site.url}*\n${recent.length} change(s) today`);
        await sendDiscordAlert(site, summary);
    }
    console.log(`[Digest] Sent for ${sitesWithChanges.length} site(s)`);
}

scheduleDigest();

// ─── API Routes ─────────────────────────────────────────────────────────────

/** POST /api/track — register or update a site */
app.post('/api/track', async (req, res) => {
    const {
        url, name, intervalMs, selector, watchSelectors, ignoreSelectors,
        email, telegramToken, telegramChatId, discordWebhook, sensitivity,
        keywords
    } = req.body;

    if (!url) return res.status(400).json({ error: 'URL is required' });

    if (hasCredentialsInUrl(url)) {
        return res.status(400).json({ error: 'URLs with embedded credentials are not allowed' });
    }

    const parsedKeywords = Array.isArray(keywords)
        ? keywords.map(k => String(k).trim()).filter(Boolean)
        : (typeof keywords === 'string' ? keywords.split(',').map(k => k.trim()).filter(Boolean) : []);

    // URL-level deduplication
    let site = watchedSites.find(s => s.url === url);
    if (!site) {
        site = {
            id:              Date.now().toString(),
            url,
            name:            name || url,
            intervalMs:      Math.max(Number(intervalMs) || 15 * 60 * 1000, 15 * 60 * 1000),
            watchSelectors:  Array.isArray(watchSelectors)  ? watchSelectors  : (selector ? [selector] : []),
            ignoreSelectors: Array.isArray(ignoreSelectors) ? ignoreSelectors : [],
            keywords:        parsedKeywords,
            metrics:         [],
            email:           email || '',
            telegramToken:   telegramToken   || '',
            telegramChatId:  telegramChatId  || '',
            discordWebhook:  discordWebhook  || '',
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
        if (name)            site.name            = name;
        if (intervalMs)      { site.intervalMs = Math.max(Number(intervalMs), 15 * 60 * 1000); startSiteTimer(site); }
        if (watchSelectors)  site.watchSelectors  = watchSelectors;
        if (ignoreSelectors) site.ignoreSelectors = ignoreSelectors;
        if (keywords !== undefined) site.keywords = parsedKeywords;
        if (email)           site.email           = email;
        if (telegramToken)   site.telegramToken   = telegramToken;
        if (telegramChatId)  site.telegramChatId  = telegramChatId;
        if (discordWebhook)  site.discordWebhook  = discordWebhook;
        if (sensitivity)     site.sensitivity     = Number(sensitivity);
    }

    saveSites();
    enqueue(site.id);

    res.json({ success: true, message: 'Site registered. First check has been queued.', siteId: site.id });
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

// ─── Start server ──────────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`\n🚀 Website Change Detector running at http://localhost:${PORT}\n`);
    console.log(`   Snapshots:  ${SNAPSHOTS_DIR}`);
    console.log(`   Data file:  ${DATA_FILE}`);
    console.log(`   Monitoring: ${watchedSites.length} site(s)\n`);
});