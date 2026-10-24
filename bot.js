/**
 * ============================================================================
 * WHATSAPP HIGH-QUALITY RADIO & PERSONAL QUEUE BOT (24/7 CLOUD EDITION)
 * ============================================================================
 * Pre-Configured Numbers:
 * - Owner Number (Controls Queue via DM): +91 9539601481
 * - Bot Number   (8-Digit Pairing Login): +91 9656977828
 *
 * Features:
 * 1. Manage the song request list privately from your Personal DM (!add, !remove, !top, !list).
 * 2. Sends crystal-clear High-Quality Stereo MP3 audio (ptt: false) to your Group,
 *    avoiding WhatsApp's muffled voice-note compression.
 * 3. Includes an Express Web Radio & Keep-Alive Server so you can host it 100% FREE
 *    24/7 on Render.com, Koyeb, or Android Termux.
 * ============================================================================
 */

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const express = require('express');
const yts = require('yt-search');
const ytdl = require('@distube/ytdl-core');
const fs = require('fs');
const path = require('path');
const https = require('https');

// ============================================================================
// CONFIGURATION (PRE-CONFIGURED FOR YOUR NUMBERS)
// ============================================================================
const PORT = process.env.PORT || 3000;

// Your Personal WhatsApp Number (Controls the Queue Privately via DM)
const RAW_OWNER = (process.env.OWNER_NUMBER || '919539601481').replace(/[^0-9]/g, '');
const OWNER_NUMBER = RAW_OWNER + '@s.whatsapp.net';

// Your Bot WhatsApp Number (Used for 8-Digit Cloud Pairing Code Login)
const BOT_NUMBER = (process.env.BOT_NUMBER || '919656977828').replace(/[^0-9]/g, '');

// Optional: Your Render/Koyeb App URL for built-in 24/7 self-pinging
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || '';

// In-Memory State for Personal Request Queue & Active Group
let requestQueue = [];
let targetGroupJid = null; // Set automatically when you type !bind inside any group
let nowPlaying = null;
let autoDjEnabled = true;  // Automatically plays next song in queue like a real radio
let latestPairingCode = null;
let botConnectionStatus = 'Starting up...';
let autoDjTimer = null;

// ============================================================================
// 1. FREE HOSTING 24/7 KEEP-ALIVE & LIVE WEB RADIO SERVER
// ============================================================================
const app = express();
app.use(express.json());

// Main Status & Cloud Pairing Code Dashboard
app.get('/', (req, res) => {
    res.status(200).json({
        status: 'Online 24/7',
        whatsappConnection: botConnectionStatus,
        ownerAdminNumber: '+' + RAW_OWNER,
        botAccountNumber: '+' + BOT_NUMBER,
        loginPairingCode: latestPairingCode || 'Generating 8-digit code... Refresh in 5 seconds',
        howToLinkBot: `Open WhatsApp on +${BOT_NUMBER} -> Linked Devices -> Link a Device -> Link with phone number instead -> Enter loginPairingCode`,
        autoDjRadioMode: autoDjEnabled ? 'ON (Continuous Radio)' : 'OFF (Manual !play)',
        nowPlaying: nowPlaying ? nowPlaying.title : 'Idle',
        queuedSongsCount: requestQueue.length,
        queuedSongs: requestQueue.map((s, i) => `${i + 1}. ${s.title} (${s.duration})`),
        targetGroup: targetGroupJid || `Not bound yet (Send !bind inside your group from +${RAW_OWNER})`
    });
});

// Lightweight 24/7 Wake-Up Endpoint for Cron-job.org / UptimeRobot
app.get('/ping', (req, res) => {
    res.status(200).send('PONG - RadioBot Awake 24/7');
});

// Stream current song in high quality to any browser if group members want continuous web radio
app.get('/stream', (req, res) => {
    if (!nowPlaying || !nowPlaying.url) {
        return res.status(404).send('No song is currently active on the radio.');
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    const stream = ytdl(nowPlaying.url, {
        filter: 'audioonly',
        quality: 'highestaudio',
        highWaterMark: 1 << 25
    });
    stream.on('error', (err) => {
        console.error('Web stream error:', err.message);
        if (!res.headersSent) res.status(500).send('Stream error');
    });
    stream.pipe(res);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Free-Hosting 24/7 Keep-Alive & Radio Server running on port ${PORT}`);
    console.log(`👑 Owner Number configured: +${RAW_OWNER}`);
    console.log(`🤖 Bot Number configured:   +${BOT_NUMBER}`);

    // Built-in Self-Ping every 10 minutes if hosted on Render
    if (RENDER_EXTERNAL_URL && RENDER_EXTERNAL_URL.startsWith('https://')) {
        setInterval(() => {
            https.get(`${RENDER_EXTERNAL_URL.replace(/\/+$/, '')}/ping`, (res) => {
                console.log(`⚡ 24/7 Self-Ping Status: ${res.statusCode}`);
            }).on('error', () => {});
        }, 10 * 60 * 1000);
    }
});

// ============================================================================
// 2. WHATSAPP BOT CORE LOGIC (BAILEYS WITH 8-DIGIT CLOUD PAIRING)
// ============================================================================
const logger = pino({ level: 'silent' });

async function startRadioBot() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            logger,
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            browser: Browsers.ubuntu('Chrome'),
            markOnlineOnConnect: true,
            generateHighQualityLinkPreview: true
        });

        // Automatically generate an 8-digit Pairing Code for 919656977828 if not logged in yet
        if (!sock.authState.creds.registered && BOT_NUMBER) {
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(BOT_NUMBER);
                    latestPairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
                    botConnectionStatus = `Waiting for Pairing Code on +${BOT_NUMBER}`;
                    console.log('\n============================================================');
                    console.log(`🔑 8-DIGIT WHATSAPP PAIRING CODE FOR +${BOT_NUMBER}: ${latestPairingCode}`);
                    console.log(`👉 Open WhatsApp on +${BOT_NUMBER} -> Linked Devices -> Link with phone number`);
                    console.log('============================================================\n');
                } catch (err) {
                    console.error('Pairing code request error:', err.message);
                }
            }, 5000);
        }

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr && !BOT_NUMBER) {
                qrcode.generate(qr, { small: true });
            }
            if (connection === 'close') {
                botConnectionStatus = 'Reconnecting...';
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`Connection closed (Status: ${statusCode}). Reconnecting:`, shouldReconnect);
                if (shouldReconnect) {
                    setTimeout(startRadioBot, 4000);
                } else {
                    console.log('Session logged out. Delete ./auth_info_baileys folder to re-pair.');
                }
            } else if (connection === 'open') {
                latestPairingCode = 'CONNECTED ✅';
                botConnectionStatus = 'Connected & Ready 24/7 ✅';
                console.log(`✅ WhatsApp High-Quality Radio Bot (+${BOT_NUMBER}) is Connected!`);
                console.log(`📩 Send commands (!add, !list, !remove, !top, !play) from +${RAW_OWNER}`);
            }
        });

        // Helper function to broadcast the next song in High Quality Stereo MP3
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
                    text: `🎧 Broadcasting *${nextSong.title}* in High-Quality Stereo MP3 to ${targetGroupJid ? 'your bound Group' : 'this chat'}...`
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
                        await sock.sendMessage(notifyJid, {
                            text: `⚠️ Could not stream *${nextSong.title}* (${err.message}). Skipping to next song...`
                        });
                    }
                    if (requestQueue.length > 0) {
                        setTimeout(() => broadcastNextSong(notifyJid), 2000);
                    }
                });

                writeStream.on('finish', async () => {
                    try {
                        if (!fs.existsSync(tempFilePath)) return;
                        // Send as High-Quality Stereo Audio (ptt: false prevents voice-note compression!)
                        await sock.sendMessage(destinationJid, {
                            audio: fs.readFileSync(tempFilePath),
                            mimetype: 'audio/mpeg',
                            ptt: false, // FALSE = Crystal Clear Stereo Music Player, TRUE = Muffled Voice Note
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

                    // If Auto-DJ mode is ON and more songs are waiting, schedule the next track automatically
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

        // Listen for commands
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            const msg = messages[0];
            if (!msg.message) return;

            const remoteJid = msg.key.remoteJid;
            if (!remoteJid) return;

            const isGroup = remoteJid.endsWith('@g.us');
            const rawSender = isGroup ? (msg.key.participant || '') : remoteJid;

            // Extract plain text message across all message types
            const text =
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                msg.message.imageMessage?.caption ||
                '';

            if (!text.startsWith('!')) return;

            const args = text.trim().split(/\s+/);
            const cmd = args.shift().toLowerCase();
            const query = args.join(' ');

            // Verify if command is from Owner (919539601481) or sent from the bot's own linked session
            const isOwner = msg.key.fromMe || rawSender.includes(RAW_OWNER) || remoteJid.includes(RAW_OWNER);

            try {
                // ----------------------------------------------------------------
                // COMMAND: !bind (Run inside the Group to link it to your DM queue)
                // ----------------------------------------------------------------
                if (cmd === '!bind' && isGroup && isOwner) {
                    targetGroupJid = remoteJid;
                    await sock.sendMessage(remoteJid, {
                        text: `📻 *RadioBot (+${BOT_NUMBER}) Linked!* High-quality requested songs will now play in this group.\n\n👑 Admin (+${RAW_OWNER}) can manage the playlist privately via Personal DM!`
                    });
                    return;
                }

                // ----------------------------------------------------------------
                // PERSONAL DM QUEUE MANAGEMENT COMMANDS (Only 9539601481 can edit)
                // ----------------------------------------------------------------
                if (!isOwner) return;

                // 1. Add a song to the request list: !add <song name>
                if (cmd === '!add') {
                    if (!query) {
                        await sock.sendMessage(remoteJid, { text: '⚠️ Usage: `!add <Song Name or Artist>`' });
                        return;
                    }

                    await sock.sendMessage(remoteJid, { text: `🔎 Searching high-quality audio for: *${query}*...` });
                    const searchResult = await yts(query);
                    const video = searchResult.videos && searchResult.videos[0];

                    if (!video) {
                        await sock.sendMessage(remoteJid, { text: '❌ Could not find that song. Try another keyword.' });
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
                        text: `✅ *Added to Radio Queue (#${requestQueue.length})*\n🎵 *${songItem.title}*\n⏱️ Duration: ${songItem.duration}\n\n_Type !list to view or !play to broadcast immediately to the group._`
                    });
                }

                // 2. View the personal request list: !list
                else if (cmd === '!list' || cmd === '!queue') {
                    if (requestQueue.length === 0) {
                        await sock.sendMessage(remoteJid, { text: '📭 Your request list is empty. Use `!add <song>` to add tracks.' });
                        return;
                    }

                    const listString = requestQueue
                        .map((s, idx) => `*${idx + 1}.* 🎵 ${s.title} (${s.duration})`)
                        .join('\n');

                    await sock.sendMessage(remoteJid, {
                        text: `📻 *Your Personal Request List (+${RAW_OWNER}):*\n\n${listString}\n\n*Edit Commands:*\n• \`!remove <number>\`\n• \`!top <number>\` (Move song to #1)\n• \`!autodj\` (Toggle continuous radio: ${autoDjEnabled ? 'ON' : 'OFF'})\n• \`!play\` (Send HQ song to group now)`
                    });
                }

                // 3. Remove a song from the list: !remove <number>
                else if (cmd === '!remove') {
                    const index = parseInt(query, 10) - 1;
                    if (isNaN(index) || index < 0 || index >= requestQueue.length) {
                        await sock.sendMessage(remoteJid, { text: '⚠️ Invalid song number. Check `!list` first.' });
                        return;
                    }
                    const removed = requestQueue.splice(index, 1)[0];
                    await sock.sendMessage(remoteJid, { text: `🗑️ Removed *${removed.title}* from your request list.` });
                }

                // 4. Move a song to the top (#1) of the queue: !top <number>
                else if (cmd === '!top') {
                    const index = parseInt(query, 10) - 1;
                    if (isNaN(index) || index <= 0 || index >= requestQueue.length) {
                        await sock.sendMessage(remoteJid, { text: '⚠️ Enter a valid song number (2 or higher) to move to #1.' });
                        return;
                    }
                    const [promoted] = requestQueue.splice(index, 1);
                    requestQueue.unshift(promoted);
                    await sock.sendMessage(remoteJid, { text: `⬆️ Moved *${promoted.title}* to #1 in the queue!` });
                }

                // 5. Toggle Continuous Auto-DJ Radio Mode: !autodj
                else if (cmd === '!autodj') {
                    autoDjEnabled = !autoDjEnabled;
                    await sock.sendMessage(remoteJid, {
                        text: `📻 *Auto-DJ Continuous Radio Mode:* ${autoDjEnabled ? '✅ ENABLED (Songs will play back-to-back automatically)' : '⏸️ DISABLED (Use !play manually)'}`
                    });
                }

                // 6. Play / Broadcast next song in High Quality to the Group: !play
                else if (cmd === '!play' || cmd === '!playnext') {
                    await broadcastNextSong(remoteJid);
                }
            } catch (err) {
                console.error('Bot Command Error:', err);
                await sock.sendMessage(remoteJid, { text: '⚠️ Error processing command: ' + err.message });
            }
        });
    } catch (initErr) {
        console.error('Bot initialization error, retrying in 5s:', initErr.message);
        setTimeout(startRadioBot, 5000);
    }
}

// Prevent unexpected errors from stopping the 24/7 cloud server
process.on('uncaughtException', (err) => {
    console.error('Caught exception (Server kept alive):', err.message);
});
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection (Server kept alive):', reason);
});

startRadioBot();