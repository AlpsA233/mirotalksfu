'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const RecordingStore = require('./RecordingStore');

const LOOPBACK = '127.0.0.1';

function randomId() {
    return crypto.randomUUID();
}

function safeName(value) {
    return String(value || 'track')
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .slice(0, 80);
}

function asNumber(value, fallback) {
    const number = Number.parseInt(value, 10);
    return Number.isFinite(number) ? number : fallback;
}

function waitForSpawn(command, args, options) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], ...options });
        let stderr = '';
        let settled = false;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            fn(value);
        };
        child.stderr.on('data', (chunk) => {
            stderr = (stderr + chunk.toString()).slice(-16 * 1024);
        });
        child.once('error', (error) => finish(reject, error));
        child.once('spawn', () => finish(resolve, { child, getStderr: () => stderr }));
    });
}

function waitForExit(child) {
    return new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
}

function stopChild(child, timeoutMs = 5000) {
    if (!child || child.exitCode !== null || child.killed) return Promise.resolve();
    return new Promise((resolve) => {
        const force = setTimeout(() => {
            if (child.exitCode === null) child.kill('SIGKILL');
        }, timeoutMs);
        force.unref?.();
        child.once('close', () => {
            clearTimeout(force);
            resolve();
        });
        child.kill('SIGINT');
    });
}

/**
 * Captures every mediasoup Producer to an independent file.  The class owns
 * all recording state transitions, including recovery and finalisation.  It
 * only waits for FFmpeg to bind and accept the SDP, never for a media frame;
 * this avoids a producer-paused/first-frame startup cycle.
 */
class ManagedRecording extends EventEmitter {
    constructor(config = {}, hooks = {}) {
        super();
        this.config = {
            enabled: Boolean(config.enabled),
            defaultEnabled: Boolean(config.defaultEnabled),
            storageDir: path.resolve(config.storageDir || '/data/recordings'),
            dbPath: path.resolve(config.dbPath || '/data/state/recordings.sqlite'),
            ffmpegPath: config.ffmpegPath || '/usr/bin/ffmpeg',
            ffprobePath: config.ffprobePath || '/usr/bin/ffprobe',
            rtpPortMin: asNumber(config.rtpPortMin, 42000),
            rtpPortMax: asNumber(config.rtpPortMax, 42999),
            recoveryMs: asNumber(config.recoveryMs, 30000),
            recoveryIntervalMs: asNumber(config.recoveryIntervalMs, 5000),
            shutdownTimeoutMs: asNumber(config.shutdownTimeoutMs, 10000),
        };
        this.hooks = hooks;
        this.store = null;
        this.meetings = new Map();
        this.nextPort = this.config.rtpPortMin;
        this.compositionQueue = Promise.resolve();
        this.backgroundJobs = new Set();
    }

    async initialize() {
        if (!this.config.enabled) return false;
        await fsp.mkdir(this.config.storageDir, { recursive: true });
        await fsp.mkdir(path.dirname(this.config.dbPath), { recursive: true });
        await fsp.access(this.config.ffmpegPath, fs.constants.X_OK);
        this.store = new RecordingStore(this.config.dbPath);
        if (this.store.getSetting('enabled', null) === null)
            this.store.setSetting('enabled', this.config.defaultEnabled);
        return true;
    }

    isAvailable() {
        return Boolean(this.store);
    }

    isEnabledForNewMeetings() {
        return this.isAvailable()
            ? this.store.getSetting('enabled', this.config.defaultEnabled) === true
            : this.config.defaultEnabled;
    }

    getSettings() {
        return { enabled: this.isEnabledForNewMeetings() };
    }

    setEnabled(enabled) {
        if (!this.store) throw new Error('Managed recording is unavailable');
        this.store.setSetting('enabled', Boolean(enabled));
        return this.getSettings();
    }

    /** Snapshot the global setting once per room instance. */
    async prepareMeeting(room) {
        if (!this.isAvailable()) {
            if (this.config.defaultEnabled) throw new Error('Managed recording is unavailable');
            return { required: false, state: 'disabled' };
        }
        const existing = this.meetings.get(room.getSessionId());
        if (existing) return { required: existing.required, meetingId: existing.id, state: existing.state };

        const required = this.isEnabledForNewMeetings();
        const meeting = {
            id: room.getSessionId(),
            room,
            roomId: room.id,
            required,
            state: required ? 'recording' : 'disabled',
            startedAt: Date.now(),
            tracks: new Map(),
            producerGates: new Map(),
            ending: null,
            recoveryTimers: new Map(),
        };
        this.meetings.set(meeting.id, meeting);
        if (required) {
            await fsp.mkdir(this.meetingDir(meeting), { recursive: true });
            this.store.createMeeting({
                id: meeting.id,
                roomId: room.id,
                startedAt: meeting.startedAt,
                recordingEnabled: true,
            });
            this.emit('status', { meetingId: meeting.id, state: meeting.state });
        }
        return { required, meetingId: meeting.id, state: meeting.state };
    }

    shouldGateProducer(room) {
        return this.meetings.get(room.getSessionId())?.required === true;
    }

    /**
     * Keep a server-side gate for each Producer.  A client can request to
     * resume while its recorder is still starting, but it cannot bypass the
     * gate: the desired state is remembered and reconciled once capture is
     * ready.
     */
    markProducerPending(room, peer, producer) {
        const meeting = this.meetings.get(room.getSessionId());
        if (!meeting?.required) return null;
        const gate = {
            producer,
            socketId: peer.id,
            ready: false,
            userPaused: false,
            track: null,
        };
        meeting.producerGates.set(producer.id, gate);
        return gate;
    }

    async setProducerUserPaused(room, producerId, paused) {
        const meeting = this.meetings.get(room.getSessionId());
        const gate = meeting?.producerGates.get(producerId);
        if (!gate) return false;
        gate.userPaused = Boolean(paused);
        if (gate.userPaused && !gate.producer.closed) await gate.producer.pause();
        if (!gate.userPaused) await this.reconcileProducerGate(gate);
        return true;
    }

    async reconcileProducerGate(gate) {
        if (!gate || gate.userPaused || !gate.ready || gate.producer.closed) return false;
        await gate.producer.resume();
        return true;
    }

    pauseProducerForRecording(track) {
        const gate = track.gate;
        if (gate) gate.ready = false;
        if (!track.producer.closed) track.producer.pause().catch(() => {});
    }

    hasActiveMeeting(room) {
        const meeting = this.meetings.get(room.getSessionId());
        return Boolean(meeting?.required && !meeting.ending && meeting.state === 'recording');
    }

    discardDisabledMeeting(room) {
        const meeting = this.meetings.get(room.getSessionId());
        if (meeting && !meeting.required) this.meetings.delete(meeting.id);
    }

    async captureProducer(room, peer, producer, { kind, mediaType }) {
        const prepared = await this.prepareMeeting(room);
        if (!prepared.required) return null;
        const meeting = this.meetings.get(prepared.meetingId);
        if (!meeting || meeting.state !== 'recording') throw new Error('Recording is not ready');

        const track = this.createTrackState(meeting, peer, producer, kind, mediaType);
        track.gate = meeting.producerGates.get(producer.id) || this.markProducerPending(room, peer, producer);
        track.gate.track = track;
        meeting.tracks.set(track.id, track);
        this.store.createTrack(track);
        try {
            await this.startTrack(track);
            this.store.updateTrack(track.id, { state: 'recording', timeline_json: JSON.stringify(track.timeline) });
            this.emit('status', { meetingId: meeting.id, state: 'recording', trackId: track.id });
            return track;
        } catch (error) {
            meeting.tracks.delete(track.id);
            meeting.producerGates.delete(producer.id);
            track.intentionalStop = true;
            await stopChild(track.child);
            await this.teardownTrackTransport(track).catch(() => {});
            this.store.updateTrack(track.id, { state: 'failed', ended_at: Date.now(), failure_reason: error.message });
            throw error;
        }
    }

    createTrackState(meeting, peer, producer, kind, mediaType) {
        const startedAt = Date.now();
        const trackId = randomId();
        const prefix = `${safeName(peer.peer_name)}-${safeName(mediaType)}-${trackId}`;
        const rawRelativePath = path.join('tracks', `${prefix}.mkv`);
        const codec = producer.rtpParameters?.codecs?.find((item) => item.mimeType?.toLowerCase() !== 'video/rtx');
        return {
            id: trackId,
            meetingId: meeting.id,
            meeting,
            socketId: peer.id,
            peerName: peer.peer_name || 'Participant',
            kind,
            mediaType: mediaType || kind,
            producerId: producer.id,
            producer,
            codecMimeType: codec?.mimeType?.toLowerCase() || '',
            codec: codec?.mimeType || null,
            resolution:
                producer.appData?.width && producer.appData?.height
                    ? `${producer.appData.width}x${producer.appData.height}`
                    : null,
            startedAt,
            state: 'starting',
            timeline: [{ type: 'started', at: startedAt, offsetMs: startedAt - meeting.startedAt }],
            rawRelativePath,
            rawPath: path.join(this.meetingDir(meeting), rawRelativePath),
            partialPath: path.join(this.meetingDir(meeting), `${rawRelativePath}.partial`),
            playbackRelativePath: null,
            child: null,
            consumer: null,
            transport: null,
            intentionalStop: false,
            failedAt: null,
            recoveryDeadline: null,
        };
    }

    meetingDir(meeting) {
        return path.join(this.config.storageDir, meeting.id);
    }

    allocatePorts() {
        const start = this.nextPort;
        const maxAttempts = Math.floor((this.config.rtpPortMax - this.config.rtpPortMin + 1) / 2);
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const rtpPort = this.nextPort;
            this.nextPort += 2;
            if (this.nextPort > this.config.rtpPortMax - 1) this.nextPort = this.config.rtpPortMin;
            if (rtpPort % 2 === 0) return { rtpPort, rtcpPort: rtpPort + 1 };
        }
        this.nextPort = start;
        throw new Error('No managed recording RTP port is available');
    }

    async startTrack(track) {
        await fsp.mkdir(path.dirname(track.partialPath), { recursive: true });
        const { rtpPort, rtcpPort } = this.allocatePorts();
        const transport = await track.meeting.room.router.createPlainTransport({
            listenInfo: { protocol: 'udp', ip: LOOPBACK },
            rtcpMux: false,
            comedia: false,
        });
        track.transport = transport;
        const consumer = await transport.consume({
            producerId: track.producer.id,
            rtpCapabilities: track.meeting.room.router.rtpCapabilities,
            paused: true,
        });
        track.consumer = consumer;
        const sdpPath = `${track.partialPath}.sdp`;
        await fsp.writeFile(sdpPath, this.createSdp(consumer, rtpPort, rtcpPort));

        const args = [
            '-nostdin',
            '-loglevel',
            'warning',
            '-protocol_whitelist',
            'file,udp,rtp',
            '-fflags',
            '+genpts',
            '-use_wallclock_as_timestamps',
            '1',
            '-i',
            sdpPath,
            '-map',
            '0:0',
            '-c',
            'copy',
            '-f',
            'matroska',
            track.partialPath,
        ];
        const processInfo = await waitForSpawn(this.config.ffmpegPath, args);
        track.child = processInfo.child;
        track.getStderr = processInfo.getStderr;
        track.sdpPath = sdpPath;
        track.child.once('close', (code, signal) => this.handleTrackExit(track, code, signal));
        transport.once('close', () => {
            if (!track.intentionalStop) this.scheduleRecovery(track, new Error('Recording transport closed'));
        });
        consumer.once('producerclose', () => this.stopTrack(track, 'producer_closed'));
        await transport.connect({ ip: LOOPBACK, port: rtpPort, rtcpPort });
        await consumer.resume();
        track.state = 'recording';
        if (track.gate) {
            track.gate.ready = true;
            await this.reconcileProducerGate(track.gate);
        }
    }

    createSdp(consumer, rtpPort, rtcpPort) {
        const codec = consumer.rtpParameters.codecs.find((item) => item.mimeType.toLowerCase() !== 'video/rtx');
        if (!codec) throw new Error('Recording consumer has no usable codec');
        const encoding = consumer.rtpParameters.encodings[0] || {};
        const media = codec.mimeType.split('/')[1];
        const channels = codec.channels ? `/${codec.channels}` : '';
        const parameters = Object.entries(codec.parameters || {})
            .map(([key, value]) => `${key}=${value}`)
            .join(';');
        return [
            'v=0',
            'o=- 0 0 IN IP4 127.0.0.1',
            's=MiroTalk managed recording',
            't=0 0',
            `c=IN IP4 ${LOOPBACK}`,
            `m=${consumer.kind} ${rtpPort} RTP/AVPF ${codec.payloadType}`,
            `a=rtcp:${rtcpPort} IN IP4 ${LOOPBACK}`,
            `a=rtpmap:${codec.payloadType} ${media}/${codec.clockRate}${channels}`,
            ...(parameters ? [`a=fmtp:${codec.payloadType} ${parameters}`] : []),
            ...(encoding.ssrc ? [`a=ssrc:${encoding.ssrc} cname:mirotalk-recording`] : []),
        ].join('\r\n');
    }

    handleTrackExit(track, code, signal) {
        if (track.intentionalStop) return;
        this.scheduleRecovery(track, new Error(`FFmpeg exited (${code ?? 'null'}${signal ? `, ${signal}` : ''})`));
    }

    scheduleRecovery(track, error) {
        const meeting = track.meeting;
        if (track.intentionalStop || meeting.ending || meeting.state !== 'recording') return;
        this.pauseProducerForRecording(track);
        if (!track.failedAt) {
            track.failedAt = Date.now();
            track.recoveryDeadline = track.failedAt + this.config.recoveryMs;
            track.timeline.push({
                type: 'failure',
                at: track.failedAt,
                offsetMs: track.failedAt - meeting.startedAt,
                reason: error.message,
            });
            this.store.updateTrack(track.id, {
                state: 'recovering',
                failure_reason: error.message,
                timeline_json: JSON.stringify(track.timeline),
            });
        }
        if (Date.now() >= track.recoveryDeadline) {
            this.failMeeting(meeting, `Recording could not recover: ${error.message}`);
            return;
        }
        if (meeting.recoveryTimers.has(track.id)) return;
        const timer = setTimeout(async () => {
            meeting.recoveryTimers.delete(track.id);
            try {
                await this.teardownTrackTransport(track);
                await this.startTrack(track);
                track.failedAt = null;
                track.recoveryDeadline = null;
                track.timeline.push({ type: 'recovered', at: Date.now(), offsetMs: Date.now() - meeting.startedAt });
                this.store.updateTrack(track.id, {
                    state: 'recording',
                    failure_reason: null,
                    timeline_json: JSON.stringify(track.timeline),
                });
            } catch (restartError) {
                this.scheduleRecovery(track, restartError);
            }
        }, this.config.recoveryIntervalMs);
        timer.unref?.();
        meeting.recoveryTimers.set(track.id, timer);
    }

    async failMeeting(meeting, reason) {
        if (meeting.ending || meeting.state === 'failed') return;
        meeting.state = 'failed';
        this.store.updateMeeting(meeting.id, { state: 'failed', failure_reason: reason, ended_at: Date.now() });
        this.emit('status', { meetingId: meeting.id, state: 'failed', reason });
        await this.hooks.onFatal?.(meeting.room, reason);
    }

    async failMeetingForRoom(room, reason) {
        const meeting = this.meetings.get(room.getSessionId());
        if (meeting) await this.failMeeting(meeting, reason);
    }

    async releaseProducer(room, producerId) {
        const meeting = this.meetings.get(room.getSessionId());
        if (!meeting) return;
        const track = [...meeting.tracks.values()].find((item) => item.producerId === producerId);
        if (track) await this.stopTrack(track, 'producer_closed');
        meeting.producerGates.delete(producerId);
    }

    async teardownTrackTransport(track) {
        if (track.consumer && !track.consumer.closed) track.consumer.close();
        if (track.transport && !track.transport.closed) track.transport.close();
        track.consumer = null;
        track.transport = null;
        if (track.sdpPath) await fsp.rm(track.sdpPath, { force: true });
        track.sdpPath = null;
    }

    async stopTrack(track, reason = 'stopped') {
        if (track.stopping) return track.stopping;
        track.stopping = (async () => {
            track.intentionalStop = true;
            const timer = track.meeting.recoveryTimers.get(track.id);
            if (timer) clearTimeout(timer);
            track.meeting.recoveryTimers.delete(track.id);
            const endedAt = Date.now();
            track.timeline.push({ type: reason, at: endedAt, offsetMs: endedAt - track.meeting.startedAt });
            await stopChild(track.child);
            await this.teardownTrackTransport(track);
            try {
                await fsp.rename(track.partialPath, track.rawPath);
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
            const stats = await this.fileStats(track.rawPath);
            track.state = 'finalizing';
            this.store.updateTrack(track.id, {
                ended_at: endedAt,
                state: 'finalizing',
                raw_path: track.rawRelativePath,
                bytes: stats.size,
                checksum: stats.checksum,
                timeline_json: JSON.stringify(track.timeline),
            });
            this.startBackground(
                this.generatePlayback(track).catch((error) => {
                    if (this.store)
                        this.store.updateTrack(track.id, { state: 'incomplete', failure_reason: error.message });
                })
            );
        })();
        return track.stopping;
    }

    async fileStats(filePath) {
        try {
            const stat = await fsp.stat(filePath);
            const hash = crypto.createHash('sha256');
            await new Promise((resolve, reject) => {
                const source = fs.createReadStream(filePath);
                source.on('data', (chunk) => hash.update(chunk));
                source.once('error', reject);
                source.once('end', resolve);
            });
            return { size: stat.size, checksum: hash.digest('hex') };
        } catch (error) {
            if (error.code === 'ENOENT') return { size: 0, checksum: null };
            throw error;
        }
    }

    async generatePlayback(track) {
        const webm = track.codecMimeType.includes('vp') || track.codecMimeType.includes('opus');
        const extension = webm ? 'webm' : 'mp4';
        const relativePath = path.join('playback', `${path.basename(track.rawRelativePath, '.mkv')}.${extension}`);
        const outputPath = path.join(this.meetingDir(track.meeting), relativePath);
        await fsp.mkdir(path.dirname(outputPath), { recursive: true });
        const args = ['-nostdin', '-y', '-loglevel', 'error', '-i', track.rawPath, '-c', 'copy', outputPath];
        const processInfo = await waitForSpawn(this.config.ffmpegPath, args);
        const exit = await waitForExit(processInfo.child);
        if (exit.code !== 0) throw new Error(`Playback remux failed: ${processInfo.getStderr() || exit.code}`);
        track.playbackRelativePath = relativePath;
        this.store.updateTrack(track.id, { state: 'ready', playback_path: relativePath });
    }

    startBackground(job) {
        let tracked;
        tracked = Promise.resolve(job).finally(() => this.backgroundJobs.delete(tracked));
        this.backgroundJobs.add(tracked);
        return tracked;
    }

    async finishMeeting(room, reason = 'ended') {
        const meeting = this.meetings.get(room.getSessionId());
        if (!meeting || !meeting.required) return;
        if (meeting.ending) return meeting.ending;
        meeting.ending = (async () => {
            const failed = meeting.state === 'failed';
            if (!failed) {
                meeting.state = 'finalizing';
                this.store.updateMeeting(meeting.id, { state: 'finalizing', ended_at: Date.now() });
            }
            await Promise.allSettled([...meeting.tracks.values()].map((track) => this.stopTrack(track, reason)));
            if (!failed) {
                meeting.state = 'ready';
                this.store.updateMeeting(meeting.id, { state: 'ready', ended_at: Date.now() });
            }
            this.emit('status', { meetingId: meeting.id, state: meeting.state });
            this.meetings.delete(meeting.id);
        })();
        return meeting.ending;
    }

    async shutdown() {
        const active = [...this.meetings.values()];
        const deadline = Date.now() + this.config.shutdownTimeoutMs;
        const waitWithinShutdownWindow = async (promise) => {
            const remaining = Math.max(0, deadline - Date.now());
            if (!remaining) return false;
            let timeout;
            const result = await Promise.race([
                Promise.resolve(promise).then(() => true),
                new Promise((resolve) => {
                    timeout = setTimeout(() => resolve(false), remaining);
                    timeout.unref?.();
                }),
            ]);
            clearTimeout(timeout);
            return result;
        };

        await waitWithinShutdownWindow(
            Promise.allSettled(active.map((meeting) => this.finishMeeting(meeting.room, 'server_shutdown')))
        );
        await waitWithinShutdownWindow(Promise.allSettled([...this.backgroundJobs]));

        // A process shutdown may cut off a large remux. Leave the SQLite
        // handle alive in that case so a still-running job cannot write after
        // close; the process owns final cleanup. A normal short shutdown
        // closes deterministically once all metadata writes have settled.
        if (this.backgroundJobs.size === 0) this.store?.close();
    }

    getMeeting(meetingId) {
        const meeting = this.store?.getMeeting(meetingId);
        return meeting ? { ...meeting, tracks: this.store.listTracks(meetingId) } : null;
    }

    listMeetings(options) {
        return this.store?.listMeetings(options) || [];
    }

    getAsset(meetingId, assetId, { publicOnly = false } = {}) {
        const meeting = this.getMeeting(meetingId);
        if (!meeting) return null;
        if (assetId === 'composition' && meeting.composition_path) {
            return {
                path: path.join(this.config.storageDir, meeting.id, meeting.composition_path),
                type: 'video/mp4',
                public: true,
            };
        }
        const track = meeting.tracks.find((item) => item.id === assetId);
        if (!track) return null;
        if (publicOnly && !track.playback_path) return null;
        const relativePath = publicOnly ? track.playback_path : track.playback_path || track.raw_path;
        if (!relativePath) return null;
        return {
            path: path.join(this.config.storageDir, meeting.id, relativePath),
            type: relativePath.endsWith('.webm')
                ? 'video/webm'
                : relativePath.endsWith('.mkv')
                  ? 'video/x-matroska'
                  : 'video/mp4',
            public: Boolean(track.playback_path),
        };
    }

    async queueComposition(meetingId, primaryTrackId = null) {
        if (!this.store) throw new Error('Managed recording is unavailable');
        const run = async () => this.composeMeeting(meetingId, primaryTrackId);
        this.compositionQueue = this.compositionQueue.then(run, run);
        return this.compositionQueue;
    }

    async composeMeeting(meetingId, primaryTrackId) {
        const meeting = this.getMeeting(meetingId);
        if (!meeting) throw new Error('Meeting not found');
        const videos = meeting.tracks.filter(
            (track) => track.kind === 'video' && track.raw_path && track.state !== 'failed'
        );
        const audio = meeting.tracks.filter(
            (track) => track.kind === 'audio' && track.raw_path && track.state !== 'failed'
        );
        if (!videos.length && !audio.length) throw new Error('No recorded media is available');
        this.store.updateMeeting(meetingId, { composition_state: 'running' });
        const selectedPrimaryTrackId =
            primaryTrackId ||
            videos.find((track) =>
                String(track.media_type || '')
                    .toLowerCase()
                    .includes('screen')
            )?.id ||
            null;
        const orderedVideos = selectedPrimaryTrackId
            ? [...videos].sort((a, b) =>
                  a.id === selectedPrimaryTrackId ? -1 : b.id === selectedPrimaryTrackId ? 1 : 0
              )
            : videos;
        const inputs = [...orderedVideos, ...audio];
        const args = ['-nostdin', '-y', '-loglevel', 'error'];
        for (const track of inputs) {
            const offset = Math.max(0, track.started_at - meeting.started_at) / 1000;
            args.push(
                '-itsoffset',
                String(offset),
                '-i',
                path.join(this.config.storageDir, meeting.id, track.raw_path)
            );
        }
        const videoInputs = orderedVideos.map((_, index) => index);
        const audioInputs = audio.map((_, index) => orderedVideos.length + index);
        const filters = [];
        if (videoInputs.length) {
            const labels = videoInputs.map(
                (index) =>
                    `[${index}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2[v${index}]`
            );
            filters.push(...labels);
            if (videoInputs.length === 1) filters.push('[v0]null[vout]');
            else {
                const cols = Math.ceil(Math.sqrt(videoInputs.length));
                const rows = Math.ceil(videoInputs.length / cols);
                const width = Math.floor(1920 / cols);
                const height = Math.floor(1080 / rows);
                filters.push(
                    videoInputs.map((index) => `[v${index}]scale=${width}:${height}[g${index}]`).join(';') +
                        ';' +
                        videoInputs.map((index) => `[g${index}]`).join('') +
                        `xstack=inputs=${videoInputs.length}:layout=${videoInputs
                            .map((_, index) => `${(index % cols) * width}_${Math.floor(index / cols) * height}`)
                            .join('|')}[vout]`
                );
            }
        }
        if (audioInputs.length)
            filters.push(
                `${audioInputs.map((index) => `[${index}:a]`).join('')}amix=inputs=${audioInputs.length}:duration=longest[aout]`
            );
        const tempRelativePath = path.join('composition', 'current.partial.mp4');
        const outputRelativePath = path.join('composition', 'current.mp4');
        const tempPath = path.join(this.config.storageDir, meeting.id, tempRelativePath);
        const outputPath = path.join(this.config.storageDir, meeting.id, outputRelativePath);
        await fsp.mkdir(path.dirname(tempPath), { recursive: true });
        if (filters.length) args.push('-filter_complex', filters.join(';'));
        if (videoInputs.length)
            args.push('-map', '[vout]', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p');
        if (audioInputs.length) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '128k');
        args.push('-movflags', '+faststart', tempPath);
        const processInfo = await waitForSpawn(this.config.ffmpegPath, args);
        const exit = await waitForExit(processInfo.child);
        if (exit.code !== 0) {
            this.store.updateMeeting(meetingId, { composition_state: 'failed' });
            throw new Error(`Composition failed: ${processInfo.getStderr() || exit.code}`);
        }
        await fsp.rename(tempPath, outputPath);
        this.store.updateMeeting(meetingId, {
            composition_state: 'ready',
            composition_path: outputRelativePath,
            composition_updated_at: Date.now(),
        });
        return this.getMeeting(meetingId);
    }
}

module.exports = ManagedRecording;
