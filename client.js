// Voice Chat Client — Discord-style UI, 128 kbps Opus audio & 1080p HD WebRTC video

const SETTINGS_KEY = 'vc-audio-settings';
const USERNAME_KEY = 'vc-username';
const DEFAULT_SETTINGS = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    audioBitrate: 128000,
    videoResolution: '1080'
};
const AVATAR_COLORS = ['#5865f2', '#3ba55c', '#faa61a', '#ed4245', '#eb459e', '#00a8fc', '#9b59b6', '#1abc9c'];

const SVG = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const ICONS = {
    speaker: `<svg width="20" height="20" ${SVG}><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`,
    micOff: (s) => `<svg width="${s}" height="${s}" ${SVG}><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`,
    headphonesOff: (s) => `<svg width="${s}" height="${s}" ${SVG}><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/><line x1="2" y1="2" x2="22" y2="22"/></svg>`,
    video: (s) => `<svg width="${s}" height="${s}" ${SVG}><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`
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

// Boost Opus SDP parameters for crystal-clear 48 kHz high-bitrate voice
function enhanceOpusSdp(sdp, bitrate = 128000) {
    if (!sdp) return sdp;
    return sdp.replace(/a=fmtp:111 ([^\r\n]+)/g, (_, params) => {
        const clean = params
            .split(';')
            .filter((p) => !/^(maxaveragebitrate|stereo|sprop-stereo|useinbandfec|usedtx)=/i.test(p.trim()))
            .join(';');
        return `a=fmtp:111 ${clean};maxaveragebitrate=${bitrate};stereo=1;sprop-stereo=1;useinbandfec=1;usedtx=0`;
    });
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
        this.users = [];
        this.roomMembers = {};
        this.roomOrder = [];
        this.speakingUsers = new Set();
        this.expandedUserId = null;

        this.peers = new Map();             // userId -> RTCPeerConnection
        this.peerPromises = new Map();      // userId -> Promise<RTCPeerConnection>
        this.peerStates = new Map();        // userId -> { state, relay, ping }
        this.videoSenders = new Map();      // userId -> RTCRtpSender (video)
        this.remoteAudios = new Map();      // userId -> <audio>
        this.remoteVideoTracks = new Map(); // userId -> MediaStreamTrack
        this.pendingCandidates = new Map(); // userId -> [candidate]
        this.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
        this.turnReady = Promise.resolve();

        this.localStream = null;
        this.videoStream = null;
        this.videoTrack = null;
        this.videoMode = null;              // null | 'camera' | 'screen'
        this.micState = 'pending';
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
            autoGainControl: this.settings.autoGainControl,
            sampleRate: { ideal: 48000 },
            channelCount: { ideal: 2 }
        };
    }

    getVideoConstraints() {
        const res = this.settings.videoResolution || '1080';
        const is720 = res === '720';
        const fps = res === '1080-60' ? 60 : 30;
        return {
            width: { ideal: is720 ? 1280 : 1920, max: 1920 },
            height: { ideal: is720 ? 720 : 1080, max: 1080 },
            frameRate: { ideal: fps, max: fps }
        };
    }

    getVideoMaxBitrate() {
        const res = this.settings.videoResolution || '1080';
        if (res === '1080-60') return 6_000_000; // 6 Mbps for 1080p60
        if (res === '720') return 2_500_000;     // 2.5 Mbps for 720p30
        return 4_000_000;                        // 4 Mbps for 1080p30
    }

    updateQualityPill() {
        const pill = $('quality-pill');
        if (!pill) return;
        const kbps = Math.round((Number(this.settings.audioBitrate) || 128000) / 1000);
        const res = this.settings.videoResolution === '720' ? '720p' : this.settings.videoResolution === '1080-60' ? '1080p60' : '1080p';
        pill.textContent = `${kbps} kbps · ${res}`;
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
                else if (action === 'camera') this.toggleCamera();
                else if (action === 'screen') this.toggleScreen();
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

        for (const key of ['echoCancellation', 'noiseSuppression', 'autoGainControl']) {
            const input = $(`opt-${key}`);
            input.checked = !!this.settings[key];
            input.addEventListener('change', () => this.updateSetting(key, input.checked));
        }

        const bitrateSelect = $('opt-audioBitrate');
        bitrateSelect.value = String(this.settings.audioBitrate || 128000);
        bitrateSelect.addEventListener('change', () => {
            this.settings.audioBitrate = Number(bitrateSelect.value);
            this.saveSettings();
            this.updateQualityPill();
            this.peers.forEach((pc, id) => this.applySenderBitrates(pc, id));
            this.toast(`Voice clarity set to ${Math.round(this.settings.audioBitrate / 1000)} kbps`);
        });

        const resSelect = $('opt-videoResolution');
        resSelect.value = String(this.settings.videoResolution || '1080');
        resSelect.addEventListener('change', async () => {
            this.settings.videoResolution = resSelect.value;
            this.saveSettings();
            this.updateQualityPill();
            if (this.videoTrack) {
                try { await this.videoTrack.applyConstraints(this.getVideoConstraints()); } catch { /* ignore */ }
            }
            this.peers.forEach((pc, id) => this.applySenderBitrates(pc, id));
            this.renderAppliedSettings();
        });

        this.updateQualityPill();
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

            if (!response.ok) return;
            const data = await response.json();
            if (Array.isArray(data)) {
                this.iceServers = data;
                console.log('✅ TURN credentials fetched');
            } else if (data && Array.isArray(data.iceServers)) {
                this.iceServers = data.iceServers;
                console.log('✅ Cloudflare TURN credentials fetched');
            }
        } catch (err) {
            console.warn('Failed to fetch TURN credentials, using fallback STUN:', err);
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
        this.stopVideoStream();
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

        for (const id of [...this.peers.keys()]) {
            if (!users.some((u) => u.id === id)) this.removePeer(id);
        }

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

        await Promise.all([this.audioReady, this.turnReady]);
        if (epoch !== this.roomEpoch) return null;
        if (this.peers.has(targetId)) return this.peers.get(targetId);

        console.log(`🔗 Creating peer connection to user ${targetId} (initiator: ${isInitiator})`);
        const pc = new RTCPeerConnection({
            iceServers: this.iceServers,
            iceTransportPolicy: 'all',
            iceCandidatePoolSize: 4
        });
        this.peers.set(targetId, pc);
        this.updatePeerStatus(targetId, 'connecting');

        pc.onconnectionstatechange = () => {
            const state = pc.connectionState;
            console.log(`🔌 Connection to user ${targetId}: ${state}`);
            if (this.peers.get(targetId) !== pc) return;
            this.updatePeerStatus(targetId, state);

            if (state === 'connected') {
                this.applySenderBitrates(pc, targetId);
            } else if (state === 'failed') {
                this.removePeer(targetId);
                if (this.userId > targetId) {
                    setTimeout(() => {
                        if (!this.peers.has(targetId) && this.users.some((u) => u.id === targetId)) {
                            this.createPeerConnection(targetId, true);
                        }
                    }, 2000);
                }
            }
        };

        // 1. Audio transceiver
        const audioTrack = this.localStream?.getAudioTracks()[0] || null;
        if (audioTrack) {
            pc.addTrack(audioTrack, this.localStream);
        } else {
            pc.addTransceiver('audio', { direction: 'recvonly' });
        }

        // 2. Pre-allocated 1080p video transceiver so camera/screen toggles hot-swap via replaceTrack()
        const videoTransceiver = pc.addTransceiver('video', { direction: 'sendrecv' });
        this.videoSenders.set(targetId, videoTransceiver.sender);
        if (this.videoTrack) {
            videoTransceiver.sender.replaceTrack(this.videoTrack).catch(() => { });
        }

        pc.ontrack = (event) => {
            if (event.track.kind === 'video') {
                console.log(`📹 Received video track from user ${targetId}`);
                this.remoteVideoTracks.set(targetId, event.track);
                event.track.onunmute = () => this.renderUsers();
                event.track.onmute = () => this.renderUsers();
                event.track.onended = () => this.renderUsers();
                this.renderUsers();
                return;
            }

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
                offer.sdp = enhanceOpusSdp(offer.sdp, this.settings.audioBitrate);
                await pc.setLocalDescription(offer);
                this.send({ type: 'offer', targetId, data: pc.localDescription });
            } catch (err) {
                console.error('Failed to create offer:', err);
            }
        }

        return pc;
    }

    async applySenderBitrates(pc, targetId) {
        try {
            for (const sender of pc.getSenders()) {
                if (!sender.track) continue;
                const params = sender.getParameters();
                if (!params.encodings || !params.encodings.length) params.encodings = [{}];
                if (sender.track.kind === 'audio') {
                    params.encodings[0].maxBitrate = Number(this.settings.audioBitrate) || 128000;
                    params.encodings[0].priority = 'high';
                    params.encodings[0].networkPriority = 'high';
                } else if (sender.track.kind === 'video') {
                    params.encodings[0].maxBitrate = this.getVideoMaxBitrate();
                    params.encodings[0].maxFramerate = this.settings.videoResolution === '1080-60' ? 60 : 30;
                }
                await sender.setParameters(params);
            }
        } catch (err) {
            console.warn(`Bitrate tuning skipped for peer ${targetId}:`, err);
        }
    }

    async handleOffer(senderId, offer) {
        let pc = this.peers.get(senderId);
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
            answer.sdp = enhanceOpusSdp(answer.sdp, this.settings.audioBitrate);
            await pc.setLocalDescription(answer);
            this.send({ type: 'answer', targetId: senderId, data: pc.localDescription });
        } catch (err) {
            console.error('Failed to handle offer:', err);
        }
    }

    async handleAnswer(senderId, answer) {
        const pc = this.peers.get(senderId);
        if (!pc || pc.signalingState !== 'have-local-offer') return;
        try {
            await pc.setRemoteDescription(answer);
            await this.flushCandidates(senderId, pc);
        } catch (err) {
            console.error('Failed to handle answer:', err);
        }
    }

    async handleIceCandidate(senderId, candidate) {
        const pc = this.peers.get(senderId);
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
        this.videoSenders.delete(userId);
        this.remoteVideoTracks.delete(userId);
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
            } catch { /* ignore */ }
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

    // ---------------------------------------------------------------- 1080p Camera & Screen Share

    async toggleCamera() {
        if (this.videoMode === 'camera') {
            await this.stopVideoStream();
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { ...this.getVideoConstraints(), facingMode: 'user' },
                audio: false
            });
            await this.startVideoStream(stream, 'camera');
        } catch (err) {
            console.error('Camera error:', err);
            this.toast('Camera access denied or unavailable');
        }
    }

    async toggleScreen() {
        if (this.videoMode === 'screen') {
            await this.stopVideoStream();
            return;
        }
        if (!navigator.mediaDevices.getDisplayMedia) {
            this.toast('Screen sharing is not supported on this device/browser');
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getDisplayMedia({
                video: { ...this.getVideoConstraints(), cursor: 'always' },
                audio: false
            });
            await this.startVideoStream(stream, 'screen');
        } catch (err) {
            if (err.name !== 'NotAllowedError') {
                console.error('Screen share error:', err);
                this.toast('Could not start screen share');
            }
        }
    }

    async startVideoStream(stream, mode) {
        this.videoStream?.getTracks().forEach((t) => t.stop());

        const track = stream.getVideoTracks()[0];
        if (!track) return;
        track.contentHint = mode === 'screen' ? 'detail' : 'motion';
        track.onended = () => {
            if (this.videoTrack === track) this.stopVideoStream();
        };

        this.videoStream = stream;
        this.videoTrack = track;
        this.videoMode = mode;

        await Promise.all([...this.videoSenders.entries()].map(async ([id, sender]) => {
            try {
                await sender.replaceTrack(track);
                const pc = this.peers.get(id);
                if (pc) await this.applySenderBitrates(pc, id);
            } catch (err) {
                console.warn('replaceTrack failed:', err);
            }
        }));

        const s = track.getSettings();
        if (s.width && s.height) {
            this.toast(`${mode === 'screen' ? 'Screen share' : 'Camera'} live at ${s.width}×${s.height}${s.frameRate ? ` @ ${Math.round(s.frameRate)}fps` : ''}`);
        }
        this.syncVideoButtons();
        this.applyVoiceState();
    }

    async stopVideoStream() {
        this.videoStream?.getTracks().forEach((t) => t.stop());
        this.videoStream = null;
        this.videoTrack = null;
        this.videoMode = null;

        await Promise.all([...this.videoSenders.values()].map((sender) =>
            sender.replaceTrack(null).catch(() => { })
        ));

        this.syncVideoButtons();
        this.applyVoiceState();
    }

    syncVideoButtons() {
        document.querySelectorAll('[data-action="camera"]').forEach((b) => {
            b.classList.toggle('active', this.videoMode === 'camera');
            b.title = this.videoMode === 'camera' ? 'Turn Off Camera' : 'Turn On Camera (1080p)';
        });
        document.querySelectorAll('[data-action="screen"]').forEach((b) => {
            b.classList.toggle('active', this.videoMode === 'screen');
            b.title = this.videoMode === 'screen' ? 'Stop Sharing Screen' : 'Share Your Screen (1080p)';
        });
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
            this.toast('Microphone blocked — you can listen and watch, but nobody can hear you.');
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

    async restartMicrophone() {
        if (this.restartingMic) {
            this.micRestartQueued = true;
            return;
        }
        this.restartingMic = true;
        try {
            do {
                this.micRestartQueued = false;
                this.teardownVoiceDetection();
                this.localStream?.getTracks().forEach((t) => t.stop());

                const stream = await navigator.mediaDevices.getUserMedia({ audio: this.getAudioConstraints(), video: false });
                const track = stream.getAudioTracks()[0];
                track.enabled = !this.isMuted;
                this.localStream = stream;

                await Promise.all([...this.peers.entries()].map(async ([id, pc]) => {
                    const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
                    if (sender) {
                        await sender.replaceTrack(track);
                        await this.applySenderBitrates(pc, id);
                    }
                }));

                this.setupVoiceDetection();
                this.micState = 'ok';
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
        $('my-status').textContent = this.isDeafened ? 'Deafened' : this.isMuted ? 'Muted' : this.videoMode ? 'Streaming HD' : 'Online';

        const me = this.users.find((u) => u.id === this.userId);
        if (me) {
            me.muted = this.isMuted;
            me.deafened = this.isDeafened;
            me.video = !!this.videoMode;
            me.screen = this.videoMode === 'screen';
            this.renderUsers();
        }
        this.send({
            type: 'voice-state',
            muted: this.isMuted,
            deafened: this.isDeafened,
            video: !!this.videoMode,
            screen: this.videoMode === 'screen'
        });
    }

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
        this.videoSenders.clear();
        this.remoteVideoTracks.clear();
        this.remoteAudios.forEach((a) => { a.srcObject = null; a.remove(); });
        this.remoteAudios.clear();
        this.pendingCandidates.clear();
        this.peerStates.clear();
        this.speakingUsers.clear();

        if (!isReconnect || roomChanged) this.resetChat(room);

        this.currentRoom = room;
        this.users = [];
        this.renderUsers();
        $('current-channel').textContent = room;
        $('vp-channel').textContent = room;
        $('chat-input').placeholder = `Message #${room}`;

        this.send({
            type: 'join',
            username: this.username,
            room,
            muted: this.isMuted,
            deafened: this.isDeafened,
            video: !!this.videoMode,
            screen: this.videoMode === 'screen'
        });
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
        if (member.screen) icons.insertAdjacentHTML('beforeend', '<span class="live-tag">LIVE</span>');
        else if (member.video) icons.insertAdjacentHTML('beforeend', ICONS.video(15));
        if (member.muted) icons.insertAdjacentHTML('beforeend', ICONS.micOff(16));
        if (member.deafened) icons.insertAdjacentHTML('beforeend', ICONS.headphonesOff(16));
        el.appendChild(icons);
        return el;
    }

    renderUsers() {
        const grid = $('user-list');
        grid.innerHTML = '';

        for (const user of this.users) {
            const isSelf = user.id === this.userId;
            const vTrack = isSelf ? this.videoTrack : this.remoteVideoTracks.get(user.id);
            const showVideo = !!(user.video && vTrack && vTrack.readyState === 'live');

            const tile = document.createElement('div');
            tile.className = 'tile'
                + (this.speakingUsers.has(user.id) ? ' speaking' : '')
                + (showVideo ? ' has-video' : '')
                + (user.screen ? ' screen-share' : isSelf && showVideo ? ' mirror' : '')
                + (this.expandedUserId === user.id ? ' expanded' : '');
            tile.dataset.userId = user.id;
            tile.style.setProperty('--c', colorFor(user.username));
            tile.appendChild(this.buildAvatar(user.username));

            if (showVideo) {
                const video = document.createElement('video');
                video.autoplay = true;
                video.playsInline = true;
                video.muted = true; // audio plays through the dedicated <audio> element
                video.srcObject = new MediaStream([vTrack]);
                video.play().catch(() => { });
                tile.appendChild(video);

                const live = document.createElement('div');
                live.className = 'live-badge';
                live.textContent = user.screen ? 'LIVE · SCREEN' : 'LIVE · HD';
                tile.appendChild(live);

                tile.addEventListener('click', () => {
                    this.expandedUserId = this.expandedUserId === user.id ? null : user.id;
                    this.renderUsers();
                });
                tile.addEventListener('dblclick', () => {
                    if (document.fullscreenElement) document.exitFullscreen().catch(() => { });
                    else tile.requestFullscreen?.().catch(() => { });
                });
            }

            const label = document.createElement('div');
            label.className = 'tile-label';
            label.textContent = user.username + (isSelf ? ' (you)' : '');
            tile.appendChild(label);

            if (user.muted || user.deafened) {
                const badges = document.createElement('div');
                badges.className = 'tile-badges';
                if (user.muted) badges.insertAdjacentHTML('beforeend', `<span class="tile-badge" title="Muted">${ICONS.micOff(16)}</span>`);
                if (user.deafened) badges.insertAdjacentHTML('beforeend', `<span class="tile-badge" title="Deafened">${ICONS.headphonesOff(16)}</span>`);
                tile.appendChild(badges);
            }

            if (!isSelf) {
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

    renderAppliedSettings() {
        const el = $('settings-applied');
        const track = this.localStream?.getAudioTracks()[0];
        if (!track) {
            el.textContent = 'Microphone is not active right now. Settings will apply when it starts.';
            return;
        }
        const s = track.getSettings();
        const fmt = (v) => (v === undefined ? 'n/a' : v ? 'on' : 'off');
        const vInfo = this.videoTrack ? (() => {
            const vs = this.videoTrack.getSettings();
            return ` · Video: ${vs.width || '?'}×${vs.height || '?'} @ ${Math.round(vs.frameRate || 30)}fps`;
        })() : '';
        el.textContent = `Browser audio: echo cancellation ${fmt(s.echoCancellation)}, `
            + `noise suppression ${fmt(s.noiseSuppression)}, auto gain ${fmt(s.autoGainControl)}`
            + (s.sampleRate ? `, ${Math.round(s.sampleRate / 1000)} kHz` : '')
            + vInfo
            + (track.label ? ` · ${track.label}` : '');
    }
}

window.voiceChat = new VoiceChat();
