/**
 * ============================================================================
 * WHATSAPP HIGH-QUALITY RADIO & PERSONAL QUEUE BOT (24/7 CLOUD EDITION)
 * ============================================================================
 * Pre-Configured Numbers & Live Render Server:
 * - Live URL:     https://wabot-4nbu.onrender.com
 * - Owner Number: +91 9539601481 (Controls Queue via DM)
 * - Bot Number:   +91 9656977828 (8-Digit Pairing Login)
 * ============================================================================
 */

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const yts = require('yt-search');
const ytdl = require('@distube/ytdl-core');
const fs = require('fs');
const path = require('path');
const https = require('https');

// ============================================================================
// CONFIGURATION (PRE-CONFIGURED FOR YOUR NUMBERS & RENDER URL)
// ============================================================================
const PORT = process.env.PORT || 10000;

// Your Personal WhatsApp Number (Controls the Queue Privately via DM)
const RAW_OWNER = (process.env.OWNER_NUMBER || '919539601481').replace(/[^0-9]/g, '');
const OWNER_NUMBER = RAW_OWNER + '@s.whatsapp.net';

// Your Bot WhatsApp Number (Used for 8-Digit Cloud Pairing Code Login)
const BOT_NUMBER = (process.env.BOT_NUMBER || '919656977828').replace(/[^0-9]/g, '');

// Your Live Render URL for automatic 24/7 self-pinging
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || 'https://wabot-4nbu.onrender.com';

const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');

// In-Memory State
let requestQueue = [];
let targetGroupJid = null;
let nowPlaying = null;
let autoDjEnabled = true;
let latestPairingCode = null;
let latestQrString = null;
let botConnectionStatus = 'Starting up...';
let autoDjTimer = null;
let activeSock = null;
let isConnected = false;

// Helper to wipe incomplete pairing sessions so new codes never fail
function clearAuthFolder() {
    try {
        if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        }
    } catch (e) {
        console.error('Could not clear auth folder:', e.message);
    }
}

// ============================================================================
// 1. FREE HOSTING 24/7 KEEP-ALIVE & LIVE PAIRING WEB SERVER
// ============================================================================
const app = express();
app.use(express.json());

// Interactive Status & Instant Pairing Dashboard
app.get('/', (req, res) => {
    res.status(200).send(`
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>WA RadioBot Live Server</title>
        <style>
            body { font-family: system-ui, sans-serif; background: #0b141a; color: #e9edef; padding: 20px; max-width: 620px; margin: 0 auto; }
            .card { background: #1f2c34; border-radius: 16px; padding: 22px; margin-bottom: 16px; border: 1px solid #2a3942; }
            .code-box { font-size: 32px; font-weight: 800; letter-spacing: 4px; color: #00a884; background: #111b21; padding: 16px; border-radius: 12px; text-align: center; margin: 14px 0; border: 2px dashed #00a884; }
            .btn { display: inline-block; background: #00a884; color: #0b141a; font-weight: 700; text-decoration: none; padding: 12px 20px; border-radius: 10px; margin-top: 8px; }
            .status { color: #00a884; font-weight: bold; }
            code { background: #111b21; padding: 2px 6px; border-radius: 4px; color: #53bdeb; }
        </style>
    </head>
    <body>
        <div class="card">
            <h2>📻 WhatsApp RadioBot (+${BOT_NUMBER})</h2>
            <p><strong>Status:</strong> <span class="status">${botConnectionStatus}</span></p>
            <p><strong>Owner DM Controller:</strong> +${RAW_OWNER}</p>
            <hr style="border-color:#2a3942; margin: 16px 0;">
            ${isConnected ? `
                <h3 style="color:#00a884;">✅ Bot is Linked & Online 24/7!</h3>
                <p>Send <code>!add Song Name</code> or <code>!list</code> to <strong>+${BOT_NUMBER}</strong> from your personal number (<strong>+${RAW_OWNER}</strong>).</p>
            ` : `
                <h3>🔑 Step 1: Link Your Bot Number (+${BOT_NUMBER})</h3>
                <p>If you get "Try again later", please wait 2 minutes, then click below to generate a fresh pairing code:</p>
                <div class="code-box">${latestPairingCode || 'CLICK BUTTON BELOW'}</div>
                <div style="text-align:center;">
                    <a class="btn" href="/pair">🔄 Generate Fresh 8-Digit Code Now</a>
                </div>
                <p style="font-size:13px; color:#8696a0; margin-top:16px;">
                    <strong>Alternative:</strong> <a href="/qr" style="color:#53bdeb;">Click here to view a Live QR Code</a> and scan it normally!
                </p>
            `}
        </div>
    </body>
    </html>
    `);
});

// Fresh On-Demand 8-Digit Pairing Code Generator
app.get('/pair', async (req, res) => {
    if (isConnected) {
        return res.redirect('/');
    }
    try {
        clearAuthFolder();
        latestPairingCode = 'GENERATING...';
        await startRadioBot(true);
        await new Promise(resolve => setTimeout(resolve, 6000));
        res.redirect('/');
    } catch (err) {
        res.status(500).send('Error generating code: ' + err.message);
    }
});

// Live QR Code Web Page
app.get('/qr', (req, res) => {
    if (isConnected) {
        return res.send('<h2>✅ Bot is already connected!</h2><a href="/">Back to Dashboard</a>');
    }
    const qrImageUrl = latestQrString
        ? `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(latestQrString)}`
        : null;

    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta http-equiv="refresh" content="8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Scan WhatsApp QR Code</title>
        <style>
            body { font-family: system-ui, sans-serif; background: #0b141a; color: #fff; text-align: center; padding: 30px; }
            .box { background: #1f2c34; padding: 24px; border-radius: 16px; display: inline-block; max-width: 380px; }
            img { background: white; padding: 12px; border-radius: 12px; margin: 16px 0; }
            a { color: #00a884; }
        </style>
    </head>
    <body>
        <div class="box">
            <h2>📷 Scan QR with +${BOT_NUMBER}</h2>
            <p style="font-size:14px; color:#8696a0;">Open WhatsApp on +${BOT_NUMBER} &rarr; Linked Devices &rarr; Link a Device &rarr; Scan QR</p>
            ${qrImageUrl
                ? `<img src="${qrImageUrl}" width="280" height="280" alt="WhatsApp QR" />`
                : `<p>⏳ Generating fresh QR code... (Page auto-refreshes in 8s)</p>`
            }
            <p><a href="/">⬅ Back to Dashboard</a></p>
        </div>
    </body>
    </html>
    `);
});

app.get('/ping', (req, res) => {
    res.status(200).send('PONG - RadioBot Awake 24/7');
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Free-Hosting 24/7 Keep-Alive & Radio Server running on port ${PORT}`);
    console.log(`👑 Owner Number configured: +${RAW_OWNER}`);
    console.log(`🤖 Bot Number configured:   +${BOT_NUMBER}`);

    if (RENDER_EXTERNAL_URL && RENDER_EXTERNAL_URL.startsWith('https://')) {
        setInterval(() => {
            https.get(`${RENDER_EXTERNAL_URL.replace(/\/+$/, '')}/ping`, (res) => {
                console.log(`⚡ 24/7 Self-Ping Status: ${res.statusCode}`);
            }).on('error', () => {});
        }, 10 * 60 * 1000);
    }
});

// ============================================================================
// 2. WHATSAPP BOT CORE LOGIC
// ============================================================================
const logger = pino({ level: 'silent' });
let isStarting = false;

async function startRadioBot(forceFreshCode = false) {
    if (isStarting && !forceFreshCode) return;
    isStarting = true;

    try {
        if (activeSock) {
            try { activeSock.ev.removeAllListeners(); activeSock.end(undefined); } catch (e) {}
            activeSock = null;
        }

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            logger,
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            browser: ['Ubuntu', 'Chrome', '20.0.04'],
            markOnlineOnConnect: true,
            syncFullHistory: false,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 15000
        });

        activeSock = sock;

        // Request pairing code with a safer 5-second delay to let WebSocket handshake complete
        if (!sock.authState.creds.registered && BOT_NUMBER) {
            setTimeout(async () => {
                try {
                    if (isConnected || sock.authState.creds.registered) return;
                    const cleanNumber = BOT_NUMBER.replace(/[^0-9]/g, '');
                    const code = await sock.requestPairingCode(cleanNumber);
                    latestPairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
                    botConnectionStatus = `Waiting for Pairing Code (${latestPairingCode}) on +${cleanNumber}`;
                    console.log('\n============================================================');
                    console.log(`🔑 FRESH 8-DIGIT PAIRING CODE FOR +${cleanNumber}: ${latestPairingCode}`);
                    console.log(`⏰ ENTER WITHIN 45 SECONDS OR VISIT: ${RENDER_EXTERNAL_URL}/pair`);
                    console.log('============================================================\n');
                } catch (err) {
                    console.error('Pairing code generation error:', err.message);
                }
            }, 5000);
        }

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                latestQrString = qr;
            }

            if (connection === 'close') {
                isConnected = false;
                isStarting = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`Connection closed (Status: ${statusCode}).`);

                if (!sock.authState.creds.registered || statusCode === DisconnectReason.loggedOut) {
                    console.log('Cleaning partial pairing state so a fresh code can be generated...');
                    clearAuthFolder();
                }

                botConnectionStatus = 'Reconnecting & refreshing code...';
                setTimeout(() => startRadioBot(false), 5000);
            } else if (connection === 'open') {
                isConnected = true;
                isStarting = false;
                latestPairingCode = 'CONNECTED ✅';
                latestQrString = null;
                botConnectionStatus = 'Connected & Ready 24/7 ✅';
                console.log(`✅ WhatsApp High-Quality Radio Bot (+${BOT_NUMBER}) is Connected!`);
            }
        });

        async function broadcastNextSong(notifyJid) {
            const destinationJid = targetGroupJid || notifyJid;
            if (requestQueue.length === 0) {
                nowPlaying = null;
                if (notifyJid) {
                    await sock.sendMessage(notifyJid, {
                        text: '📭 Queue finished! Send `!add <song name>` from your personal DM to keep the radio going.'
                    });
                }
                return;
            }

            const nextSong = requestQueue.shift();
            nowPlaying = nextSong;

            if (notifyJid) {
                await sock.sendMessage(notifyJid, {
                    text: `🎧 Broadcasting *${nextSong.title}* in High-Quality Stereo MP3...`
                });
            }

            const tempFilePath = path.join(__dirname, `temp_${Date.now()}.mp3`);

            try {
                const audioStream = ytdl(nextSong.url, {
                    filter: 'audioonly',
                    quality: 'highestaudio',
                    highWaterMark: 1 << 25
                });

                const writeStream = fs.createWriteStream(tempFilePath);

                audioStream.on('error', async (err) => {
                    console.error('Audio download error:', err.message);
                    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
                    if (notifyJid) {
                        await sock.sendMessage(notifyJid, { text: `⚠️ Could not stream *${nextSong.title}* (${err.message}). Skipping...` });
                    }
                    if (requestQueue.length > 0) {
                        setTimeout(() => broadcastNextSong(notifyJid), 2000);
                    }
                });

                writeStream.on('finish', async () => {
                    try {
                        if (!fs.existsSync(tempFilePath)) return;
                        await sock.sendMessage(destinationJid, {
                            audio: fs.readFileSync(tempFilePath),
                            mimetype: 'audio/mpeg',
                            ptt: false,
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
                    } catch (sendErr) {
                        console.error('Error sending audio message:', sendErr.message);
                    } finally {
                        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
                    }

                    if (autoDjEnabled && requestQueue.length > 0) {
                        if (autoDjTimer) clearTimeout(autoDjTimer);
                        const parts = (nextSong.duration || '3:30').split(':').map(Number);
                        const seconds = parts.length === 2 ? (parts[0] * 60 + parts[1]) : 210;
                        const delayMs = Math.min(Math.max(seconds * 1000, 30000), 8 * 60 * 1000);
                        autoDjTimer = setTimeout(() => {
                            if (autoDjEnabled && requestQueue.length > 0) {
                                broadcastNextSong(OWNER_NUMBER);
                            }
                        }, delayMs);
                    }
                });

                audioStream.pipe(writeStream);
            } catch (err) {
                console.error('Broadcast setup error:', err.message);
                if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
            }
        }

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            const msg = messages[0];
            if (!msg.message) return;

            const remoteJid = msg.key.remoteJid;
            if (!remoteJid) return;

            const isGroup = remoteJid.endsWith('@g.us');
            const rawSender = isGroup ? (msg.key.participant || '') : remoteJid;

            const text =
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                msg.message.imageMessage?.caption ||
                '';

            if (!text.startsWith('!')) return;

            const args = text.trim().split(/\s+/);
            const cmd = args.shift().toLowerCase();
            const query = args.join(' ');

            const isOwner = msg.key.fromMe || rawSender.includes(RAW_OWNER) || remoteJid.includes(RAW_OWNER);

            try {
                if (cmd === '!bind' && isGroup && isOwner) {
                    targetGroupJid = remoteJid;
                    await sock.sendMessage(remoteJid, {
                        text: `📻 *RadioBot (+${BOT_NUMBER}) Linked!* Requested songs will now play in this group.`
                    });
                    return;
                }

                if (!isOwner) return;

                if (cmd === '!add') {
                    if (!query) {
                        await sock.sendMessage(remoteJid, { text: '⚠️ Usage: `!add <Song Name>`' });
                        return;
                    }

                    await sock.sendMessage(remoteJid, { text: `🔎 Searching audio for: *${query}*...` });
                    const searchResult = await yts(query);
                    const video = searchResult.videos && searchResult.videos[0];

                    if (!video) {
                        await sock.sendMessage(remoteJid, { text: '❌ Could not find that song.' });
                        return;
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
                        text: `✅ *Added to Queue (#${requestQueue.length})*\n🎵 *${songItem.title}*`
                    });
                }
                else if (cmd === '!list' || cmd === '!queue') {
                    if (requestQueue.length === 0) {
                        await sock.sendMessage(remoteJid, { text: '📭 Request queue is empty. Use `!add <song>`.' });
                        return;
                    }

                    const listString = requestQueue
                        .map((s, idx) => `*${idx + 1}.* 🎵 ${s.title} (${s.duration})`)
                        .join('\n');

                    await sock.sendMessage(remoteJid, {
                        text: `📻 *Your Request List:*\n\n${listString}`
                    });
                }
                else if (cmd === '!remove') {
                    const index = parseInt(query, 10) - 1;
                    if (isNaN(index) || index < 0 || index >= requestQueue.length) {
                        await sock.sendMessage(remoteJid, { text: '⚠️ Invalid number.' });
                        return;
                    }
                    const removed = requestQueue.splice(index, 1)[0];
                    await sock.sendMessage(remoteJid, { text: `🗑️ Removed *${removed.title}*.` });
                }
                else if (cmd === '!top') {
                    const index = parseInt(query, 10) - 1;
                    if (isNaN(index) || index <= 0 || index >= requestQueue.length) {
                        await sock.sendMessage(remoteJid, { text: '⚠️ Enter a valid number (2 or higher).' });
                        return;
                    }
                    const [promoted] = requestQueue.splice(index, 1);
                    requestQueue.unshift(promoted);
                    await sock.sendMessage(remoteJid, { text: `⬆️ Moved *${promoted.title}* to #1!` });
                }
                else if (cmd === '!autodj') {
                    autoDjEnabled = !autoDjEnabled;
                    await sock.sendMessage(remoteJid, {
                        text: `📻 *Auto-DJ Mode:* ${autoDjEnabled ? '✅ ENABLED' : '⏸️ DISABLED'}`
                    });
                }
                else if (cmd === '!play' || cmd === '!playnext') {
                    await broadcastNextSong(remoteJid);
                }
            } catch (err) {
                console.error('Bot Command Error:', err);
            }
        });
    } catch (initErr) {
        isStarting = false;
        console.error('Bot initialization error:', initErr.message);
        setTimeout(() => startRadioBot(false), 5000);
    }
}

process.on('uncaughtException', (err) => { console.error('Caught exception:', err.message); });
process.on('unhandledRejection', (reason) => { console.error('Unhandled rejection:', reason); });

startRadioBot(false);
