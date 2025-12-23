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

        // Create audio container in DOM (needed for autoplay to work)
        this.audioContainer = document.createElement('div');
        this.audioContainer.id = 'audio-container';
        this.audioContainer.style.display = 'none';
        document.body.appendChild(this.audioContainer);

        this.initUI();
    }

    initUI() {
        // Login
        document.getElementById('join-btn').addEventListener('click', () => this.login());
        document.getElementById('username-input').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.login();
        });

        // Controls
        document.getElementById('mute-btn').addEventListener('click', () => this.toggleMute());
        document.getElementById('deafen-btn').addEventListener('click', () => this.toggleDeafen());
    }

    login() {
        const usernameInput = document.getElementById('username-input');
        this.username = usernameInput.value.trim() || 'User' + Math.floor(Math.random() * 1000);

        document.getElementById('login-screen').classList.add('hidden');
        document.getElementById('app-screen').classList.remove('hidden');
        document.getElementById('my-username').textContent = this.username;
        document.getElementById('my-avatar').textContent = this.username.charAt(0).toUpperCase();

        this.connect();
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

        this.ws.onerror = () => {
            this.updateConnectionStatus('Connection Error', 'error');
        };

        this.ws.onmessage = (event) => {
            const message = JSON.parse(event.data);
            this.handleMessage(message);
        };
    }

    handleMessage(message) {
        switch (message.type) {
            case 'joined':
                this.userId = message.userId;
                this.currentRoom = message.room;
                this.updateRoomList(message.rooms);
                this.initAudio();
                break;

            case 'user-list':
                this.updateUserList(message.users);
                // Create peer connections for existing users
                message.users.forEach(user => {
                    if (user.id !== this.userId && !this.peers.has(user.id)) {
                        this.createPeerConnection(user.id, true);
                    }
                });
                break;

            case 'user-joined':
                console.log(`${message.username} joined`);
                // New user will initiate connection to us
                break;

            case 'user-left':
                console.log(`${message.username} left`);
                this.removePeer(message.userId);
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
                this.updateSpeakingStatus(message.userId, message.speaking);
                break;

            case 'rooms':
                this.updateRoomList(message.rooms);
                break;
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

        const config = {
            iceServers: [
                // Google STUN servers
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' },
                { urls: 'stun:stun3.l.google.com:19302' },
                { urls: 'stun:stun4.l.google.com:19302' },
                // Twilio STUN
                { urls: 'stun:global.stun.twilio.com:3478' },
                // Free TURN servers from Metered (more reliable)
                {
                    urls: 'turn:a.relay.metered.ca:80',
                    username: 'e8dd65b92f92e7a5c5e29822',
                    credential: 'uWdWNmkhvyqTEuTB'
                },
                {
                    urls: 'turn:a.relay.metered.ca:80?transport=tcp',
                    username: 'e8dd65b92f92e7a5c5e29822',
                    credential: 'uWdWNmkhvyqTEuTB'
                },
                {
                    urls: 'turn:a.relay.metered.ca:443',
                    username: 'e8dd65b92f92e7a5c5e29822',
                    credential: 'uWdWNmkhvyqTEuTB'
                },
                {
                    urls: 'turn:a.relay.metered.ca:443?transport=tcp',
                    username: 'e8dd65b92f92e7a5c5e29822',
                    credential: 'uWdWNmkhvyqTEuTB'
                }
            ],
            iceCandidatePoolSize: 10
        };

        const pc = new RTCPeerConnection(config);
        this.peers.set(targetId, pc);

        // Monitor connection state
        pc.onconnectionstatechange = () => {
            console.log(`🔌 Connection to user ${targetId}: ${pc.connectionState}`);
            if (pc.connectionState === 'connected') {
                console.log(`✅ Successfully connected to user ${targetId}!`);
            } else if (pc.connectionState === 'failed') {
                console.error(`❌ Connection failed to user ${targetId} - will retry`);
                // Retry connection after failure
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
                this.ws.send(JSON.stringify({
                    type: 'ice-candidate',
                    targetId,
                    data: event.candidate
                }));
            }
        };

        // Create offer if initiator
        if (isInitiator) {
            try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);

                this.ws.send(JSON.stringify({
                    type: 'offer',
                    targetId,
                    data: offer
                }));
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
            try {
                await pc.setRemoteDescription(new RTCSessionDescription(answer));
                console.log(`✅ Answer processed for user ${senderId}`);
            } catch (err) {
                console.error('Failed to handle answer:', err);
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
                <span class="channel-icon">🔊</span>
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

    toggleMute() {
        this.isMuted = !this.isMuted;
        const btn = document.getElementById('mute-btn');
        btn.classList.toggle('muted', this.isMuted);
        btn.textContent = this.isMuted ? '🔇' : '🎤';

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
        btn.textContent = this.isDeafened ? '🔈' : '🔊';

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
