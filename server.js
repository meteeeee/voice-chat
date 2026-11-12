const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

// ⚡ Cache TURN credentials so we don't hit the API on every page load
let turnCache = null;
let turnCacheTime = 0;
const TURN_CACHE_TTL = 10 * 60 * 1000; // 10 minutes (Cloudflare credentials are valid for 24h)

const CLOUDFLARE_TURN_KEY_ID = process.env.CLOUDFLARE_TURN_KEY_ID || "94d1f9a76ce5553f8fd4a9091091fb08";
const CLOUDFLARE_TURN_API_TOKEN = process.env.CLOUDFLARE_TURN_API_TOKEN || "a88a80b89537ce93a7b0aa4b7c38e3ccebdbbf0619faef86a5f5780524251d32";

async function getTurnCredentials() {
    const now = Date.now();
    if (turnCache && (now - turnCacheTime) < TURN_CACHE_TTL) {
        return turnCache;
    }

    // 🚀 Primary: Cloudflare Calls TURN (1,000 GB / month free allowance)
    if (CLOUDFLARE_TURN_KEY_ID && CLOUDFLARE_TURN_API_TOKEN) {
        try {
            const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${CLOUDFLARE_TURN_KEY_ID}/credentials/generate-ice-servers`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${CLOUDFLARE_TURN_API_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ ttl: 86400 }) // Valid for 24 hours
            });

            if (response.ok) {
                const data = await response.json();
                turnCache = data.iceServers || data;
                turnCacheTime = now;
                console.log('🔄 Cloudflare TURN credentials refreshed (1,000 GB tier)');
                return turnCache;
            } else {
                console.warn(`⚠️ Cloudflare TURN returned status ${response.status}`);
            }
        } catch (cfErr) {
            console.error('⚠️ Cloudflare TURN fetch error, trying Metered fallback:', cfErr);
        }
    }

    // Fallback to Metered if Cloudflare is not reachable
    const apiKey = process.env.METERED_API_KEY || "0f98cbf1863b4b88f65da030a99aa58228b9";
    const response = await fetch(`https://mete-vc.metered.live/api/v1/turn/credentials?apiKey=${apiKey}`);
    const data = await response.json();
    turnCache = data;
    turnCacheTime = now;
    console.log('🔄 Metered TURN credentials refreshed (fallback)');
    return data;
}

// Pre-warm the TURN cache on server startup
getTurnCredentials().catch(err => console.warn('⚠️ Failed to pre-warm TURN cache:', err));

// Create HTTP server to serve static files
const server = http.createServer(async (req, res) => {
    // Remove query parameters from URL
    const cleanUrl = req.url.split('?')[0];

    // Securely fetch TURN credentials from the backend so the API key is never sent to the user's browser
    if (cleanUrl === '/turn-credentials') {
        try {
            const data = await getTurnCredentials();
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Cache-Control': 'private, max-age=300' // Browser can cache for 5 min too
            });
            res.end(JSON.stringify(data));
        } catch (err) {
            console.error("TURN Fetch Error:", err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Failed to fetch credentials" }));
        }
        return;
    }

    // Only allow serving specific whitelisted public static files
    const allowedFiles = ['/index.html', '/client.js', '/style.css'];
    let filePath = cleanUrl === '/' ? '/index.html' : cleanUrl;

    if (!allowedFiles.includes(filePath)) {
        res.writeHead(404);
        res.end('File not found');
        return;
    }

    filePath = path.join(__dirname, filePath);

    const extname = path.extname(filePath);
    const contentTypes = {
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'application/javascript'
    };

    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(404);
            res.end('File not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': contentTypes[extname] || 'text/plain' });
        res.end(content);
    });
});

// WebSocket server for signaling
const wss = new WebSocket.Server({ server });

// Store rooms and users
const rooms = {
    'General': new Set(),
    'Gaming': new Set(),
    'Music': new Set()
};

const users = new Map(); // WebSocket -> { id, username, room, speaking, muted, deafened }

let userIdCounter = 1;

function broadcast(room, message, excludeWs = null) {
    const roomUsers = rooms[room];
    if (!roomUsers) return;

    const payload = JSON.stringify(message);
    for (const [ws, user] of users.entries()) {
        if (roomUsers.has(user.id) && ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
            ws.send(payload);
        }
    }
}

function broadcastAll(message) {
    const payload = JSON.stringify(message);
    for (const ws of users.keys()) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(payload);
        }
    }
}

function broadcastUserList(room) {
    const userList = [];
    for (const user of users.values()) {
        if (user.room === room) {
            userList.push({
                id: user.id,
                username: user.username,
                speaking: !!user.speaking,
                muted: !!user.muted,
                deafened: !!user.deafened,
                video: !!user.video,
                screen: !!user.screen
            });
        }
    }
    broadcast(room, { type: 'user-list', users: userList });
}

function getRoomList() {
    const roomList = {};
    for (const [roomName, userIds] of Object.entries(rooms)) {
        roomList[roomName] = userIds.size;
    }
    return roomList;
}

function getRoomMembers() {
    const members = {};
    for (const roomName of Object.keys(rooms)) {
        members[roomName] = [];
    }
    for (const user of users.values()) {
        if (user.room && members[user.room]) {
            members[user.room].push({
                id: user.id,
                username: user.username,
                muted: !!user.muted,
                deafened: !!user.deafened,
                video: !!user.video,
                screen: !!user.screen
            });
        }
    }
    return members;
}

function broadcastRooms() {
    broadcastAll({
        type: 'rooms',
        rooms: getRoomList(),
        members: getRoomMembers()
    });
}

function currentMonthKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

let monthlyQuota = { month: currentMonthKey(), bytes: 0 };

function getMonthlyQuota() {
    const month = currentMonthKey();
    if (monthlyQuota.month !== month) {
        monthlyQuota = { month, bytes: 0 };
    }
    return monthlyQuota;
}

wss.on('connection', (ws) => {
    const userId = userIdCounter++;
    console.log(`User ${userId} connected`);

    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);

            switch (message.type) {
                case 'join': {
                    const username = String(message.username || `User${userId}`).trim().slice(0, 20) || `User${userId}`;
                    const room = Object.prototype.hasOwnProperty.call(rooms, message.room) ? message.room : 'General';
                    const muted = !!message.muted;
                    const deafened = !!message.deafened;
                    const video = !!message.video;
                    const screen = !!message.screen;

                    // Sync monthly quota if client has a higher stored value for this month (e.g. after server restart)
                    const q = getMonthlyQuota();
                    if (message.quota && message.quota.month === q.month && typeof message.quota.bytes === 'number') {
                        q.bytes = Math.max(q.bytes, message.quota.bytes);
                    }

                    // Leave previous room if any
                    const existingUser = users.get(ws);
                    if (existingUser && existingUser.room && rooms[existingUser.room]) {
                        rooms[existingUser.room].delete(existingUser.id);
                        broadcast(existingUser.room, {
                            type: 'user-left',
                            userId: existingUser.id,
                            username: existingUser.username
                        }, ws);
                        broadcastUserList(existingUser.room);
                    }

                    // Join new room
                    users.set(ws, { id: userId, username, room, speaking: false, muted, deafened, video, screen });
                    rooms[room].add(userId);

                    // Notify others in the room
                    broadcast(room, {
                        type: 'user-joined',
                        userId,
                        username
                    }, ws);

                    // Send room info to the joining user
                    ws.send(JSON.stringify({
                        type: 'joined',
                        userId,
                        room,
                        rooms: getRoomList(),
                        members: getRoomMembers(),
                        quota: getMonthlyQuota()
                    }));

                    broadcastUserList(room);
                    broadcastRooms();
                    broadcastAll({ type: 'quota', quota: getMonthlyQuota() });
                    break;
                }

                case 'quota-add': {
                    const q = getMonthlyQuota();
                    const delta = Number(message.delta) || 0;
                    if (delta > 0 && delta < 500 * 1024 * 1024) {
                        q.bytes += delta;
                    }
                    if (message.month === q.month && typeof message.total === 'number') {
                        q.bytes = Math.max(q.bytes, message.total);
                    }
                    broadcastAll({ type: 'quota', quota: q });
                    break;
                }

                case 'quota-reset': {
                    monthlyQuota = { month: currentMonthKey(), bytes: 0 };
                    broadcastAll({ type: 'quota', quota: monthlyQuota, reset: true });
                    break;
                }

                case 'voice-state': {
                    const user = users.get(ws);
                    if (!user) return;
                    user.muted = !!message.muted;
                    user.deafened = !!message.deafened;
                    user.video = !!message.video;
                    user.screen = !!message.screen;
                    if (user.muted) user.speaking = false;
                    broadcastUserList(user.room);
                    broadcastRooms();
                    break;
                }

                case 'offer':
                case 'answer':
                case 'ice-candidate': {
                    const sender = users.get(ws);
                    if (!sender) {
                        console.warn("⚠️ Signal message received from unjoined client, ignoring.");
                        return;
                    }
                    const targetId = Number(message.targetId);

                    for (const [targetWs, user] of users.entries()) {
                        if (Number(user.id) === targetId && targetWs.readyState === WebSocket.OPEN) {
                            targetWs.send(JSON.stringify({
                                type: message.type,
                                senderId: sender.id,
                                data: message.data
                            }));
                            break;
                        }
                    }
                    break;
                }

                case 'speaking': {
                    const speakingUser = users.get(ws);
                    if (speakingUser) {
                        speakingUser.speaking = !!message.speaking && !speakingUser.muted;
                        broadcast(speakingUser.room, {
                            type: 'speaking',
                            userId: speakingUser.id,
                            speaking: speakingUser.speaking
                        });
                    }
                    break;
                }

                case 'get-rooms':
                    ws.send(JSON.stringify({
                        type: 'rooms',
                        rooms: getRoomList(),
                        members: getRoomMembers()
                    }));
                    break;

                case 'ping':
                    ws.send(JSON.stringify({ type: 'pong' }));
                    break;

                case 'chat': {
                    const chatUser = users.get(ws);
                    const text = String(message.text || '').trim().slice(0, 500);
                    if (chatUser && chatUser.room && text) {
                        broadcast(chatUser.room, {
                            type: 'chat',
                            userId: chatUser.id,
                            username: chatUser.username,
                            text
                        });
                    }
                    break;
                }
            }
        } catch (err) {
            console.error('Error processing message:', err);
        }
    });

    ws.on('close', () => {
        const user = users.get(ws);
        if (user) {
            console.log(`User ${user.username} disconnected`);
            const prevRoom = user.room;
            users.delete(ws);
            if (prevRoom && rooms[prevRoom]) {
                rooms[prevRoom].delete(user.id);
                broadcast(prevRoom, {
                    type: 'user-left',
                    userId: user.id,
                    username: user.username
                });
                broadcastUserList(prevRoom);
            }
            broadcastRooms();
        }
    });
});

server.listen(PORT, () => {
    console.log(`🎤 Voice Chat Server running at http://localhost:${PORT}`);
});
