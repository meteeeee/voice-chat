// Voice Chat Client
class VoiceChat {
    constructor() {
        this.ws = null;
        this.userId = null;
        this.username = '';
        this.currentRoom = 'General';
        this.peers = new Map(); // userId -> RTCPeerConnection
        this.remoteAudios = new Map(); // userId -> Audio element
        this.localStream = null;
        this.isMuted = false;
        this.isDeafened = false;
        this.isSpeaking = false;
        this.speakingThreshold = 0.02;
        this.silenceTimeout = null;
        this.pendingCandidates = new Map(); // userId -> Array of candidates
        this.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }]; // Default fallback

        // Create audio container in DOM (needed for autoplay to work)
        this.audioContainer = document.createElement('div');
        this.audioContainer.id = 'audio-container';
        this.audioContainer.style.display = 'none';
        document.body.appendChild(this.audioContainer);

        this.initUI();
    }

    initUI() {
        console.log('Initializing UI...');
        // Global error handler for debugging
        window.onerror = function (msg, url, line, col, error) {
            alert(`Error: ${msg}\nLine: ${line}`);
            return false;
        };

        // Login
        const joinBtn = document.getElementById('join-btn');
        if (joinBtn) {
            joinBtn.addEventListener('click', () => this.login());
            console.log('Join button listener attached');
        } else {
            console.error('Join button not found!');
        }

        const usernameInput = document.getElementById('username-input');
        if (usernameInput) {
            usernameInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') this.login();
            });
        }

        // Controls
        document.getElementById('mute-btn').addEventListener('click', () => this.toggleMute());
        document.getElementById('deafen-btn').addEventListener('click', () => this.toggleDeafen());

        // Chat UI Event Listeners
        const chatInput = document.getElementById('chat-input');
        const sendChatBtn = document.getElementById('send-chat-btn');
        if (sendChatBtn && chatInput) {
            sendChatBtn.addEventListener('click', () => this.sendChatMessage());
            chatInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') this.sendChatMessage();
            });
        }
    }

    async login() {
        try {
            console.log('Login clicked');
            const usernameInput = document.getElementById('username-input');
            this.username = usernameInput.value.trim() || 'User' + Math.floor(Math.random() * 1000);

            // Fetch dynamic TURN credentials securely from our own backend proxy!
            try {
                const response = await fetch("/turn-credentials");
                if (response.ok) {
                    const data = await response.json();
                    if (Array.isArray(data)) {
                        this.iceServers = data;
                        console.log("Successfully fetched TURN credentials");
                    } else {
                        console.warn("Fetched credentials are not in expected array format, using fallback STUN:", data);
                    }
                } else {
                    console.warn(`Server returned status ${response.status} for TURN credentials, using fallback STUN`);
                }
            } catch (err) {
                console.error("Failed to fetch TURN credentials, using fallback STUN", err);
            }

            document.getElementById('login-screen').classList.add('hidden');
            document.getElementById('app-screen').classList.remove('hidden');
            document.getElementById('my-username').textContent = this.username;
            document.getElementById('my-avatar').textContent = this.username.charAt(0).toUpperCase();

            // Auto-unlock AudioContext using the user's click gesture of the Join button
            try {
                const AudioContext = window.AudioContext || window.webkitAudioContext;
                const ctx = new AudioContext();
                await ctx.resume();
                console.log('Audio Context Resumed automatically via Join click');

                // Play a brief test beep to confirm audio works
                const osc = ctx.createOscillator();
                osc.connect(ctx.destination);
                osc.frequency.value = 440;
                osc.start();
                osc.stop(ctx.currentTime + 0.1);
            } catch (err) {
                console.warn('Failed to auto-resume AudioContext:', err);
            }

            this.connect();
        } catch (e) {
            alert('Login failed: ' + e.message);
            console.error(e);
        }
    }

    connect() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}`;

        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            this.updateConnectionStatus('Connected', 'connected');
            this.joinRoom(this.currentRoom);
        };

        this.ws.onclose = () => {
            this.updateConnectionStatus('Disconnected - Reconnecting...', 'error');
            setTimeout(() => this.connect(), 3000);
        };

        this.ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            this.updateConnectionStatus('Connection Error', 'error');
        };

        this.ws.onmessage = (event) => {
            const message = JSON.parse(event.data);
            console.log(`📥 Received message: ${message.type}`, message);
            this.handleMessage(message);
        };
    }

    handleMessage(message) {
        switch (message.type) {
            case 'joined':
                console.log(`✅ Joined as user ${message.userId} in room ${message.room}`);
                this.userId = message.userId;
                this.currentRoom = message.room;
                this.updateRoomList(message.rooms);
                this.initAudio();
                break;

            case 'user-list':
                console.log(`👥 User list received:`, message.users);
                this.updateUserList(message.users);
                // Create peer connections for existing users
                message.users.forEach(user => {
                    if (user.id !== this.userId && !this.peers.has(user.id)) {
                        console.log(`🔗 Will create peer connection to user ${user.id}`);
                        this.createPeerConnection(user.id, true);
                    }
                });
                break;

            case 'user-joined':
                console.log(`➡️ ${message.username} (user ${message.userId}) joined`);
                // New user will initiate connection to us
                break;

            case 'user-left':
                console.log(`⬅️ ${message.username} (user ${message.userId}) left`);
                this.removePeer(message.userId);
                break;

            case 'offer':
                console.log(`📨 RECEIVED OFFER from user ${message.senderId}!`);
                this.handleOffer(message.senderId, message.data);
                break;

            case 'answer':
                console.log(`📨 RECEIVED ANSWER from user ${message.senderId}!`);
                this.handleAnswer(message.senderId, message.data);
                break;

            case 'ice-candidate':
                console.log(`🧊 RECEIVED ICE CANDIDATE from user ${message.senderId}`);
                this.handleIceCandidate(message.senderId, message.data);
                break;

            case 'speaking':
                this.updateSpeakingStatus(message.userId, message.speaking);
                break;

            case 'chat':
                this.appendChatMessage(message.userId, message.username, message.text);
                break;

            case 'rooms':
                this.updateRoomList(message.rooms);
                break;

            default:
                console.log(`❓ Unknown message type: ${message.type}`, message);
        }
    }

    async initAudio() {
        try {
            this.localStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                },
                video: false
            });

            this.setupVoiceDetection();
            this.updateConnectionStatus('Voice Connected', 'connected');
            document.getElementById('voice-indicator').classList.remove('inactive');

        } catch (err) {
            console.error('Failed to get audio:', err);
            this.updateConnectionStatus('Microphone access denied', 'error');
        }
    }

    setupVoiceDetection() {
        const audioContext = new AudioContext();
        const analyser = audioContext.createAnalyser();
        const microphone = audioContext.createMediaStreamSource(this.localStream);

        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.4;
        microphone.connect(analyser);

        const dataArray = new Uint8Array(analyser.frequencyBinCount);

        const checkVolume = () => {
            if (this.isMuted) {
                requestAnimationFrame(checkVolume);
                return;
            }

            analyser.getByteFrequencyData(dataArray);

            // Calculate average volume
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) {
                sum += dataArray[i];
            }
            const average = sum / dataArray.length / 255;

            if (average > this.speakingThreshold) {
                if (!this.isSpeaking) {
                    this.isSpeaking = true;
                    this.sendSpeakingStatus(true);
                }

                // Reset silence timeout
                if (this.silenceTimeout) {
                    clearTimeout(this.silenceTimeout);
                }
                this.silenceTimeout = setTimeout(() => {
                    this.isSpeaking = false;
                    this.sendSpeakingStatus(false);
                }, 300);
            }

            requestAnimationFrame(checkVolume);
        };

        checkVolume();
    }

    sendSpeakingStatus(speaking) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'speaking', speaking }));
        }
    }

    async createPeerConnection(targetId, isInitiator) {
        // Wait for local stream to be ready
        if (!this.localStream) {
            console.warn('Local stream not ready, waiting...');
            await new Promise(resolve => {
                const checkStream = setInterval(() => {
                    if (this.localStream) {
                        clearInterval(checkStream);
                        resolve();
                    }
                }, 100);
            });
        }

        console.log(`🔗 Creating peer connection to user ${targetId} (initiator: ${isInitiator})`);

        // Check if we have valid TURN credentials. If we only have STUN, forcing 'relay' will fail.
        const hasTurn = this.iceServers.some(server => {
            if (!server || !server.urls) return false;
            const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
            return urls.some(url => url.startsWith('turn:') || url.startsWith('turns:'));
        });

        const config = {
            iceServers: this.iceServers,
            iceTransportPolicy: hasTurn ? 'relay' : 'all', // Fallback to 'all' if no TURN server is available (like on local file:/// or fallback STUN testing)
            iceCandidatePoolSize: 10
        };

        const pc = new RTCPeerConnection(config);
        this.peers.set(targetId, pc);

        // Process any pending ICE candidates
        if (this.pendingCandidates.has(targetId)) {
            const candidates = this.pendingCandidates.get(targetId);
            console.log(`🧊 Processing ${candidates.length} pending ICE candidates for user ${targetId}`);
            for (const candidate of candidates) {
                try {
                    await pc.addIceCandidate(new RTCIceCandidate(candidate));
                } catch (err) {
                    console.error('Failed to add pending ICE candidate:', err);
                }
            }
            this.pendingCandidates.delete(targetId);
        }

        // Monitor connection state
        pc.onconnectionstatechange = () => {
            console.log(`🔌 Connection to user ${targetId}: ${pc.connectionState}`);
            this.updatePeerStatus(targetId, pc.connectionState);

            if (pc.connectionState === 'connected') {
                console.log(`✅ Successfully connected to user ${targetId}!`);
            } else if (pc.connectionState === 'failed') {
                console.error(`❌ Connection failed to user ${targetId} - will retry`);
                this.peers.delete(targetId);
                setTimeout(() => {
                    if (!this.peers.has(targetId)) {
                        this.createPeerConnection(targetId, true);
                    }
                }, 2000);
            }
        };

        pc.oniceconnectionstatechange = () => {
            console.log(`🧊 ICE state for user ${targetId}: ${pc.iceConnectionState}`);
        };

        pc.onicegatheringstatechange = () => {
            console.log(`📡 ICE gathering for user ${targetId}: ${pc.iceGatheringState}`);
        };

        // Add local stream tracks
        console.log(`Adding local stream tracks to peer ${targetId}`);
        this.localStream.getTracks().forEach(track => {
            pc.addTrack(track, this.localStream);
            console.log(`Added track: ${track.kind}`);
        });

        // Handle incoming stream
        pc.ontrack = (event) => {
            console.log(`Received audio track from user ${targetId}`);

            // Remove existing audio for this user if any
            if (this.remoteAudios.has(targetId)) {
                const oldAudio = this.remoteAudios.get(targetId);
                oldAudio.srcObject = null;
                oldAudio.remove();
            }

            // Create audio element attached to DOM (required for autoplay)
            const audio = document.createElement('audio');
            audio.id = `audio-${targetId}`;
            audio.autoplay = true;
            audio.playsInline = true;
            audio.srcObject = event.streams[0];
            audio.muted = this.isDeafened;

            // Add to DOM container
            this.audioContainer.appendChild(audio);
            this.remoteAudios.set(targetId, audio);

            // Try to play with retry on user interaction
            const playAudio = () => {
                audio.play()
                    .then(() => console.log(`Audio playing for user ${targetId}`))
                    .catch(e => {
                        console.warn('Audio autoplay blocked, will play on user interaction:', e);
                        // Add one-time click listener to start audio
                        const startAudio = () => {
                            audio.play().catch(err => console.error('Still cannot play:', err));
                            document.removeEventListener('click', startAudio);
                        };
                        document.addEventListener('click', startAudio);
                    });
            };
            playAudio();
        };

        // Handle ICE candidates
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                console.log(`🧊 Sending ICE candidate to user ${targetId}`);
                this.ws.send(JSON.stringify({
                    type: 'ice-candidate',
                    targetId,
                    data: event.candidate
                }));
            } else {
                console.log(`🧊 ICE gathering complete for user ${targetId}`);
            }
        };

        // Create offer if initiator
        if (isInitiator) {
            try {
                console.log(`📤 Creating offer for user ${targetId}...`);
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);

                console.log(`📤 Sending offer to user ${targetId}`);
                this.ws.send(JSON.stringify({
                    type: 'offer',
                    targetId,
                    data: offer
                }));
                console.log(`✅ Offer sent to user ${targetId}`);
            } catch (err) {
                console.error('Failed to create offer:', err);
            }
        }

        return pc;
    }

    async handleOffer(senderId, offer) {
        console.log(`📨 Received offer from user ${senderId}`);
        let pc = this.peers.get(senderId);
        if (!pc) {
            pc = await this.createPeerConnection(senderId, false);
        }

        try {
            await pc.setRemoteDescription(new RTCSessionDescription(offer));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            console.log(`📤 Sending answer to user ${senderId}`);
            this.ws.send(JSON.stringify({
                type: 'answer',
                targetId: senderId,
                data: answer
            }));
        } catch (err) {
            console.error('Failed to handle offer:', err);
        }
    }

    async handleAnswer(senderId, answer) {
        console.log(`📨 Received answer from user ${senderId}`);
        const pc = this.peers.get(senderId);
        if (pc) {
            // Avoid setting answer if already connected/stable
            if (pc.signalingState === 'stable') {
                console.warn(`⚠️ Ignoring answer from user ${senderId} because connection is already stable.`);
                return;
            }

            try {
                await pc.setRemoteDescription(new RTCSessionDescription(answer));
                console.log(`✅ Answer processed for user ${senderId}`);
            } catch (err) {
                console.error('Failed to handle answer:', err);
                // Don't retry immediately to avoid loops
            }
        }
    }

    async handleIceCandidate(senderId, candidate) {
        const pc = this.peers.get(senderId);
        if (pc) {
            try {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (err) {
                console.error('Failed to add ICE candidate:', err);
            }
        } else {
            console.log(`⏳ Queueing ICE candidate for user ${senderId} (PC not ready)`);
            if (!this.pendingCandidates.has(senderId)) {
                this.pendingCandidates.set(senderId, []);
            }
            this.pendingCandidates.get(senderId).push(candidate);
        }
    }

    removePeer(userId) {
        const pc = this.peers.get(userId);
        if (pc) {
            pc.close();
            this.peers.delete(userId);
        }

        // Clean up audio element
        const audio = this.remoteAudios.get(userId);
        if (audio) {
            audio.srcObject = null;
            audio.remove();
            this.remoteAudios.delete(userId);
        }
    }

    joinRoom(roomName) {
        // Close existing peer connections
        this.peers.forEach(pc => pc.close());
        this.peers.clear();

        // Clean up all audio elements
        this.remoteAudios.forEach(audio => {
            audio.srcObject = null;
            audio.remove();
        });
        this.remoteAudios.clear();

        // Clear chat messages (no logs/persistence!)
        const chatMessages = document.getElementById('chat-messages');
        if (chatMessages) {
            chatMessages.innerHTML = '';
        }

        // Update input placeholder to show current channel name
        const chatInput = document.getElementById('chat-input');
        if (chatInput) {
            chatInput.placeholder = `Message #${roomName}`;
        }

        this.currentRoom = roomName;
        document.getElementById('current-channel').textContent = roomName;

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                type: 'join',
                username: this.username,
                room: roomName
            }));
        }

        // Update active channel in UI
        document.querySelectorAll('.channel').forEach(ch => {
            ch.classList.toggle('active', ch.dataset.room === roomName);
        });
    }

    updateRoomList(rooms) {
        const container = document.getElementById('channel-list');
        container.innerHTML = '';

        for (const [roomName, userCount] of Object.entries(rooms)) {
            const channel = document.createElement('div');
            channel.className = 'channel' + (roomName === this.currentRoom ? ' active' : '');
            channel.dataset.room = roomName;
            channel.innerHTML = `
                <span class="channel-icon">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
                </span>
                <span class="channel-name">${roomName}</span>
                <span class="channel-count">${userCount}</span>
            `;
            channel.addEventListener('click', () => this.joinRoom(roomName));
            container.appendChild(channel);
        }
    }

    updateUserList(users) {
        const container = document.getElementById('user-list');
        container.innerHTML = '';

        users.forEach(user => {
            const userItem = document.createElement('div');
            userItem.className = 'user-item' + (user.speaking ? ' speaking' : '');
            userItem.id = `user-${user.id}`;
            userItem.innerHTML = `
                <div class="user-avatar">${user.username.charAt(0).toUpperCase()}</div>
                <span>${user.username}${user.id === this.userId ? ' (You)' : ''}</span>
            `;
            container.appendChild(userItem);
        });
    }

    updateSpeakingStatus(userId, speaking) {
        const userItem = document.getElementById(`user-${userId}`);
        if (userItem) {
            userItem.classList.toggle('speaking', speaking);
        }
    }

    updatePeerStatus(userId, state) {
        const userItem = document.getElementById(`user-${userId}`);
        if (userItem) {
            let statusSpan = userItem.querySelector('.peer-status');
            if (!statusSpan) {
                statusSpan = document.createElement('span');
                statusSpan.className = 'peer-status';
                statusSpan.style.fontSize = '0.8em';
                statusSpan.style.marginLeft = '8px';
                userItem.appendChild(statusSpan);
            }

            if (state === 'connected') {
                statusSpan.innerHTML = '<span class="status-dot connected"></span>';
                statusSpan.title = "Connected";
            } else if (state === 'connecting' || state === 'checking') {
                statusSpan.innerHTML = '<span class="status-dot checking"></span>';
                statusSpan.title = "Connecting...";
            } else if (state === 'failed' || state === 'disconnected') {
                statusSpan.innerHTML = '<span class="status-dot disconnected"></span>';
                statusSpan.title = "Disconnected";
            } else {
                statusSpan.innerHTML = '';
            }
        }
    }

    sendChatMessage() {
        const chatInput = document.getElementById('chat-input');
        if (!chatInput) return;
        const text = chatInput.value.trim();
        if (!text) return;

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                type: 'chat',
                text: text
            }));
            chatInput.value = '';
        }
    }

    appendChatMessage(senderId, senderName, text) {
        const chatMessages = document.getElementById('chat-messages');
        if (!chatMessages) return;

        const isSelf = senderId === this.userId;
        const messageItem = document.createElement('div');
        messageItem.className = `message-item ${isSelf ? 'self' : 'other'}`;

        const meta = document.createElement('div');
        meta.className = 'message-meta';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'message-username';
        nameSpan.textContent = isSelf ? 'You' : senderName;
        const timeSpan = document.createElement('span');
        timeSpan.className = 'message-time';
        timeSpan.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        
        meta.appendChild(nameSpan);
        meta.appendChild(timeSpan);

        const bubble = document.createElement('div');
        bubble.className = 'message-bubble';
        bubble.textContent = text;

        messageItem.appendChild(meta);
        messageItem.appendChild(bubble);
        chatMessages.appendChild(messageItem);

        // Auto scroll to bottom
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    toggleMute() {
        this.isMuted = !this.isMuted;
        const btn = document.getElementById('mute-btn');
        btn.classList.toggle('muted', this.isMuted);

        if (this.localStream) {
            this.localStream.getAudioTracks().forEach(track => {
                track.enabled = !this.isMuted;
            });
        }

        if (this.isMuted && this.isSpeaking) {
            this.isSpeaking = false;
            this.sendSpeakingStatus(false);
        }
    }

    toggleDeafen() {
        this.isDeafened = !this.isDeafened;
        const btn = document.getElementById('deafen-btn');
        btn.classList.toggle('muted', this.isDeafened);

        // Mute/unmute all incoming audio
        this.remoteAudios.forEach(audio => {
            audio.muted = this.isDeafened;
        });
    }

    updateConnectionStatus(text, className) {
        const status = document.getElementById('connection-status');
        status.textContent = text;
        status.className = className || '';
    }
}

// Start the app
const voiceChat = new VoiceChat();
