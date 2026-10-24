/**
 * ============================================================================
 * WHATSAPP HIGH-QUALITY RADIO & PERSONAL QUEUE BOT (v2.0 CONNECTION FIX)
 * ============================================================================
 * Pre-Configured Numbers & Live Render Server:
 * - Live URL:     https://wabot-4nbu.onrender.com
 * - Owner Number: +91 9539601481 (Controls Queue via DM)
 * - Bot Number:   +91 9656977828 (QR & 8-Digit Pairing Login)
 * ============================================================================
 */

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers,
    delay
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const QRCode = require('qrcode');
const yts = require('yt-search');
const ytdl = require('@distube/ytdl-core');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ============================================================================
// CONFIGURATION
// ============================================================================
const PORT = process.env.PORT || 10000;

// Your Personal WhatsApp Number (Controls the Queue Privately via DM)
const RAW_OWNER = (process.env.OWNER_NUMBER || '919539601481').replace(/[^0-9]/g, '');
const OWNER_NUMBER = RAW_OWNER + '@s.whatsapp.net';

// Your Bot WhatsApp Number (Used for 8-Digit Cloud Pairing Code Login)
const DEFAULT_BOT_NUMBER = (process.env.BOT_NUMBER || '919656977828').replace(/[^0-9]/g, '');

// Your Live Render URL for automatic 24/7 self-pinging
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || 'https://wabot-4nbu.onrender.com';

// Default GitHub Repo for syncing .mp3 files live without redeploying
const DEFAULT_GITHUB_REPO = process.env.GITHUB_REPO || 'https://github.com/BUSA2023/Wabot';

const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');

// In-Memory State
let requestQueue = [];
let targetGroupJid = null;
let nowPlaying = null;
let autoDjEnabled = true;
let autoDjTimer = null;
let wsKeepAliveInterval = null;
let lastPlayedAudioKey = null;
let lastPlayedJid = null;
let currentDownloadAbort = null;

// Connection & Anti-Race Lock State
let activeSock = null;
let currentSocketId = 0;
let isConnected = false;
let isConnecting = false;
let authMode = 'qr'; // 'qr' or 'pair'
let pairingPhoneNumber = DEFAULT_BOT_NUMBER;
let latestPairingCode = null;
let latestQrDataUrl = null;
let botConnectionStatus = 'Initializing WhatsApp Socket...';
let lastPairRequestTime = 0;

// Safely wipe auth folder ONLY on explicit reset or LoggedOut (401)
function clearAuthFolder() {
    try {
        if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            console.log('🧹 Cleared old auth_info_baileys session folder.');
        }
    } catch (e) {
        console.error('Could not clear auth folder:', e.message);
    }
}

// ============================================================================
// 1. EXPRESS WEB DASHBOARD (UNIFIED QR + 8-DIGIT PAIRING CONTROLLER)
// ============================================================================
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Live JSON status endpoint for auto-updating frontend
app.get('/status', (req, res) => {
    res.json({
        isConnected,
        authMode,
        status: botConnectionStatus,
        pairingCode: latestPairingCode,
        qrDataUrl: latestQrDataUrl,
        botNumber: pairingPhoneNumber,
        ownerNumber: RAW_OWNER,
        queueLength: requestQueue.length,
        nowPlaying: nowPlaying ? nowPlaying.title : null
    });
});

// Switch view mode WITHOUT wiping active session or triggering double-restarts
app.get('/mode', (req, res) => {
    if (isConnected) return res.redirect('/');
    const targetMode = req.query.type === 'pair' ? 'pair' : 'qr';
    authMode = targetMode;
    if (targetMode === 'pair' && !latestPairingCode) {
        botConnectionStatus = 'Click "Generate 8-Digit Code" below when your phone is ready.';
    } else if (targetMode === 'qr') {
        botConnectionStatus = latestQrDataUrl
            ? 'Ready! Scan the QR Code on screen.'
            : 'Waiting for QR code...';
    }
    res.redirect('/');
});

// Trigger 8-Digit Pairing Code Mode cleanly with 15s Anti-Double-Click Lock
app.post('/pair', async (req, res) => {
    if (isConnected) return res.redirect('/');

    const now = Date.now();
    // Prevent double-clicks or browser prefetch from wiping the auth folder mid-generation!
    if (now - lastPairRequestTime < 15000 && latestPairingCode) {
        console.log('⏳ Ignored duplicate /pair request within 15s cooldown window to protect active code.');
        return res.redirect('/');
    }
    lastPairRequestTime = now;

    const customPhone = (req.body.phone || req.query.phone || DEFAULT_BOT_NUMBER).replace(/[^0-9]/g, '');
    if (customPhone.length >= 10) {
        pairingPhoneNumber = customPhone;
    }

    console.log(`🔄 Starting protected 8-Digit Pairing session for +${pairingPhoneNumber}...`);
    authMode = 'pair';
    latestPairingCode = 'GENERATING...';
    latestQrDataUrl = null;
    botConnectionStatus = `Generating fresh 8-digit pairing code for +${pairingPhoneNumber}...`;

    clearAuthFolder();
    await startRadioBot(true);
    res.redirect('/');
});

// Also support GET /pair with the same 15s protection lock
app.get('/pair', async (req, res) => {
    if (isConnected) return res.redirect('/');
    const now = Date.now();
    if (now - lastPairRequestTime < 15000 && latestPairingCode) {
        console.log('⏳ Ignored duplicate GET /pair request within 15s cooldown window.');
        authMode = 'pair';
        return res.redirect('/');
    }
    lastPairRequestTime = now;

    const customPhone = (req.query.phone || DEFAULT_BOT_NUMBER).replace(/[^0-9]/g, '');
    if (customPhone.length >= 10) {
        pairingPhoneNumber = customPhone;
    }

    console.log(`🔄 Starting protected 8-Digit Pairing session for +${pairingPhoneNumber}...`);
    authMode = 'pair';
    latestPairingCode = 'GENERATING...';
    latestQrDataUrl = null;
    botConnectionStatus = `Generating fresh 8-digit pairing code for +${pairingPhoneNumber}...`;

    clearAuthFolder();
    await startRadioBot(true);
    res.redirect('/');
});

// Trigger Clean QR Code Mode
app.get('/qr-mode', async (req, res) => {
    if (isConnected) return res.redirect('/');
    authMode = 'qr';
    // Only restart if we don't already have an active QR socket
    if (!latestQrDataUrl) {
        console.log('🔄 Switching to Clean QR Code Scan Mode...');
        latestPairingCode = null;
        botConnectionStatus = 'Generating fresh QR code...';
        clearAuthFolder();
        await startRadioBot(true);
    }
    res.redirect('/');
});

// Full Session Reset Button
app.get('/reset', async (req, res) => {
    console.log('⚠️ Manual session reset requested.');
    isConnected = false;
    lastPairRequestTime = 0;
    latestPairingCode = null;
    latestQrDataUrl = null;
    authMode = 'qr';
    botConnectionStatus = 'Session wiped. Restarting socket...';
    clearAuthFolder();
    await startRadioBot(true);
    res.redirect('/');
});

// Main Live Pairing & Status Dashboard
app.get('/', (req, res) => {
    res.status(200).send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>WA RadioBot Connection Hub (v2.1)</title>
        <style>
            * { box-sizing: border-box; }
            body { font-family: system-ui, -apple-system, sans-serif; background: #0b141a; color: #e9edef; padding: 20px; max-width: 680px; margin: 0 auto; }
            .card { background: #1f2c34; border-radius: 16px; padding: 24px; margin-bottom: 18px; border: 1px solid #2a3942; box-shadow: 0 10px 25px rgba(0,0,0,0.4); }
            .badge { display: inline-block; padding: 4px 10px; border-radius: 99px; font-size: 12px; font-weight: 700; background: #00a88422; color: #00a884; border: 1px solid #00a88455; }
            .code-box { font-size: 32px; font-weight: 800; letter-spacing: 5px; color: #00a884; background: #111b21; padding: 18px; border-radius: 12px; text-align: center; margin: 16px 0; border: 2px dashed #00a884; font-family: monospace; }
            .qr-box { background: #ffffff; padding: 16px; border-radius: 16px; display: inline-block; margin: 14px auto; }
            .btn { display: inline-block; background: #00a884; color: #0b141a; font-weight: 700; text-decoration: none; padding: 12px 20px; border-radius: 10px; border: none; cursor: pointer; font-size: 14px; transition: 0.2s; }
            .btn:hover { background: #06cf9c; }
            .btn-secondary { background: #2a3942; color: #e9edef; }
            .btn-secondary:hover { background: #374852; }
            .btn-danger { background: #ef444422; color: #f87171; border: 1px solid #ef444455; }
            .tabs { display: flex; gap: 10px; margin-bottom: 16px; flex-wrap: wrap; }
            input { background: #111b21; border: 1px solid #2a3942; color: #fff; padding: 11px 14px; border-radius: 10px; font-size: 14px; width: 220px; }
            code { background: #111b21; padding: 3px 6px; border-radius: 5px; color: #53bdeb; }
        </style>
    </head>
    <body>
        <div class="card">
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
                <h2 style="margin:0;">📻 WA RadioBot v2.1 (Node 20 LTS)</h2>
                <span class="badge" id="conn-badge">Checking...</span>
            </div>
            <p style="color:#8696a0; font-size:14px; margin-top:8px;">
                <strong>Status:</strong> <span id="status-text" style="color:#00a884; font-weight:bold;">${botConnectionStatus}</span><br>
                <strong>Owner DM Controller:</strong> +${RAW_OWNER} &bull; <strong>Target Bot Line:</strong> +<span id="bot-num">${pairingPhoneNumber}</span>
            </p>
            <hr style="border-color:#2a3942; margin: 18px 0;">

            <!-- CONNECTED VIEW -->
            <div id="connected-view" style="display:none; text-align:center; padding:10px 0;">
                <h3 style="color:#00a884; font-size:22px; margin-bottom:8px;">✅ WhatsApp Bot is Linked & Online 24/7!</h3>
                <p style="font-size:14px; color:#d1d7db;">Send <code>!add Song Name</code>, <code>!list</code>, or <code>!play</code> to <strong>+${pairingPhoneNumber}</strong> from your personal WhatsApp (<strong>+${RAW_OWNER}</strong>).</p>
                <p style="font-size:13px; color:#8696a0;">In your WhatsApp group, send <code>!bind</code> once to set that group as the radio broadcast destination.</p>
                <div style="margin-top:20px;">
                    <a class="btn btn-danger" href="/reset">🔌 Disconnect / Relink Another Number</a>
                </div>
            </div>

            <!-- UNCONNECTED LOGIN VIEW -->
            <div id="login-view">
                <div class="tabs">
                    <a class="btn ${authMode === 'qr' ? '' : 'btn-secondary'}" href="/mode?type=qr">📷 Method 1: Scan QR Code (Fastest)</a>
                    <a class="btn ${authMode === 'pair' ? '' : 'btn-secondary'}" href="/mode?type=pair">🔢 Method 2: 8-Digit Pairing Code</a>
                </div>

                <!-- QR MODE -->
                <div id="qr-section" style="display:${authMode === 'qr' ? 'block' : 'none'}; text-align:center; background:#111b21; padding:20px; border-radius:12px;">
                    <h3 style="margin-top:0;">📷 Scan Instant QR Code</h3>
                    <p style="font-size:13px; color:#8696a0;">Open WhatsApp on <strong>+${pairingPhoneNumber}</strong> &rarr; <strong>Linked Devices</strong> &rarr; <strong>Link a Device</strong></p>
                    <div id="qr-container">
                        <p style="color:#00a884; padding:30px;">⏳ Waiting for fresh QR code from WhatsApp...</p>
                    </div>
                    <p style="font-size:12px; color:#8696a0;">QR refreshes automatically on this page without reloading!</p>
                </div>

                <!-- PAIRING CODE MODE -->
                <div id="pair-section" style="display:${authMode === 'pair' ? 'block' : 'none'}; background:#111b21; padding:20px; border-radius:12px;">
                    <h3 style="margin-top:0;">🔑 Link with 8-Digit Phone Code</h3>
                    <p style="font-size:13px; color:#8696a0; line-height:1.5;">
                        1. Open WhatsApp on <strong>+${pairingPhoneNumber}</strong> &rarr; <strong>Linked Devices</strong> &rarr; <strong>Link with phone number instead</strong>.<br>
                        2. Click <strong>Generate 8-Digit Code</strong> ONCE below and wait 3 seconds:
                    </p>
                    <form action="/pair" method="POST" style="display:flex; gap:10px; flex-wrap:wrap; margin:14px 0;">
                        <input type="text" name="phone" value="${pairingPhoneNumber}" placeholder="919656977828" required />
                        <button type="submit" class="btn">🔄 Generate 8-Digit Code (Click Once)</button>
                    </form>
                    <div class="code-box" id="pair-code-box">${latestPairingCode || 'CLICK GENERATE ABOVE'}</div>
                    <p style="font-size:12px; color:#eab308; text-align:center;">
                        ⚠️ Do NOT click Generate twice! After typing the code on your phone, wait 5–10 seconds for WhatsApp to finish syncing keys.
                    </p>
                </div>

                <div style="margin-top:16px; display:flex; justify-content:space-between; align-items:center;">
                    <span style="font-size:12px; color:#8696a0;">Need a fresh socket?</span>
                    <a class="btn btn-danger" style="padding:8px 14px; font-size:12px;" href="/reset">🧹 Hard Reset Auth Folder</a>
                </div>
            </div>
        </div>

        <script>
            async function pollStatus() {
                try {
                    const res = await fetch('/status');
                    const data = await res.json();
                    document.getElementById('status-text').textContent = data.status;
                    document.getElementById('bot-num').textContent = data.botNumber;
                    const badge = document.getElementById('conn-badge');

                    if (data.isConnected) {
                        badge.textContent = 'ONLINE 24/7';
                        badge.style.background = '#00a88433';
                        badge.style.color = '#00a884';
                        document.getElementById('connected-view').style.display = 'block';
                        document.getElementById('login-view').style.display = 'none';
                    } else {
                        badge.textContent = data.authMode === 'pair' ? 'PAIRING MODE' : 'QR SCAN MODE';
                        badge.style.background = '#eab30822';
                        badge.style.color = '#facc15';
                        document.getElementById('connected-view').style.display = 'none';
                        document.getElementById('login-view').style.display = 'block';

                        if (data.authMode === 'qr') {
                            document.getElementById('qr-section').style.display = 'block';
                            document.getElementById('pair-section').style.display = 'none';
                            const qrContainer = document.getElementById('qr-container');
                            if (data.qrDataUrl) {
                                qrContainer.innerHTML = '<div class="qr-box"><img src="' + data.qrDataUrl + '" width="260" height="260" alt="WhatsApp QR"/></div>';
                            } else {
                                qrContainer.innerHTML = '<p style="color:#00a884; padding:30px;">⏳ Generating QR Code... (Or click Hard Reset below)</p>';
                            }
                        } else {
                            document.getElementById('qr-section').style.display = 'none';
                            document.getElementById('pair-section').style.display = 'block';
                            document.getElementById('pair-code-box').textContent = data.pairingCode || 'CLICK GENERATE ABOVE';
                        }
                    }
                } catch (e) {}
            }
            setInterval(pollStatus, 2000);
            pollStatus();
        </script>
    </body>
    </html>
    `);
});

// Backwards-compatible /qr route redirects to main unified dashboard
app.get('/qr', (req, res) => res.redirect('/mode?type=qr'));

// Lightweight 24/7 Wake-Up Endpoint for Cron-job.org / UptimeRobot
app.get('/ping', (req, res) => {
    res.status(200).send('PONG - RadioBot Awake 24/7');
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 24/7 Keep-Alive & Radio Server running on port ${PORT}`);
    console.log(`👑 Owner Number configured: +${RAW_OWNER}`);
    console.log(`🤖 Bot Number configured:   +${pairingPhoneNumber}`);

    if (RENDER_EXTERNAL_URL && RENDER_EXTERNAL_URL.startsWith('https://')) {
        setInterval(() => {
            https.get(`${RENDER_EXTERNAL_URL.replace(/\/+$/, '')}/ping`, (res) => {
                console.log(`⚡ 24/7 Self-Ping Status: ${res.statusCode}`);
            }).on('error', () => {});
        }, 4 * 60 * 1000); // Every 4 minutes
    }
});

// ============================================================================
// GITHUB & DIRECT MP3 DOWNLOAD HELPERS
// ============================================================================

// Convert standard GitHub blob URL to raw.githubusercontent.com URL
function normalizeGitHubMp3Url(rawUrl) {
    let url = rawUrl.trim();
    // Convert https://github.com/user/repo/blob/branch/path.mp3 -> https://raw.githubusercontent.com/user/repo/branch/path.mp3
    if (url.includes('github.com') && url.includes('/blob/')) {
        url = url
            .replace('https://github.com/', 'https://raw.githubusercontent.com/')
            .replace('/blob/', '/');
    }
    return url;
}

// Download any direct .mp3 URL (including GitHub Raw) with redirect support
function downloadDirectMp3(fileUrl, destPath) {
    return new Promise((resolve, reject) => {
        const client = fileUrl.startsWith('https') ? https : http;
        const req = client.get(fileUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (WA-RadioBot/2.3)' }
        }, (res) => {
            // Follow 301/302 redirects (GitHub raw redirects)
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return downloadDirectMp3(res.headers.location, destPath).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP Status ${res.statusCode}`));
            }
            const fileStream = fs.createWriteStream(destPath);
            res.pipe(fileStream);
            fileStream.on('finish', () => {
                fileStream.close(() => resolve(destPath));
            });
            fileStream.on('error', (err) => {
                if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
                reject(err);
            });
        });
        req.on('error', reject);
        req.setTimeout(45000, () => {
            req.destroy();
            reject(new Error('Download timeout'));
        });
    });
}

// Fetch all .mp3 files from a GitHub Repository or Folder URL using GitHub API
function fetchGitHubRepoMp3s(repoUrl) {
    return new Promise((resolve, reject) => {
        try {
            // Parse https://github.com/OWNER/REPO or https://github.com/OWNER/REPO/tree/BRANCH/FOLDER
            const cleaned = repoUrl.trim().replace(/\/+$/, '');
            const match = cleaned.match(/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+)(?:\/(.*))?)?/i);
            if (!match) {
                return reject(new Error('Invalid GitHub repository URL. Example: https://github.com/BUSA2023/Wabot'));
            }
            const owner = match[1];
            const repo = match[2].replace(/\.git$/i, '');
            const branch = match[3] || '';
            const subPath = match[4] || '';

            const apiPath = `/repos/${owner}/${repo}/contents/${subPath}${branch ? `?ref=${branch}` : ''}`;

            https.get({
                hostname: 'api.github.com',
                path: apiPath,
                headers: {
                    'User-Agent': 'WA-RadioBot-v2.3',
                    'Accept': 'application/vnd.github.v3+json'
                }
            }, (res) => {
                let rawData = '';
                res.on('data', chunk => rawData += chunk);
                res.on('end', () => {
                    try {
                        if (res.statusCode !== 200) {
                            return reject(new Error(`GitHub API returned status ${res.statusCode}`));
                        }
                        const items = JSON.parse(rawData);
                        const list = Array.isArray(items) ? items : [items];
                        const mp3Files = list
                            .filter(item => item.type === 'file' && /\.(mp3|m4a|ogg|wav)$/i.test(item.name) && item.download_url)
                            .map(item => ({
                                title: decodeURIComponent(item.name.replace(/\.(mp3|m4a|ogg|wav)$/i, '').replace(/[-_]/g, ' ')),
                                url: item.download_url,
                                duration: 'HQ Direct MP3',
                                thumbnail: 'https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png',
                                author: `${owner}/${repo}`,
                                isDirectMp3: true
                            }));
                        resolve(mp3Files);
                    } catch (parseErr) {
                        reject(parseErr);
                    }
                });
            }).on('error', reject);
        } catch (err) {
            reject(err);
        }
    });
}

// ============================================================================
// 2. WHATSAPP BOT CORE LOGIC (LOCKED SOCKET INSTANCE & ANTI-DROP HEARTBEAT)
// ============================================================================
const logger = pino({ level: 'silent' });

async function startRadioBot(forceRestart = false) {
    if (isConnecting && !forceRestart) return;
    isConnecting = true;

    const mySocketId = ++currentSocketId;
    let pairingRequestedForThisSocket = false;

    try {
        // Cleanly close existing socket if restarting
        if (wsKeepAliveInterval) {
            clearInterval(wsKeepAliveInterval);
            wsKeepAliveInterval = null;
        }
        if (activeSock) {
            try {
                activeSock.ev.removeAllListeners();
                activeSock.ws.close();
            } catch (e) {}
            activeSock = null;
        }

        if (!fs.existsSync(AUTH_DIR)) {
            fs.mkdirSync(AUTH_DIR, { recursive: true });
        }

        // Check if local folder has saved credentials so startup defaults to existing session
        const credsFile = path.join(AUTH_DIR, 'creds.json');
        const hasExistingSession = fs.existsSync(credsFile);

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

        // Fetch latest WhatsApp Web version with safe fallback
        let version = [2, 3000, 1015901307];
        try {
            const latest = await fetchLatestBaileysVersion();
            if (latest && latest.version) version = latest.version;
        } catch (verErr) {
            console.log('Using fallback WhatsApp Web version:', version);
        }

        const sock = makeWASocket({
            version,
            logger,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            // Official Ubuntu Chrome signature required for both QR & Pairing Code
            browser: Browsers.ubuntu('Chrome'),
            markOnlineOnConnect: true,
            syncFullHistory: false,
            generateHighQualityLinkPreview: false,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            // CRITICAL FIX FOR CONNECTION DROPS: Send WebSocket ping every 20s & retry fast
            keepAliveIntervalMs: 20000,
            retryRequestDelayMs: 1500,
            maxMsgRetryCount: 5,
            // Required by WhatsApp Business Multi-Device to decrypt incoming DM commands reliably
            getMessage: async () => ({ conversation: 'WA RadioBot' })
        });

        activeSock = sock;

        // CRITICAL: Always save credentials immediately whenever updated
        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            // Ignore events from superseded sockets
            if (mySocketId !== currentSocketId) return;

            const { connection, lastDisconnect, qr } = update;

            // 1. Handle QR Generation OR 8-Digit Pairing Code Request
            if (qr && !sock.authState.creds.registered) {
                if (authMode === 'qr') {
                    try {
                        latestQrDataUrl = await QRCode.toDataURL(qr, { margin: 2, width: 280 });
                        botConnectionStatus = 'Ready! Scan the QR Code on screen.';
                        console.log('📷 New QR Code generated and ready at /');
                    } catch (qrErr) {
                        console.error('QR generation error:', qrErr.message);
                    }
                } else if (authMode === 'pair' && !pairingRequestedForThisSocket) {
                    pairingRequestedForThisSocket = true;
                    try {
                        await delay(2000);
                        if (mySocketId !== currentSocketId || sock.authState.creds.registered) return;
                        const cleanNum = pairingPhoneNumber.replace(/[^0-9]/g, '');
                        const code = await sock.requestPairingCode(cleanNum);
                        latestPairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
                        botConnectionStatus = `Enter code ${latestPairingCode} on WhatsApp (+${cleanNum})`;
                        console.log('\n============================================================');
                        console.log(`🔑 8-DIGIT PAIRING CODE FOR +${cleanNum}: ${latestPairingCode}`);
                        console.log('============================================================\n');
                    } catch (pairErr) {
                        console.error('Error requesting pairing code:', pairErr.message);
                        botConnectionStatus = `Pairing wait: ${pairErr.message}. Retrying cleanly...`;
                    }
                }
            }

            // 2. Handle Connection Close & Handshake Restart (515)
            if (connection === 'close') {
                if (mySocketId !== currentSocketId) return;
                if (wsKeepAliveInterval) {
                    clearInterval(wsKeepAliveInterval);
                    wsKeepAliveInterval = null;
                }
                isConnected = false;
                isConnecting = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const reason = lastDisconnect?.error?.message || 'Unknown';
                console.log(`⚠️ Connection closed. Status: ${statusCode} (${reason})`);

                if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                    // ONLY wipe auth folder when explicitly logged out from phone (401)
                    console.log('🧹 Device logged out from phone (401). Wiping auth folder for fresh login...');
                    clearAuthFolder();
                    latestPairingCode = null;
                    latestQrDataUrl = null;
                    botConnectionStatus = 'Logged out. Ready for fresh pairing...';
                    setTimeout(() => startRadioBot(false), 3000);
                } else if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
                    // Status 515 happens right after you scan QR or enter the 8-digit code
                    console.log('🔄 Pairing handshake succeeded (515)! Reconnecting immediately to finalize login...');
                    botConnectionStatus = 'Handshake complete! Finalizing WhatsApp login...';
                    setTimeout(() => startRadioBot(false), 1000);
                } else if (statusCode === DisconnectReason.connectionReplaced || statusCode === 440) {
                    // Another instance started (e.g., during Render rolling deploy) - wait 8s before reconnecting
                    console.log('⏳ Connection replaced by newer deploy instance (440). Waiting 8s...');
                    botConnectionStatus = 'Syncing with new deploy instance...';
                    setTimeout(() => startRadioBot(false), 8000);
                } else {
                    // Network hiccup, stream error (516), or timeout (408) -> Reconnect immediately WITHOUT deleting auth folder!
                    console.log(`🔄 Auto-reconnecting preserved session (Status ${statusCode})...`);
                    botConnectionStatus = `Auto-reconnecting session (Code ${statusCode || 'network'})...`;
                    setTimeout(() => startRadioBot(false), 2500);
                }
            }

            // 3. Handle Successful Connection Open
            if (connection === 'open') {
                if (mySocketId !== currentSocketId) return;
                isConnected = true;
                isConnecting = false;
                latestPairingCode = 'CONNECTED ✅';
                latestQrDataUrl = null;
                botConnectionStatus = 'Connected & Streaming 24/7 ✅';
                console.log(`✅ WhatsApp High-Quality Radio Bot (+${pairingPhoneNumber}) is Connected!`);
                console.log(`📩 Send commands (!add, !repo, !sync, !list, !play) from +${RAW_OWNER}`);

                // Start Active WebSocket Heartbeat every 45 seconds so NAT/Render never drops the idle socket
                if (wsKeepAliveInterval) clearInterval(wsKeepAliveInterval);
                wsKeepAliveInterval = setInterval(async () => {
                    if (activeSock && isConnected) {
                        try {
                            await activeSock.sendPresenceUpdate('available');
                        } catch (e) {}
                    }
                }, 45000);
            }
        });

        // Helper function to broadcast the next song in High Quality Stereo MP3 (Supports GitHub MP3 & YouTube)
        async function broadcastNextSong(notifyJid, isSkip = false) {
            // Cancel any pending Auto-DJ timer or in-flight download when skipping/playing
            if (autoDjTimer) {
                clearTimeout(autoDjTimer);
                autoDjTimer = null;
            }
            if (currentDownloadAbort) {
                try { currentDownloadAbort(); } catch (e) {}
                currentDownloadAbort = null;
            }

            // If skipping, delete the previous audio message in WhatsApp so playback stops immediately
            if (isSkip && lastPlayedAudioKey && lastPlayedJid) {
                try {
                    await sock.sendMessage(lastPlayedJid, { delete: lastPlayedAudioKey });
                    lastPlayedAudioKey = null;
                } catch (delErr) {
                    console.log('Could not delete previous audio message on skip:', delErr.message);
                }
            }

            const destinationJid = targetGroupJid || notifyJid;
            if (requestQueue.length === 0) {
                nowPlaying = null;
                if (notifyJid) {
                    await sock.sendMessage(notifyJid, {
                        text: isSkip
                            ? '⏭️ Skipped! 📭 The queue is now empty. Send `!add <song or .mp3 url>` or `!sync` to add more tracks.'
                            : '📭 Queue finished! Send `!add <song or .mp3 url>` or `!sync` from your DM to keep the radio going.'
                    });
                }
                return;
            }

            const nextSong = requestQueue.shift();
            nowPlaying = nextSong;

            if (notifyJid) {
                await sock.sendMessage(notifyJid, {
                    text: `${isSkip ? '⏭️ *Skipped to Next Track!*\n' : ''}🎧 Broadcasting *${nextSong.title}* (${nextSong.isDirectMp3 ? 'GitHub Direct MP3' : 'HQ Stereo MP3'}) to ${targetGroupJid ? 'your bound Group' : 'this chat'}...`
                });
            }

            const tempFilePath = path.join(__dirname, `temp_${Date.now()}.mp3`);
            let isAborted = false;

            currentDownloadAbort = () => {
                isAborted = true;
                if (fs.existsSync(tempFilePath)) {
                    try { fs.unlinkSync(tempFilePath); } catch (e) {}
                }
            };

            // Helper to send the downloaded tempFilePath to WhatsApp & schedule Auto-DJ
            const sendAudioFileAndScheduleNext = async () => {
                if (isAborted) return;
                currentDownloadAbort = null;
                try {
                    if (!fs.existsSync(tempFilePath)) return;
                    const sentMsg = await sock.sendMessage(destinationJid, {
                        audio: fs.readFileSync(tempFilePath),
                        mimetype: 'audio/mpeg',
                        ptt: false, // Crystal Clear Stereo Music Player
                        fileName: `${nextSong.title}.mp3`,
                        contextInfo: {
                            externalAdReply: {
                                title: `📻 Now Playing: ${nextSong.title}`,
                                body: `High-Quality Radio • Controlled by +${RAW_OWNER}`,
                                mediaType: 2,
                                thumbnailUrl: nextSong.thumbnail,
                                sourceUrl: nextSong.url
                            }
                        }
                    });
                    if (sentMsg && sentMsg.key) {
                        lastPlayedAudioKey = sentMsg.key;
                        lastPlayedJid = destinationJid;
                    }
                } catch (sendErr) {
                    console.error('Error sending audio message:', sendErr.message);
                } finally {
                    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
                }

                if (autoDjEnabled && requestQueue.length > 0 && !isAborted) {
                    if (autoDjTimer) clearTimeout(autoDjTimer);
                    const parts = (nextSong.duration || '3:30').split(':').map(Number);
                    const seconds = parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])
                        ? (parts[0] * 60 + parts[1])
                        : 210;
                    const delayMs = Math.min(Math.max(seconds * 1000, 30000), 8 * 60 * 1000);
                    autoDjTimer = setTimeout(() => {
                        if (autoDjEnabled && requestQueue.length > 0) {
                            broadcastNextSong(OWNER_NUMBER, false);
                        }
                    }, delayMs);
                }
            };

            try {
                // CASE 1: Direct .mp3 link or GitHub Raw file
                if (nextSong.isDirectMp3) {
                    await downloadDirectMp3(nextSong.url, tempFilePath);
                    await sendAudioFileAndScheduleNext();
                    return;
                }

                // CASE 2: YouTube Stream
                const audioStream = ytdl(nextSong.url, {
                    filter: 'audioonly',
                    quality: 'highestaudio',
                    highWaterMark: 1 << 25
                });

                const writeStream = fs.createWriteStream(tempFilePath);

                currentDownloadAbort = () => {
                    isAborted = true;
                    try { audioStream.destroy(); } catch (e) {}
                    try { writeStream.destroy(); } catch (e) {}
                    if (fs.existsSync(tempFilePath)) {
                        try { fs.unlinkSync(tempFilePath); } catch (e) {}
                    }
                };

                audioStream.on('error', async (err) => {
                    if (isAborted) return;
                    console.error('Audio download error:', err.message);
                    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
                    if (notifyJid) {
                        await sock.sendMessage(notifyJid, {
                            text: `⚠️ Could not stream *${nextSong.title}* (${err.message}). Tip: Use GitHub .mp3 links (\`!add https://...song.mp3\` or \`!repo\`) for 100% reliability!`
                        });
                    }
                    if (requestQueue.length > 0) {
                        setTimeout(() => broadcastNextSong(notifyJid, false), 2000);
                    }
                });

                writeStream.on('finish', sendAudioFileAndScheduleNext);
                audioStream.pipe(writeStream);
            } catch (err) {
                if (isAborted) return;
                console.error('Broadcast setup error:', err.message);
                if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
                if (notifyJid) {
                    await sock.sendMessage(notifyJid, {
                        text: `⚠️ Failed to download *${nextSong.title}*: ${err.message}`
                    });
                }
            }
        }

        // Helper to unwrap any nested WhatsApp message (ephemeral, viewOnce, edited, etc.)
        function extractMessageText(messageObj) {
            if (!messageObj) return '';
            const inner =
                messageObj.ephemeralMessage?.message ||
                messageObj.viewOnceMessage?.message ||
                messageObj.viewOnceMessageV2?.message ||
                messageObj.documentWithCaptionMessage?.message ||
                messageObj.editedMessage?.message?.protocolMessage?.editedMessage ||
                messageObj;

            return (
                inner.conversation ||
                inner.extendedTextMessage?.text ||
                inner.imageMessage?.caption ||
                inner.videoMessage?.caption ||
                ''
            );
        }

        // Listen for commands (Supports both ! and . prefixes, and WhatsApp Business @lid JIDs)
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            for (const msg of messages) {
                if (!msg || !msg.message) continue;

                const remoteJid = msg.key.remoteJid;
                if (!remoteJid || remoteJid === 'status@broadcast') continue;

                const text = extractMessageText(msg.message).trim();
                if (!text) continue;

                const isGroup = remoteJid.endsWith('@g.us');
                const isLid = remoteJid.endsWith('@lid') || (msg.key.participant && msg.key.participant.endsWith('@lid'));
                const rawSender = isGroup ? (msg.key.participant || '') : remoteJid;
                const senderAlt = msg.key.participantAlt || msg.key.remoteJidAlt || '';

                // Log incoming message in Render console for instant debugging
                console.log(`📩 Incoming [${isGroup ? 'GROUP' : 'DM'}] from ${rawSender} (alt: ${senderAlt || 'none'}, fromMe: ${msg.key.fromMe}): "${text}"`);

                // Accept both '!' and '.' command prefixes (e.g., !add, .add, !alive, .alive)
                if (!text.startsWith('!') && !text.startsWith('.')) continue;

                const withoutPrefix = text.slice(1).trim();
                if (!withoutPrefix) continue;

                const args = withoutPrefix.split(/\s+/);
                const cmd = '!' + args.shift().toLowerCase();
                const query = args.join(' ');

                // WhatsApp Business uses @lid for DMs! Allow Owner Number, @lid DMs, or self-messages
                const isOwner =
                    msg.key.fromMe ||
                    rawSender.includes(RAW_OWNER) ||
                    remoteJid.includes(RAW_OWNER) ||
                    senderAlt.includes(RAW_OWNER) ||
                    (!isGroup && isLid) ||
                    !isGroup; // Any direct message to the bot can control or test it

                try {
                    // 0. Quick Status / Alive Check (!alive, .alive, !ping, !help)
                    if (cmd === '!alive' || cmd === '!ping' || cmd === '!help') {
                        await sock.sendMessage(remoteJid, {
                            text: `📻 *WA RadioBot v2.4 (Skip + GitHub MP3 + Anti-Drop) is ONLINE!* ✅\n\n` +
                                  `👑 *Controller:* +${RAW_OWNER}\n` +
                                  `🤖 *Bot Line:* +${pairingPhoneNumber}\n` +
                                  `🎶 *Now Playing:* ${nowPlaying ? nowPlaying.title : 'Nothing playing'}\n` +
                                  `🎵 *Songs in Queue:* ${requestQueue.length}\n` +
                                  `📢 *Bound Group:* ${targetGroupJid ? 'Linked ✅' : 'Not bound yet (Send !bind in group)'}\n\n` +
                                  `*Commands (both ! and . work):*\n` +
                                  `• \`!add <song name or .mp3 link>\`\n` +
                                  `• \`!repo <github repo/folder url>\` (Loads all .mp3s!)\n` +
                                  `• \`!sync\` (Syncs .mp3s from ${DEFAULT_GITHUB_REPO})\n` +
                                  `• \`!play\` (Start playing queue)\n` +
                                  `• \`!skip\` or \`!next\` (Stop current & play next song)\n` +
                                  `• \`!stop\` (Stop current playback & clear timer)\n` +
                                  `• \`!list\` (View queue)\n` +
                                  `• \`!top <number>\` / \`!remove <number>\`\n` +
                                  `• \`!autodj\`\n` +
                                  `• \`!bind\` (send inside your WhatsApp group)`
                        }, { quoted: msg });
                        continue;
                    }

                    if (cmd === '!bind' && isGroup) {
                        targetGroupJid = remoteJid;
                        await sock.sendMessage(remoteJid, {
                            text: `📻 *RadioBot (+${pairingPhoneNumber}) Linked!* High-quality requested songs & GitHub MP3s will now play in this group.\n\n👑 Admin (+${RAW_OWNER}) can manage the playlist privately via Personal DM!`
                        }, { quoted: msg });
                        continue;
                    }

                    if (!isOwner) continue;

                    // NEW: !repo or !sync -> Fetch all .mp3 files from a GitHub repo or folder URL
                    if (cmd === '!repo' || cmd === '!sync' || cmd === '!github') {
                        const targetRepoUrl = query || DEFAULT_GITHUB_REPO;
                        await sock.sendMessage(remoteJid, {
                            text: `🔄 Scanning GitHub repository for \`.mp3\` tracks:\n*${targetRepoUrl}*...`
                        }, { quoted: msg });

                        try {
                            const mp3Tracks = await fetchGitHubRepoMp3s(targetRepoUrl);
                            if (mp3Tracks.length === 0) {
                                await sock.sendMessage(remoteJid, {
                                    text: `📭 No \`.mp3\` files found in *${targetRepoUrl}*.\n\n*Tip:* Upload \`.mp3\` files to your GitHub repo (or a subfolder like \`https://github.com/BUSA2023/Wabot/tree/main/songs\`) and run \`!repo <url>\` again!`
                                }, { quoted: msg });
                                continue;
                            }

                            requestQueue.push(...mp3Tracks);
                            const previewList = mp3Tracks.slice(0, 10).map((t, i) => `${i + 1}. 🎵 ${t.title}`).join('\n');
                            await sock.sendMessage(remoteJid, {
                                text: `✅ *Synced ${mp3Tracks.length} MP3 Song(s) from GitHub!*\n\n${previewList}${mp3Tracks.length > 10 ? `\n...and ${mp3Tracks.length - 10} more!` : ''}\n\n_Type !play to start broadcasting or !list to view the queue._`
                            }, { quoted: msg });
                        } catch (repoErr) {
                            await sock.sendMessage(remoteJid, {
                                text: `❌ Could not load GitHub repo: ${repoErr.message}`
                            }, { quoted: msg });
                        }
                        continue;
                    }

                    if (cmd === '!add') {
                        if (!query) {
                            await sock.sendMessage(remoteJid, {
                                text: '⚠️ Usage:\n• `!add https://github.com/.../song.mp3` (Direct MP3)\n• `!add https://github.com/user/repo` (All Repo MP3s)\n• `!add Blinding Lights` (YouTube Search)'
                            }, { quoted: msg });
                            continue;
                        }

                        // 1. Check if the user passed a GitHub Repository/Folder link to !add
                        if (/^https?:\/\/(www\.)?github\.com\/[^/]+\/[^/]+(\/tree\/.*)?$/i.test(query.trim()) && !/\.(mp3|m4a|ogg|wav)(\?.*)?$/i.test(query.trim())) {
                            await sock.sendMessage(remoteJid, { text: `🔄 Scanning GitHub repository for MP3 files: *${query}*...` }, { quoted: msg });
                            const mp3Tracks = await fetchGitHubRepoMp3s(query.trim());
                            if (mp3Tracks.length === 0) {
                                await sock.sendMessage(remoteJid, { text: '📭 No `.mp3` files found in that GitHub repository folder.' }, { quoted: msg });
                                continue;
                            }
                            requestQueue.push(...mp3Tracks);
                            await sock.sendMessage(remoteJid, {
                                text: `✅ *Added ${mp3Tracks.length} MP3 track(s) from GitHub Repo!*\nType \`!list\` to inspect or \`!play\` to broadcast.`
                            }, { quoted: msg });
                            continue;
                        }

                        // 2. Check if the user passed a Direct .mp3 / GitHub file link
                        const normalizedUrl = normalizeGitHubMp3Url(query);
                        if (/^https?:\/\/.+\.(mp3|m4a|ogg|wav)(\?.*)?$/i.test(normalizedUrl) || normalizedUrl.includes('raw.githubusercontent.com')) {
                            const rawFileName = normalizedUrl.split('/').pop().split('?')[0];
                            const cleanTitle = decodeURIComponent(rawFileName.replace(/\.(mp3|m4a|ogg|wav)$/i, '').replace(/[-_]/g, ' ')) || 'GitHub MP3 Track';

                            const songItem = {
                                title: cleanTitle,
                                url: normalizedUrl,
                                duration: 'Direct MP3',
                                thumbnail: 'https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png',
                                author: 'GitHub MP3',
                                isDirectMp3: true
                            };

                            requestQueue.push(songItem);
                            await sock.sendMessage(remoteJid, {
                                text: `✅ *Added Direct MP3 to Queue (#${requestQueue.length})*\n🎵 *${songItem.title}*\n🔗 Source: GitHub / Direct MP3\n\n_Type !play to broadcast immediately._`
                            }, { quoted: msg });
                            continue;
                        }

                        // 3. Otherwise search YouTube
                        await sock.sendMessage(remoteJid, { text: `🔎 Searching high-quality audio for: *${query}*...` }, { quoted: msg });
                        const searchResult = await yts(query);
                        const video = searchResult.videos && searchResult.videos[0];

                        if (!video) {
                            await sock.sendMessage(remoteJid, { text: '❌ Could not find that song. Try another keyword.' }, { quoted: msg });
                            continue;
                        }

                        const songItem = {
                            title: video.title,
                            url: video.url,
                            duration: video.timestamp || '3:30',
                            thumbnail: video.thumbnail,
                            author: video.author?.name || 'Artist'
                        };

                        requestQueue.push(songItem);

                        await sock.sendMessage(remoteJid, {
                            text: `✅ *Added to Radio Queue (#${requestQueue.length})*\n🎵 *${songItem.title}*\n⏱️ Duration: ${songItem.duration}\n\n_Type !list to view or !play to broadcast immediately._`
                        }, { quoted: msg });
                    }
                    else if (cmd === '!list' || cmd === '!queue') {
                        if (requestQueue.length === 0) {
                            await sock.sendMessage(remoteJid, {
                                text: `${nowPlaying ? `🎶 *Now Playing:* ${nowPlaying.title}\n\n` : ''}📭 Your upcoming queue is empty. Use \`!add <song>\` or \`!sync\` to add tracks.`
                            }, { quoted: msg });
                            continue;
                        }

                        const listString = requestQueue
                            .map((s, idx) => `*${idx + 1}.* 🎵 ${s.title} (${s.duration})`)
                            .join('\n');

                        await sock.sendMessage(remoteJid, {
                            text: `${nowPlaying ? `🎶 *Now Playing:* ${nowPlaying.title}\n\n` : ''}📻 *Your Personal Request List:*\n\n${listString}\n\n*Controls:*\n• \`!skip\` or \`!next\` (Skip current song)\n• \`!stop\` (Stop current song)\n• \`!remove <number>\` / \`!top <number>\`\n• \`!autodj\` (Continuous radio: ${autoDjEnabled ? 'ON' : 'OFF'})\n• \`!play\` (Broadcast now)`
                        }, { quoted: msg });
                    }
                    else if (cmd === '!remove') {
                        const index = parseInt(query, 10) - 1;
                        if (isNaN(index) || index < 0 || index >= requestQueue.length) {
                            await sock.sendMessage(remoteJid, { text: '⚠️ Invalid song number. Check `!list` first.' }, { quoted: msg });
                            continue;
                        }
                        const removed = requestQueue.splice(index, 1)[0];
                        await sock.sendMessage(remoteJid, { text: `🗑️ Removed *${removed.title}* from your request list.` }, { quoted: msg });
                    }
                    else if (cmd === '!top') {
                        const index = parseInt(query, 10) - 1;
                        if (isNaN(index) || index <= 0 || index >= requestQueue.length) {
                            await sock.sendMessage(remoteJid, { text: '⚠️ Enter a valid song number (2 or higher) to move to #1.' }, { quoted: msg });
                            continue;
                        }
                        const [promoted] = requestQueue.splice(index, 1);
                        requestQueue.unshift(promoted);
                        await sock.sendMessage(remoteJid, { text: `⬆️ Moved *${promoted.title}* to #1 in the queue!` }, { quoted: msg });
                    }
                    else if (cmd === '!autodj') {
                        autoDjEnabled = !autoDjEnabled;
                        await sock.sendMessage(remoteJid, {
                            text: `📻 *Auto-DJ Continuous Radio Mode:* ${autoDjEnabled ? '✅ ENABLED (Songs will play back-to-back automatically)' : '⏸️ DISABLED (Use !play manually)'}`
                        }, { quoted: msg });
                    }
                    else if (cmd === '!skip' || cmd === '!next') {
                        const skippedTitle = nowPlaying ? nowPlaying.title : null;
                        if (skippedTitle) {
                            await sock.sendMessage(remoteJid, {
                                text: `⏭️ Skipping *${skippedTitle}*...`
                            }, { quoted: msg });
                        }
                        await broadcastNextSong(remoteJid, true);
                    }
                    else if (cmd === '!stop') {
                        if (autoDjTimer) {
                            clearTimeout(autoDjTimer);
                            autoDjTimer = null;
                        }
                        if (currentDownloadAbort) {
                            try { currentDownloadAbort(); } catch (e) {}
                            currentDownloadAbort = null;
                        }
                        if (lastPlayedAudioKey && lastPlayedJid) {
                            try {
                                await sock.sendMessage(lastPlayedJid, { delete: lastPlayedAudioKey });
                                lastPlayedAudioKey = null;
                            } catch (e) {}
                        }
                        const stoppedTitle = nowPlaying ? nowPlaying.title : 'current playback';
                        nowPlaying = null;
                        await sock.sendMessage(remoteJid, {
                            text: `⏹️ Stopped *${stoppedTitle}* and removed the audio player from chat. Send \`!play\` or \`!skip\` when ready to resume.`
                        }, { quoted: msg });
                    }
                    else if (cmd === '!play' || cmd === '!playnext') {
                        await broadcastNextSong(remoteJid, false);
                    }
                } catch (err) {
                    console.error('Bot Command Error:', err);
                    await sock.sendMessage(remoteJid, { text: '⚠️ Error processing command: ' + err.message });
                }
            }
        });
    } catch (initErr) {
        isConnecting = false;
        console.error('Bot initialization error, retrying in 5s:', initErr.message);
        setTimeout(() => startRadioBot(false), 5000);
    }
}

process.on('uncaughtException', (err) => {
    console.error('Caught exception (Server kept alive):', err.message);
});
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection (Server kept alive):', reason);
});

startRadioBot(false);
