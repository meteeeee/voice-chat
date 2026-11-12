// Voice Chat Client — Discord-style UI, peer-to-peer WebRTC with Cloudflare TURN relay

const SETTINGS_KEY = 'vc-audio-settings';
const USERNAME_KEY = 'vc-username';
const DEFAULT_SETTINGS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const AVATAR_COLORS = ['#5865f2', '#3ba55c', '#faa61a', '#ed4245', '#eb459e', '#00a8fc', '#9b59b6', '#1abc9c'];

const SVG = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const ICONS = {
    speaker: `<svg width="20" height="20" ${SVG}><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`,
    micOff: (s) => `<svg width="${s}" height="${s}" ${SVG}><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`,
    headphonesOff: (s) => `<svg width="${s}" height="${s}" ${SVG}><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/><line x1="2" y1="2" x2="22" y2="22"/></svg>`
};

const $ = (id) => document.getElementById(id);

function colorFor(name) {
    let h = 0;
    for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function initialOf(name) {
    return (Array.from(String(name).trim())[0] || '?').toUpperCase();
}

class VoiceChat {
    constructor() {
        this.ws = null;
        this.wsOpen = false;
        this.everConnected = false;
        this.leaving = false;
        this.loggedIn = false;
        this.reconnectDelay = 1000;
        this.heartbeatInterval = null;
        this.statsInterval = null;

        this.userId = null;
        this.username = '';
        this.currentRoom = 'General';
        this.roomEpoch = 0;
        this.users = [];           // users in my current room
        this.roomMembers = {};     // room -> [{ id, username, muted, deafened }]
        this.roomOrder = [];
        this.speakingUsers = new Set();

        this.peers = new Map();            // userId -> RTCPeerConnection
        this.peerPromises = new Map();     // userId -> Promise<RTCPeerConnection> (in-flight creation)
        this.peerStates = new Map();       // userId -> { state, relay, ping }
        this.remoteAudios = new Map();     // userId -> <audio>
        this.pendingCandidates = new Map();// userId -> [candidate]
        this.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }]; // fallback
        this.turnReady = Promise.resolve();

        this.localStream = null;
        this.micState = 'pending';         // pending | ok | denied
        this.audioReady = Promise.resolve();
        this._audioReadyResolve = null;
        this.audioCtx = null;
        this.vad = null;
        this.micLevel = 0;
        this.isSpeaking = false;
        this.speakingThreshold = 0.02;
        this.silenceTimeout = null;
        this.restartingMic = false;
        this.micRestartQueued = false;

        this.isMuted = false;
        this.isDeafened = false;
        this.mutedBeforeDeafen = false;

        this.settings = this.loadSettings();
        this.chatOpen = window.innerWidth > 900;
        this.lastMsg = null;
        this.meterFrame = null;
        this.toastTimer = null;

        // Hidden container for remote <audio> elements (must be in the DOM for autoplay)
        this.audioContainer = document.createElement('div');
        this.audioContainer.id = 'audio-container';
        this.audioContainer.style.display = 'none';
        document.body.appendChild(this.audioContainer);

        this.initUI();
    }

    // ---------------------------------------------------------------- settings

    loadSettings() {
        try {
            return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
        } catch {
            return { ...DEFAULT_SETTINGS };
        }
    }

    saveSettings() {
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch { /* private mode */ }
    }

    getAudioConstraints() {
        return {
            echoCancellation: this.settings.echoCancellation,
            noiseSuppression: this.settings.noiseSuppression,
            autoGainControl: this.settings.autoGainControl
        };
    }

    // ---------------------------------------------------------------- UI wiring

    initUI() {
        window.addEventListener('error', (e) => console.error('Uncaught error:', e.error || e.message));

        const usernameInput = $('username-input');
        try { usernameInput.value = localStorage.getItem(USERNAME_KEY) || ''; } catch { /* ignore */ }
        $('join-btn').addEventListener('click', () => this.login());
        usernameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.login(); });

        document.querySelectorAll('[data-action]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const action = btn.dataset.action;
                if (action === 'mute') this.toggleMute();
                else if (action === 'deafen') this.toggleDeafen();
                else if (action === 'settings') this.openSettings();
                else if (action === 'disconnect') this.disconnect();
            });
        });

        $('chat-toggle-btn').addEventListener('click', () => this.setChatOpen(!this.chatOpen));
        $('menu-btn').addEventListener('click', () => this.setSidebarOpen(true));
        $('sidebar-backdrop').addEventListener('click', () => this.setSidebarOpen(false));

        $('send-chat-btn').addEventListener('click', () => this.sendChatMessage());
        $('chat-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.isComposing) {
                e.preventDefault();
                this.sendChatMessage();
            }
        });

        $('settings-close').addEventListener('click', () => this.closeSettings());
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !$('settings-modal').classList.contains('hidden')) this.closeSettings();
        });

        for (const key of Object.keys(DEFAULT_SETTINGS)) {
            const input = $(`opt-${key}`);
            input.checked = this.settings[key];
            input.addEventListener('change', () => this.updateSetting(key, input.checked));
        }

        this.setChatOpen(this.chatOpen);
    }

    setChatOpen(open) {
        this.chatOpen = open;
        $('chat-container').classList.toggle('hidden', !open);
        $('chat-toggle-btn').classList.toggle('active', open);
        if (open) $('chat-badge').classList.add('hidden');
    }

    setSidebarOpen(open) {
        $('sidebar').classList.toggle('open', open);
        $('sidebar-backdrop').classList.toggle('open', open);
    }

    toast(message) {
        const el = $('toast');
        el.textContent = message;
        el.classList.remove('hidden');
        clearTimeout(this.toastTimer);
        this.toastTimer = setTimeout(() => el.classList.add('hidden'), 4000);
    }

    buildAvatar(name) {
        const avatar = document.createElement('div');
        avatar.className = 'avatar';
        avatar.style.setProperty('--c', colorFor(name));
        avatar.textContent = initialOf(name);
        return avatar;
    }

    // ---------------------------------------------------------------- login / connection

    async login() {
        if (this.loggedIn) return;
        this.loggedIn = true;

        this.username = $('username-input').value.trim().slice(0, 20) || 'User' + Math.floor(Math.random() * 1000);
        try { localStorage.setItem(USERNAME_KEY, this.username); } catch { /* ignore */ }

        // Create the AudioContext inside the click gesture so it's allowed to run.
        // It's reused for voice detection and UI sounds.
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            this.audioCtx = new Ctx();
            this.audioCtx.resume().catch(() => { });
        } catch (err) {
            console.warn('AudioContext unavailable:', err);
        }

        $('login-screen').classList.add('hidden');
        $('app-screen').classList.remove('hidden');
        $('my-username').textContent = this.username;
        const myAvatar = $('my-avatar');
        myAvatar.textContent = initialOf(this.username);
        myAvatar.style.setProperty('--c', colorFor(this.username));
        this.resetChat(this.currentRoom);
        this.refreshStatus();

        this.audioReady = new Promise((resolve) => { this._audioReadyResolve = resolve; });

        // ⚡ Fire everything in parallel; peer connections wait for both mic + TURN
        this.turnReady = this.fetchTurnCredentials();
        this.initAudio();
        this.connect();

        this.statsInterval = setInterval(() => this.pollStats(), 2000);
    }

    async fetchTurnCredentials() {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3000);
            const response = await fetch('/turn-credentials', { signal: controller.signal });
            clearTimeout(timeout);

            if (!response.ok) {
                console.warn(`Server returned ${response.status} for TURN credentials, using fallback STUN`);
                return;
            }
            const data = await response.json();
            if (Array.isArray(data)) {
                this.iceServers = data;
                console.log('✅ TURN credentials fetched');
            } else if (data && Array.isArray(data.iceServers)) {
                this.iceServers = data.iceServers;
                console.log('✅ Cloudflare TURN credentials fetched');
            } else {
                console.warn('Unexpected TURN response, using fallback STUN:', data);
            }
        } catch (err) {
            console.warn(err.name === 'AbortError'
                ? '⏱ TURN credential fetch timed out (3s), using fallback STUN'
                : 'Failed to fetch TURN credentials, using fallback STUN', err);
        }
    }

    connect() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        this.ws = new WebSocket(`${protocol}//${window.location.host}`);

        this.ws.onopen = () => {
            console.log('⚡ WebSocket connected');
            this.wsOpen = true;
            this.everConnected = true;
            this.reconnectDelay = 1000;
            this.refreshStatus();
            this.joinRoom(this.currentRoom, true);
            this.startHeartbeat();
        };

        this.ws.onclose = () => {
            this.wsOpen = false;
            this.stopHeartbeat();
            if (this.leaving) return;
            this.refreshStatus();
            setTimeout(() => this.connect(), this.reconnectDelay);
            this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10000);
        };

        this.ws.onerror = (error) => console.error('WebSocket error:', error);

        this.ws.onmessage = (event) => {
            let message;
            try { message = JSON.parse(event.data); } catch { return; }
            if (message.type !== 'speaking' && message.type !== 'pong') console.log(`📥 ${message.type}`, message);
            this.handleMessage(message);
        };
    }

    send(message) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
            return true;
        }
        return false;
    }

    startHeartbeat() {
        this.stopHeartbeat();
        // Render closes idle WebSockets after ~60s; ping every 25s
        this.heartbeatInterval = setInterval(() => this.send({ type: 'ping' }), 25000);
    }

    stopHeartbeat() {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
    }

    disconnect() {
        this.leaving = true;
        this.stopHeartbeat();
        clearInterval(this.statsInterval);
        this.peers.forEach((pc) => pc.close());
        this.localStream?.getTracks().forEach((t) => t.stop());
        try { this.ws?.close(); } catch { /* ignore */ }
        window.location.reload();
    }

    refreshStatus() {
        let cls = '';
        let label;
        if (!this.wsOpen) label = this.everConnected ? 'Reconnecting…' : 'Connecting…';
        else if (this.micState === 'denied') { cls = 'error'; label = 'Listen Only (mic blocked)'; }
        else if (this.micState === 'pending') label = 'Starting mic…';
        else { cls = 'connected'; label = 'Voice Connected'; }
        $('connection-status').className = `vp-status ${cls}`;
        $('connection-text').textContent = label;
    }

    // ---------------------------------------------------------------- signaling messages

    handleMessage(message) {
        switch (message.type) {
            case 'joined':
                this.userId = message.userId;
                this.currentRoom = message.room;
                this.applyRooms(message);
                this.playTone('join');
                break;

            case 'rooms':
                this.applyRooms(message);
                break;

            case 'user-list':
                this.handleUserList(message.users);
                break;

            case 'user-joined':
                this.playTone('join');
                break;

            case 'user-left':
                this.removePeer(message.userId);
                this.pendingCandidates.delete(message.userId);
                this.peerStates.delete(message.userId);
                this.speakingUsers.delete(message.userId);
                this.playTone('leave');
                break;

            case 'offer':
                this.handleOffer(message.senderId, message.data);
                break;

            case 'answer':
                this.handleAnswer(message.senderId, message.data);
                break;

            case 'ice-candidate':
                this.handleIceCandidate(message.senderId, message.data);
                break;

            case 'speaking':
                if (message.speaking) this.speakingUsers.add(message.userId);
                else this.speakingUsers.delete(message.userId);
                document.querySelectorAll(`[data-user-id="${Number(message.userId)}"]`)
                    .forEach((el) => el.classList.toggle('speaking', !!message.speaking));
                break;

            case 'chat':
                this.appendChatMessage(message.userId, message.username, message.text);
                break;

            case 'pong':
                break;

            default:
                console.log(`❓ Unknown message type: ${message.type}`, message);
        }
    }

    applyRooms(message) {
        if (message.rooms) this.roomOrder = Object.keys(message.rooms);
        if (message.members) this.roomMembers = message.members;
        this.renderChannels();
    }

    handleUserList(users) {
        this.users = users;
        users.forEach((u) => {
            if (u.speaking) this.speakingUsers.add(u.id);
            else this.speakingUsers.delete(u.id);
        });

        // Drop peers that are no longer in the room
        for (const id of [...this.peers.keys()]) {
            if (!users.some((u) => u.id === id)) this.removePeer(id);
        }

        // Only the newer user (higher id) starts the call. Before, BOTH sides sent offers
        // at the same time ("glare"), which made connections randomly fail.
        users.forEach((u) => {
            if (u.id !== this.userId && this.userId > u.id && !this.peers.has(u.id)) {
                this.createPeerConnection(u.id, true);
            }
        });

        this.renderUsers();
    }

    // ---------------------------------------------------------------- WebRTC

    createPeerConnection(targetId, isInitiator) {
        if (this.peers.has(targetId)) return Promise.resolve(this.peers.get(targetId));
        if (this.peerPromises.has(targetId)) return this.peerPromises.get(targetId);

        const promise = this._createPeerConnection(targetId, isInitiator).finally(() => {
            if (this.peerPromises.get(targetId) === promise) this.peerPromises.delete(targetId);
        });
        this.peerPromises.set(targetId, promise);
        return promise;
    }

    async _createPeerConnection(targetId, isInitiator) {
        const epoch = this.roomEpoch;

        // Wait for the mic AND the Cloudflare TURN servers, so the connection
        // never starts with only the fallback STUN server.
        await Promise.all([this.audioReady, this.turnReady]);
        if (epoch !== this.roomEpoch) return null; // switched rooms while waiting
        if (this.peers.has(targetId)) return this.peers.get(targetId);

        console.log(`🔗 Creating peer connection to user ${targetId} (initiator: ${isInitiator})`);
        const pc = new RTCPeerConnection({
            iceServers: this.iceServers,
            iceTransportPolicy: 'all', // direct P2P when possible, Cloudflare TURN relay as fallback
            iceCandidatePoolSize: 4
        });
        this.peers.set(targetId, pc);
        this.updatePeerStatus(targetId, 'connecting');

        pc.onconnectionstatechange = () => {
            const state = pc.connectionState;
            console.log(`🔌 Connection to user ${targetId}: ${state}`);
            if (this.peers.get(targetId) !== pc) return; // stale connection
            this.updatePeerStatus(targetId, state);

            if (state === 'failed') {
                this.removePeer(targetId);
                // Only the initiating side retries, so both sides don't collide again
                if (this.userId > targetId) {
                    setTimeout(() => {
                        if (!this.peers.has(targetId) && this.users.some((u) => u.id === targetId)) {
                            this.createPeerConnection(targetId, true);
                        }
                    }, 2000);
                }
            }
        };

        if (this.localStream) {
            this.localStream.getTracks().forEach((track) => pc.addTrack(track, this.localStream));
        }

        pc.ontrack = (event) => {
            console.log(`🎧 Received audio from user ${targetId}`);
            const old = this.remoteAudios.get(targetId);
            if (old) {
                old.srcObject = null;
                old.remove();
            }

            const audio = document.createElement('audio');
            audio.autoplay = true;
            audio.playsInline = true;
            audio.srcObject = event.streams[0] || new MediaStream([event.track]);
            audio.muted = this.isDeafened;
            this.audioContainer.appendChild(audio);
            this.remoteAudios.set(targetId, audio);

            audio.play().catch((e) => {
                console.warn('Autoplay blocked, will start on next click:', e);
                this.toast('Click anywhere to enable audio');
                document.addEventListener('click', () => audio.play().catch(() => { }), { once: true });
            });
        };

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.send({ type: 'ice-candidate', targetId, data: event.candidate });
            }
        };

        if (isInitiator) {
            try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                this.send({ type: 'offer', targetId, data: pc.localDescription });
                console.log(`📤 Offer sent to user ${targetId}`);
            } catch (err) {
                console.error('Failed to create offer:', err);
            }
        }

        return pc;
    }

    async handleOffer(senderId, offer) {
        let pc = this.peers.get(senderId);
        // A new offer on an already-negotiated connection means the other side restarted it
        if (pc && pc.remoteDescription) {
            this.removePeer(senderId);
            pc = null;
        }
        if (!pc) pc = await this.createPeerConnection(senderId, false);
        if (!pc) return;

        try {
            await pc.setRemoteDescription(offer);
            await this.flushCandidates(senderId, pc);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            this.send({ type: 'answer', targetId: senderId, data: pc.localDescription });
            console.log(`📤 Answer sent to user ${senderId}`);
        } catch (err) {
            console.error('Failed to handle offer:', err);
        }
    }

    async handleAnswer(senderId, answer) {
        const pc = this.peers.get(senderId);
        if (!pc || pc.signalingState !== 'have-local-offer') {
            console.warn(`⚠️ Ignoring unexpected answer from user ${senderId}`);
            return;
        }
        try {
            await pc.setRemoteDescription(answer);
            await this.flushCandidates(senderId, pc);
        } catch (err) {
            console.error('Failed to handle answer:', err);
        }
    }

    async handleIceCandidate(senderId, candidate) {
        const pc = this.peers.get(senderId);
        // Candidates can only be added after the remote description is set.
        // Before, early candidates (often the TURN relay ones!) were silently dropped.
        if (pc && pc.remoteDescription) {
            try {
                await pc.addIceCandidate(candidate);
            } catch (err) {
                console.warn('Failed to add ICE candidate:', err);
            }
            return;
        }
        if (!this.pendingCandidates.has(senderId)) this.pendingCandidates.set(senderId, []);
        this.pendingCandidates.get(senderId).push(candidate);
    }

    async flushCandidates(userId, pc) {
        const queued = this.pendingCandidates.get(userId);
        if (!queued) return;
        this.pendingCandidates.delete(userId);
        for (const candidate of queued) {
            try {
                await pc.addIceCandidate(candidate);
            } catch (err) {
                console.warn('Failed to add queued ICE candidate:', err);
            }
        }
    }

    removePeer(userId) {
        const pc = this.peers.get(userId);
        if (pc) {
            pc.close();
            this.peers.delete(userId);
        }
        const audio = this.remoteAudios.get(userId);
        if (audio) {
            audio.srcObject = null;
            audio.remove();
            this.remoteAudios.delete(userId);
        }
        this.updateVoicePanel();
    }

    updatePeerStatus(userId, state) {
        const prev = this.peerStates.get(userId) || {};
        this.peerStates.set(userId, { ...prev, state });
        const tile = document.querySelector(`.tile[data-user-id="${userId}"]`);
        if (tile) this.applyPeerStatus(tile, userId);
        this.updateVoicePanel();
    }

    async pollStats() {
        for (const [id, pc] of this.peers) {
            if (pc.connectionState !== 'connected') continue;
            try {
                const stats = await pc.getStats();
                let pair = null;
                stats.forEach((r) => {
                    if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
                });
                if (!pair) {
                    stats.forEach((r) => {
                        if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r;
                    });
                }
                if (!pair) continue;

                const local = stats.get(pair.localCandidateId);
                const remote = stats.get(pair.remoteCandidateId);
                const relay = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
                const ping = typeof pair.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : null;

                this.peerStates.set(id, { ...(this.peerStates.get(id) || {}), relay, ping });
                const tile = document.querySelector(`.tile[data-user-id="${id}"]`);
                if (tile) this.applyPeerStatus(tile, id);
            } catch { /* connection closed mid-poll */ }
        }
        this.updateVoicePanel();
    }

    updateVoicePanel() {
        const route = $('vp-route');
        if (!route) return;
        const states = [...this.peers.keys()].map((id) => this.peerStates.get(id) || {});
        const connected = states.filter((s) => s.state === 'connected');

        if (!this.peers.size) {
            route.textContent = this.users.length > 1 ? 'Connecting…' : 'Waiting for others';
        } else if (!connected.length) {
            route.textContent = 'Connecting…';
        } else {
            const relay = connected.some((s) => s.relay);
            const pings = connected.map((s) => s.ping).filter((p) => p != null);
            const ping = pings.length ? Math.max(...pings) : null;
            route.textContent = (relay ? 'Cloudflare relay' : 'Direct P2P') + (ping != null ? ` · ${ping} ms` : '');
        }
    }

    // ---------------------------------------------------------------- microphone

    async initAudio() {
        try {
            this.localStream = await navigator.mediaDevices.getUserMedia({ audio: this.getAudioConstraints(), video: false });
            this.localStream.getAudioTracks().forEach((t) => { t.enabled = !this.isMuted; });
            this.micState = 'ok';
            this.setupVoiceDetection();
        } catch (err) {
            console.error('Failed to get microphone:', err);
            this.micState = 'denied';
            this.toast('Microphone blocked — you can listen, but nobody can hear you.');
        } finally {
            if (this._audioReadyResolve) this._audioReadyResolve();
            this.refreshStatus();
        }
    }

    setupVoiceDetection() {
        this.teardownVoiceDetection();
        if (!this.localStream) return;
        if (!this.audioCtx) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            this.audioCtx = new Ctx();
        }
        if (this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => { });

        const source = this.audioCtx.createMediaStreamSource(this.localStream);
        const analyser = this.audioCtx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.4;
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);

        // setInterval instead of requestAnimationFrame so detection keeps working in background tabs
        const interval = setInterval(() => {
            analyser.getByteFrequencyData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) sum += data[i];
            const level = sum / data.length / 255;
            this.micLevel = this.isMuted ? 0 : level;
            if (this.isMuted) return;

            if (level > this.speakingThreshold) {
                if (!this.isSpeaking) {
                    this.isSpeaking = true;
                    this.send({ type: 'speaking', speaking: true });
                }
                clearTimeout(this.silenceTimeout);
                this.silenceTimeout = setTimeout(() => {
                    this.isSpeaking = false;
                    this.send({ type: 'speaking', speaking: false });
                }, 300);
            }
        }, 50);

        this.vad = { source, interval };
    }

    teardownVoiceDetection() {
        if (!this.vad) return;
        clearInterval(this.vad.interval);
        try { this.vad.source.disconnect(); } catch { /* ignore */ }
        this.vad = null;
    }

    async updateSetting(key, value) {
        this.settings[key] = value;
        this.saveSettings();
        if (this.localStream) await this.restartMicrophone();
        this.renderAppliedSettings();
    }

    // Re-open the mic with new processing settings and hot-swap it into every call.
    // replaceTrack() swaps audio without renegotiating, so the call doesn't drop.
    async restartMicrophone() {
        if (this.restartingMic) {
            this.micRestartQueued = true;
            return;
        }
        this.restartingMic = true;
        try {
            do {
                this.micRestartQueued = false;
                // Stop the old track first: Chrome reuses an open mic's processing settings otherwise
                this.teardownVoiceDetection();
                this.localStream?.getTracks().forEach((t) => t.stop());

                const stream = await navigator.mediaDevices.getUserMedia({ audio: this.getAudioConstraints(), video: false });
                const track = stream.getAudioTracks()[0];
                track.enabled = !this.isMuted;
                this.localStream = stream;

                await Promise.all([...this.peers.values()].map((pc) => {
                    const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
                    return sender ? sender.replaceTrack(track) : null;
                }));

                this.setupVoiceDetection();
                this.micState = 'ok';
                console.log('🎙️ Mic restarted with', track.getSettings());
            } while (this.micRestartQueued);
        } catch (err) {
            console.error('Failed to restart microphone:', err);
            this.micState = 'denied';
            this.toast('Could not restart the microphone. Try refreshing the page.');
        } finally {
            this.restartingMic = false;
            this.refreshStatus();
        }
    }

    // ---------------------------------------------------------------- mute / deafen

    toggleMute() {
        if (this.isDeafened) {
            // Discord behaviour: unmuting while deafened also undeafens
            this.isDeafened = false;
            this.isMuted = false;
        } else {
            this.isMuted = !this.isMuted;
        }
        this.playTone(this.isMuted ? 'mute' : 'unmute');
        this.applyVoiceState();
    }

    toggleDeafen() {
        if (this.isDeafened) {
            this.isDeafened = false;
            this.isMuted = this.mutedBeforeDeafen;
        } else {
            this.mutedBeforeDeafen = this.isMuted;
            this.isDeafened = true;
            this.isMuted = true;
        }
        this.playTone(this.isDeafened ? 'mute' : 'unmute');
        this.applyVoiceState();
    }

    applyVoiceState() {
        this.localStream?.getAudioTracks().forEach((t) => { t.enabled = !this.isMuted; });
        this.remoteAudios.forEach((a) => { a.muted = this.isDeafened; });

        if (this.isMuted && this.isSpeaking) {
            this.isSpeaking = false;
            clearTimeout(this.silenceTimeout);
            this.send({ type: 'speaking', speaking: false });
        }

        document.querySelectorAll('[data-action="mute"]').forEach((b) => {
            b.classList.toggle('muted', this.isMuted);
            b.title = this.isMuted ? 'Unmute' : 'Mute';
        });
        document.querySelectorAll('[data-action="deafen"]').forEach((b) => {
            b.classList.toggle('muted', this.isDeafened);
            b.title = this.isDeafened ? 'Undeafen' : 'Deafen';
        });
        $('my-status').textContent = this.isDeafened ? 'Deafened' : this.isMuted ? 'Muted' : 'Online';

        // Optimistic local update; the server echoes it to everyone else
        const me = this.users.find((u) => u.id === this.userId);
        if (me) {
            me.muted = this.isMuted;
            me.deafened = this.isDeafened;
            this.renderUsers();
        }
        this.send({ type: 'voice-state', muted: this.isMuted, deafened: this.isDeafened });
    }

    // Small Discord-ish blips using the Web Audio API (no sound files needed)
    playTone(kind) {
        const ctx = this.audioCtx;
        if (!ctx || ctx.state !== 'running') return;
        if (this.isDeafened && (kind === 'join' || kind === 'leave')) return;
        const tones = { join: [523.25, 783.99], leave: [783.99, 523.25], mute: [440, 330], unmute: [330, 440] };
        const freqs = tones[kind];
        if (!freqs) return;

        const t0 = ctx.currentTime;
        freqs.forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            const start = t0 + i * 0.09;
            osc.type = 'sine';
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0.0001, start);
            gain.gain.exponentialRampToValueAtTime(0.08, start + 0.015);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
            osc.connect(gain).connect(ctx.destination);
            osc.start(start);
            osc.stop(start + 0.18);
        });
    }

    // ---------------------------------------------------------------- rooms & rendering

    joinRoom(room, isReconnect = false) {
        const roomChanged = room !== this.currentRoom;
        this.roomEpoch++;

        this.peers.forEach((pc) => pc.close());
        this.peers.clear();
        this.peerPromises.clear();
        this.remoteAudios.forEach((a) => { a.srcObject = null; a.remove(); });
        this.remoteAudios.clear();
        this.pendingCandidates.clear();
        this.peerStates.clear();
        this.speakingUsers.clear();

        // Only wipe chat when actually switching rooms, not on a quick reconnect
        if (!isReconnect || roomChanged) this.resetChat(room);

        this.currentRoom = room;
        this.users = [];
        this.renderUsers();
        $('current-channel').textContent = room;
        $('vp-channel').textContent = room;
        $('chat-input').placeholder = `Message #${room}`;

        this.send({ type: 'join', username: this.username, room, muted: this.isMuted, deafened: this.isDeafened });
        this.renderChannels();
        this.updateVoicePanel();
    }

    renderChannels() {
        const container = $('channel-list');
        container.innerHTML = '';

        for (const room of this.roomOrder) {
            const channel = document.createElement('div');
            channel.className = 'channel' + (room === this.currentRoom ? ' active' : '');
            channel.innerHTML = ICONS.speaker;
            const name = document.createElement('span');
            name.className = 'channel-name';
            name.textContent = room;
            channel.appendChild(name);
            channel.addEventListener('click', () => {
                if (room !== this.currentRoom) this.joinRoom(room);
                this.setSidebarOpen(false);
            });
            container.appendChild(channel);

            const members = this.roomMembers[room] || [];
            if (members.length) {
                const list = document.createElement('div');
                list.className = 'channel-members';
                members.forEach((m) => list.appendChild(this.buildMember(m)));
                container.appendChild(list);
            }
        }
    }

    buildMember(member) {
        const el = document.createElement('div');
        el.className = 'member' + (this.speakingUsers.has(member.id) ? ' speaking' : '');
        el.dataset.userId = member.id;
        el.appendChild(this.buildAvatar(member.username));

        const name = document.createElement('span');
        name.className = 'member-name';
        name.textContent = member.username;
        el.appendChild(name);

        const icons = document.createElement('span');
        icons.className = 'member-icons';
        if (member.muted) icons.insertAdjacentHTML('beforeend', ICONS.micOff(16));
        if (member.deafened) icons.insertAdjacentHTML('beforeend', ICONS.headphonesOff(16));
        el.appendChild(icons);
        return el;
    }

    renderUsers() {
        const grid = $('user-list');
        grid.innerHTML = '';

        for (const user of this.users) {
            const tile = document.createElement('div');
            tile.className = 'tile' + (this.speakingUsers.has(user.id) ? ' speaking' : '');
            tile.dataset.userId = user.id;
            tile.style.setProperty('--c', colorFor(user.username));
            tile.appendChild(this.buildAvatar(user.username));

            const label = document.createElement('div');
            label.className = 'tile-label';
            label.textContent = user.username + (user.id === this.userId ? ' (you)' : '');
            tile.appendChild(label);

            if (user.muted || user.deafened) {
                const badges = document.createElement('div');
                badges.className = 'tile-badges';
                if (user.muted) badges.insertAdjacentHTML('beforeend', `<span class="tile-badge" title="Muted">${ICONS.micOff(16)}</span>`);
                if (user.deafened) badges.insertAdjacentHTML('beforeend', `<span class="tile-badge" title="Deafened">${ICONS.headphonesOff(16)}</span>`);
                tile.appendChild(badges);
            }

            if (user.id !== this.userId) {
                const status = document.createElement('div');
                status.className = 'tile-status';
                tile.appendChild(status);
                this.applyPeerStatus(tile, user.id);
            }
            grid.appendChild(tile);
        }

        $('stage-hint').classList.toggle('hidden', this.users.length !== 1);
        this.updateVoicePanel();
    }

    applyPeerStatus(tile, userId) {
        const status = tile.querySelector('.tile-status');
        if (!status) return;
        const info = this.peerStates.get(userId) || { state: 'new' };
        const map = {
            connected: ['connected', info.relay ? 'Relay' : 'Direct'],
            connecting: ['checking', 'Connecting'],
            new: ['checking', 'Connecting'],
            disconnected: ['disconnected', 'Reconnecting'],
            failed: ['disconnected', 'Failed'],
            closed: ['disconnected', 'Closed']
        };
        const [cls, text] = map[info.state] || ['checking', 'Connecting'];
        status.innerHTML = `<span class="status-dot ${cls}"></span><span></span>`;
        status.lastChild.textContent = info.state === 'connected' && info.ping != null ? `${text} · ${info.ping} ms` : text;
        status.title = info.state === 'connected'
            ? (info.relay ? 'Relayed through Cloudflare TURN' : 'Direct peer-to-peer connection')
            : '';
    }

    // ---------------------------------------------------------------- chat

    resetChat(room) {
        const box = $('chat-messages');
        box.innerHTML = `
            <div class="chat-intro">
                <div class="chat-intro-icon">#</div>
                <h3></h3>
                <p>Messages here are never saved. They disappear when you leave or refresh.</p>
            </div>`;
        box.querySelector('h3').textContent = `Welcome to #${room}!`;
        this.lastMsg = null;
    }

    sendChatMessage() {
        const input = $('chat-input');
        const text = input.value.trim().slice(0, 500);
        if (!text) return;
        if (this.send({ type: 'chat', text })) input.value = '';
        else this.toast('Not connected — message not sent');
    }

    appendChatMessage(senderId, senderName, text) {
        const box = $('chat-messages');
        const now = Date.now();
        const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const grouped = this.lastMsg && this.lastMsg.senderId === senderId && now - this.lastMsg.at < 5 * 60 * 1000;

        const textEl = document.createElement('div');
        textEl.className = 'msg-text';
        textEl.textContent = text;

        let el;
        if (grouped) {
            el = document.createElement('div');
            el.className = 'msg-cont';
            const hoverTime = document.createElement('span');
            hoverTime.className = 'msg-hover-time';
            hoverTime.textContent = time;
            el.append(hoverTime, textEl);
        } else {
            el = document.createElement('div');
            el.className = 'msg';
            const body = document.createElement('div');
            body.className = 'msg-body';
            const head = document.createElement('div');
            head.className = 'msg-head';
            const name = document.createElement('span');
            name.className = 'msg-name';
            name.textContent = senderName;
            const timeEl = document.createElement('span');
            timeEl.className = 'msg-time';
            timeEl.textContent = `Today at ${time}`;
            head.append(name, timeEl);
            body.append(head, textEl);
            el.append(this.buildAvatar(senderName), body);
        }

        box.appendChild(el);
        this.lastMsg = { senderId, at: now };
        if (nearBottom || senderId === this.userId) box.scrollTop = box.scrollHeight;
        if (!this.chatOpen && senderId !== this.userId) $('chat-badge').classList.remove('hidden');
    }

    // ---------------------------------------------------------------- settings modal

    openSettings() {
        $('settings-modal').classList.remove('hidden');
        this.renderAppliedSettings();
        const fill = $('mic-meter-fill');
        const tick = () => {
            fill.style.width = `${Math.min(100, this.micLevel * 400)}%`;
            this.meterFrame = requestAnimationFrame(tick);
        };
        cancelAnimationFrame(this.meterFrame);
        tick();
    }

    closeSettings() {
        $('settings-modal').classList.add('hidden');
        cancelAnimationFrame(this.meterFrame);
        this.meterFrame = null;
    }

    // Show what the browser ACTUALLY applied (some browsers ignore certain options)
    renderAppliedSettings() {
        const el = $('settings-applied');
        const track = this.localStream?.getAudioTracks()[0];
        if (!track) {
            el.textContent = 'Microphone is not active right now. Settings will apply when it starts.';
            return;
        }
        const s = track.getSettings();
        const fmt = (v) => (v === undefined ? 'n/a' : v ? 'on' : 'off');
        el.textContent = `Your browser reports: echo cancellation ${fmt(s.echoCancellation)}, `
            + `noise suppression ${fmt(s.noiseSuppression)}, auto gain ${fmt(s.autoGainControl)}`
            + (track.label ? ` · ${track.label}` : '');
    }
}

// Start the app
window.voiceChat = new VoiceChat();
