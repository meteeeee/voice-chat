const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

// Create HTTP server to serve static files
const server = http.createServer(async (req, res) => {
    // Remove query parameters from URL
    const cleanUrl = req.url.split('?')[0];

    // Securely fetch TURN credentials from the backend so the API key is never sent to the user's browser
    if (cleanUrl === '/turn-credentials') {
        try {
            const apiKey = process.env.METERED_API_KEY || "0f98cbf1863b4b88f65da030a99aa58228b9";
            const response = await fetch(`https://mete-vc.metered.live/api/v1/turn/credentials?apiKey=${apiKey}`);
            const data = await response.json();
            res.writeHead(200, { 'Content-Type': 'application/json' });
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

const users = new Map(); // WebSocket -> { id, username, room }

let userIdCounter = 1;

function broadcast(room, message, excludeWs = null) {
    const roomUsers = rooms[room];
    if (!roomUsers) return;

    for (const userId of roomUsers) {
        for (const [ws, user] of users.entries()) {
            if (user.id === userId && ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(message));
            }
        }
    }
}

function broadcastUserList(room) {
    const userList = [];
    for (const [ws, user] of users.entries()) {
        if (user.room === room) {
            userList.push({ id: user.id, username: user.username, speaking: user.speaking || false });
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

wss.on('connection', (ws) => {
    const userId = userIdCounter++;
    console.log(`User ${userId} connected`);

    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);

            switch (message.type) {
                case 'join':
                    // User joining a room
                    const username = message.username || `User${userId}`;
                    const room = message.room || 'General';

                    // Leave previous room if any
                    const existingUser = users.get(ws);
                    if (existingUser && existingUser.room) {
                        rooms[existingUser.room].delete(existingUser.id);
                        broadcast(existingUser.room, {
                            type: 'user-left',
                            userId: existingUser.id,
                            username: existingUser.username
                        }, ws);
                        broadcastUserList(existingUser.room);
                    }

                    // Join new room
                    users.set(ws, { id: userId, username, room, speaking: false });
                    if (!rooms[room]) rooms[room] = new Set();
                    rooms[room].add(userId);

                    // Notify others
                    broadcast(room, {
                        type: 'user-joined',
                        userId,
                        username
                    }, ws);

                    // Send room info to the user
                    ws.send(JSON.stringify({
                        type: 'joined',
                        userId,
                        room,
                        rooms: getRoomList()
                    }));

                    broadcastUserList(room);
                    break;

                case 'offer':
                case 'answer':
                case 'ice-candidate':
                    // Relay WebRTC signaling to target user
                    const sender = users.get(ws);
                    if (!sender) {
                        console.warn("⚠️ Signal message received from unjoined client, ignoring.");
                        return;
                    }
                    const targetId = Number(message.targetId);
                    console.log(`📡 Relaying ${message.type} from user ${sender.id} to user ${targetId}`);

                    let found = false;
                    for (const [targetWs, user] of users.entries()) {
                        if (Number(user.id) === targetId && targetWs.readyState === WebSocket.OPEN) {
                            found = true;
                            const relayMessage = {
                                type: message.type,
                                senderId: sender.id,
                                data: message.data
                            };
                            try {
                                targetWs.send(JSON.stringify(relayMessage));
                                console.log(`✅ Relayed ${message.type} to user ${targetId}`);
                            } catch (sendErr) {
                                console.error(`❌ Failed to send ${message.type} to user ${targetId}:`, sendErr);
                            }
                        }
                    }
                    if (!found) {
                        console.log(`❌ Target user ${targetId} not found! Active users:`,
                            Array.from(users.values()).map(u => ({ id: u.id, room: u.room })));
                    }
                    break;

                case 'speaking':
                    // Update speaking status
                    const speakingUser = users.get(ws);
                    if (speakingUser) {
                        speakingUser.speaking = message.speaking;
                        broadcast(speakingUser.room, {
                            type: 'speaking',
                            userId: speakingUser.id,
                            speaking: message.speaking
                        });
                    }
                    break;

                case 'get-rooms':
                    ws.send(JSON.stringify({ type: 'rooms', rooms: getRoomList() }));
                    break;

                case 'chat':
                    // Ephemeral messaging: relay text chat message to everyone in the room without saving it
                    const chatUser = users.get(ws);
                    if (chatUser && chatUser.room) {
                        broadcast(chatUser.room, {
                            type: 'chat',
                            userId: chatUser.id,
                            username: chatUser.username,
                            text: message.text || ''
                        });
                    }
                    break;
            }
        } catch (err) {
            console.error('Error processing message:', err);
        }
    });

    ws.on('close', () => {
        const user = users.get(ws);
        if (user) {
            console.log(`User ${user.username} disconnected`);
            if (user.room && rooms[user.room]) {
                rooms[user.room].delete(user.id);
                broadcast(user.room, {
                    type: 'user-left',
                    userId: user.id,
                    username: user.username
                });
                broadcastUserList(user.room);
            }
            users.delete(ws);
        }
    });
});

server.listen(PORT, () => {
    console.log(`🎤 Voice Chat Server running at http://localhost:${PORT}`);
    console.log(`📡 Share your Hamachi IP with friends to connect!`);
});
