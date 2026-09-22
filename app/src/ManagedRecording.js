'use strict';

const crypto = require('node:crypto');
const dgram = require('node:dgram');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const RecordingStore = require('./RecordingStore');
const { playbackViews, describeViews, renderPlayback, normalizeAudio } = require('./RecordingPlayback');

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
        // FFmpeg 5.x needs a second signal to interrupt a blocked live-input
        // read after transcode initialization. Give it time to flush the muxer
        // before the final SIGKILL fallback, including when RTP has stopped.
        const interrupt = setTimeout(
            () => {
                if (child.exitCode === null && child.signalCode === null) child.kill('SIGINT');
            },
            Math.min(1000, timeoutMs / 2)
        );
        interrupt.unref?.();
        const force = setTimeout(() => {
            if (child.exitCode === null) child.kill('SIGKILL');
        }, timeoutMs);
        force.unref?.();
        child.once('close', () => {
            clearTimeout(interrupt);
            clearTimeout(force);
            resolve();
        });
        child.kill('SIGINT');
    });
}

async function finishRtpInput(track) {
    const { child, rtcpPort, recordingSsrc } = track;
    if (!child || child.exitCode !== null || child.signalCode !== null || !rtcpPort || !recordingSsrc) return;

    // End the live input before signalling FFmpeg so it can flush the muxer.
    // Include a BYE reason: FFmpeg 5.x drops RTP/RTCP packets shorter than 12 bytes.
    const bye = Buffer.alloc(12);
    bye[0] = 0x81;
    bye[1] = 203;
    bye.writeUInt16BE(2, 2);
    bye.writeUInt32BE(recordingSsrc, 4);
    bye[8] = 3;
    bye.write('end', 9);

    await new Promise((resolve) => {
        const socket = dgram.createSocket('udp4');
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.removeListener('close', done);
            try {
                socket.close();
            } catch {
                // A failed bind can leave the socket already closed.
            }
            resolve();
        };
        const timer = setTimeout(done, 1500);
        child.once('close', done);
        socket.once('error', done);
        socket.send(bye, rtcpPort, LOOPBACK, (error) => {
            if (error) done();
        });
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
        this.meetingJobs = new Map();
        this.deletingMeetings = new Set();
        this.playbackJobs = new Map();
        this.compositionJobs = new Map();
    }

    async initialize() {
        if (!this.config.enabled) return false;
        await fsp.mkdir(this.config.storageDir, { recursive: true });
        await fsp.mkdir(path.dirname(this.config.dbPath), { recursive: true });
        await fsp.access(this.config.ffmpegPath, fs.constants.X_OK);
        this.store = new RecordingStore(this.config.dbPath);
        if (this.store.getSetting('enabled', null) === null)
            this.store.setSetting('enabled', this.config.defaultEnabled);
        // Reserve every pending meeting against deletion immediately, but
        // recover them serially so a restart cannot spawn an unbounded number
        // of media converters at once.
        let recoveryQueue = Promise.resolve();
        for (const meeting of this.store.listUnfinishedMeetings()) {
            const recover = () => this.recoverUnfinishedMeeting(meeting);
            recoveryQueue = this.startBackground(recoveryQueue.then(recover, recover), meeting.id);
        }
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
            recoveries: new Map(),
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
        const ensureActive = () => {
            if (track.intentionalStop || track.meeting.ending || track.meeting.state !== 'recording')
                throw new Error('Recording stopped during startup');
        };
        await fsp.mkdir(path.dirname(track.partialPath), { recursive: true });
        ensureActive();
        const { rtpPort, rtcpPort } = this.allocatePorts();
        track.rtcpPort = rtcpPort;
        const transport = await track.meeting.room.router.createPlainTransport({
            listenInfo: { protocol: 'udp', ip: LOOPBACK },
            rtcpMux: false,
            comedia: false,
        });
        track.transport = transport;
        ensureActive();
        const consumer = await transport.consume({
            producerId: track.producer.id,
            rtpCapabilities: track.meeting.room.router.rtpCapabilities,
            paused: true,
        });
        track.consumer = consumer;
        ensureActive();
        track.recordingSsrc = consumer.rtpParameters.encodings[0]?.ssrc;
        const sdpPath = `${track.partialPath}.sdp`;
        track.sdpPath = sdpPath;
        await fsp.writeFile(sdpPath, this.createSdp(consumer, rtpPort, rtcpPort));
        ensureActive();

        const args = [
            '-nostdin',
            '-n',
            '-progress',
            'pipe:3',
            '-stats_period',
            '1',
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
            '-flush_packets',
            '1',
            '-f',
            'matroska',
            track.partialPath,
        ];
        const processInfo = await waitForSpawn(this.config.ffmpegPath, args, {
            stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
        });
        track.child = processInfo.child;
        track.getStderr = processInfo.getStderr;
        track.sdpPath = sdpPath;
        track.child.once('close', (code, signal) => this.handleTrackExit(track, code, signal));
        this.observeCaptureProgress(track, track.child.stdio[3]);
        ensureActive();
        transport.once('close', () => {
            if (!track.intentionalStop) this.scheduleRecovery(track, new Error('Recording transport closed'));
        });
        consumer.once('producerclose', () => this.stopTrack(track, 'producer_closed').catch(() => {}));
        await transport.connect({ ip: LOOPBACK, port: rtpPort, rtcpPort });
        ensureActive();
        await consumer.resume();
        ensureActive();
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

    observeCaptureProgress(track, stream) {
        let buffer = '',
            previous = null,
            sample = {};
        stream.on('data', (chunk) => {
            buffer += chunk.toString();
            let newline;
            while ((newline = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, newline).trim();
                buffer = buffer.slice(newline + 1);
                const [key, value] = line.split('=');
                sample[key] = value;
                if (key !== 'progress') continue;
                const current = { bytes: Number(sample.total_size), time: Number(sample.out_time_us) };
                // A spawn or a Matroska header is not evidence of healthy capture.
                // Require advancing media timestamps AND bytes flushed to the file.
                if (
                    value === 'continue' &&
                    previous &&
                    current.time > previous.time &&
                    current.bytes > previous.bytes
                ) {
                    const baseline = previous.bytes;
                    fsp.stat(track.partialPath)
                        .then((stat) => {
                            if (stat.size > baseline) this.completeRecovery(track);
                        })
                        .catch(() => {});
                }
                previous = current;
                sample = {};
            }
        });
    }

    clearRecovery(meeting, producerId) {
        const recovery = meeting.recoveries.get(producerId);
        if (!recovery) return;
        clearTimeout(recovery.deadlineTimer);
        clearTimeout(recovery.retryTimer);
        meeting.recoveries.delete(producerId);
    }

    completeRecovery(track) {
        const meeting = track.meeting;
        const recovery = meeting.recoveries.get(track.producerId);
        if (
            !recovery ||
            recovery.track !== track ||
            recovery.needsRetry ||
            track.intentionalStop ||
            meeting.ending ||
            meeting.state !== 'recording' ||
            Date.now() >= recovery.deadline ||
            track.child?.exitCode !== null ||
            track.child?.signalCode !== null
        )
            return;
        this.clearRecovery(meeting, track.producerId);
        track.timeline.push({ type: 'recovered', at: Date.now(), offsetMs: Date.now() - meeting.startedAt });
        this.store.updateTrack(track.id, {
            state: 'recording',
            failure_reason: null,
            timeline_json: JSON.stringify(track.timeline),
        });
    }

    scheduleRecovery(track, error) {
        const meeting = track.meeting;
        if (track.intentionalStop || meeting.ending || meeting.state !== 'recording') return;
        this.pauseProducerForRecording(track);
        let recovery = meeting.recoveries.get(track.producerId);
        if (!recovery) {
            recovery = { deadline: Date.now() + this.config.recoveryMs, track };
            meeting.recoveries.set(track.producerId, recovery);
            // This timer is independent of retries and remains active even if
            // a storage/transport operation never resolves.
            recovery.deadlineTimer = setTimeout(() => {
                this.failMeeting(meeting, `Recording could not recover: ${recovery.error.message}`).catch(() => {});
            }, this.config.recoveryMs);
            recovery.deadlineTimer.unref?.();
        }
        recovery.error = error;
        recovery.needsRetry = true;
        track.timeline.push({
            type: 'failure',
            at: Date.now(),
            offsetMs: Date.now() - meeting.startedAt,
            reason: error.message,
        });
        this.store.updateTrack(track.id, {
            state: 'recovering',
            failure_reason: error.message,
            timeline_json: JSON.stringify(track.timeline),
        });
        if (recovery.retryTimer || recovery.restarting || Date.now() >= recovery.deadline) return;
        recovery.retryTimer = setTimeout(() => {
            recovery.retryTimer = null;
            this.startBackground(this.retryTrack(recovery), meeting.id);
        }, this.config.recoveryIntervalMs);
        recovery.retryTimer.unref?.();
    }

    async retryTrack(recovery) {
        const previous = recovery.track;
        const meeting = previous.meeting;
        recovery.restarting = true;
        recovery.needsRetry = false;
        try {
            // Seal the old segment before creating a new file. Never overwrite
            // media captured before the failure, even when a remux fails.
            await this.stopTrack(previous, 'recording_failure', { preserveRecovery: true });
            if (
                meeting.ending ||
                meeting.state !== 'recording' ||
                previous.producer.closed ||
                meeting.recoveries.get(previous.producerId) !== recovery
            )
                return;
            const track = this.createTrackState(
                meeting,
                { id: previous.socketId, peer_name: previous.peerName },
                previous.producer,
                previous.kind,
                previous.mediaType
            );
            track.gate = previous.gate;
            track.gate.track = track;
            meeting.tracks.set(track.id, track);
            this.store.createTrack(track);
            recovery.track = track;
            await this.startTrack(track);
            this.store.updateTrack(track.id, { state: 'recovering' });
        } catch (error) {
            recovery.error = error;
            recovery.needsRetry = true;
            // A deadline may have ended the room while startup was awaiting an
            // external operation. Clean up any resources created after teardown.
            if (meeting.ending || meeting.state !== 'recording') {
                recovery.track.intentionalStop = true;
                await stopChild(recovery.track.child);
                await this.teardownTrackTransport(recovery.track).catch(() => {});
            }
        } finally {
            recovery.restarting = false;
            if (recovery.needsRetry) this.scheduleRecovery(recovery.track, recovery.error);
        }
    }

    async failMeeting(meeting, reason) {
        if (meeting.ending || meeting.state === 'failed') return;
        meeting.state = 'failed';
        for (const track of meeting.tracks.values()) this.pauseProducerForRecording(track);
        for (const producerId of meeting.recoveries.keys()) this.clearRecovery(meeting, producerId);
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
        this.clearRecovery(meeting, producerId);
        const track = meeting.producerGates.get(producerId)?.track;
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

    async stopTrack(track, reason = 'stopped', { preserveRecovery = false } = {}) {
        if (track.stopping) return track.stopping;
        track.stopping = (async () => {
            track.intentionalStop = true;
            if (!preserveRecovery) this.clearRecovery(track.meeting, track.producerId);
            const endedAt = Date.now();
            track.timeline.push({ type: reason, at: endedAt, offsetMs: endedAt - track.meeting.startedAt });
            try {
                await finishRtpInput(track);
                await stopChild(track.child);
                await this.teardownTrackTransport(track);
                await this.finalizeTrackMedia(track, endedAt);
            } catch (error) {
                this.markTrackIncomplete(track, error, endedAt);
            }
            this.refreshMeetingState(track.meetingId);
        })();
        return track.stopping;
    }

    markTrackIncomplete(track, error, endedAt = Date.now()) {
        track.state = 'incomplete';
        this.store.updateTrack(track.id, {
            state: 'incomplete',
            ended_at: endedAt,
            failure_reason: error.message,
            timeline_json: JSON.stringify(track.timeline),
        });
    }

    async finalizeTrackMedia(track, endedAt) {
        // A previous attempt may already have sealed the raw file. Never
        // replace it with a partial left over from a crashed process.
        try {
            await fsp.access(track.rawPath);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            await fsp.rename(track.partialPath, track.rawPath);
        }
        const stats = await this.fileStats(track.rawPath);
        if (!stats.size) throw new Error('Recording contains no media');
        track.state = 'finalizing';
        this.store.updateTrack(track.id, {
            ended_at: endedAt,
            state: 'finalizing',
            raw_path: track.rawRelativePath,
            bytes: stats.size,
            checksum: stats.checksum,
            timeline_json: JSON.stringify(track.timeline),
        });
        track.finalization = this.startBackground(
            this.generatePlayback(track)
                .catch((error) => this.markTrackIncomplete(track, error, endedAt))
                .then(() => this.refreshMeetingState(track.meetingId)),
            track.meetingId
        );
    }

    refreshMeetingState(meetingId) {
        const active = this.meetings.get(meetingId);
        if (active && active.state === 'recording') return;
        const meeting = this.store.getMeeting(meetingId);
        if (!meeting || ['failed', 'incomplete'].includes(meeting.state)) return;
        const tracks = this.store.listTracks(meetingId);
        const pending = tracks.some((track) =>
            ['starting', 'recording', 'recovering', 'finalizing'].includes(track.state)
        );
        const errors = tracks.filter((track) => track.state !== 'ready');
        const state = pending ? 'finalizing' : errors.length ? 'incomplete' : 'ready';
        const failure = errors.find((track) => track.failure_reason);
        this.store.updateMeeting(meetingId, { state, failure_reason: failure?.failure_reason || null });
        if (active) active.state = state;
        if (meeting.state !== state) this.emit('status', { meetingId, state });
    }

    async recoverUnfinishedMeeting(meeting) {
        const interrupted = meeting.state === 'recording';
        if (!['failed', 'incomplete'].includes(meeting.state)) {
            this.store.updateMeeting(meeting.id, {
                state: interrupted ? 'incomplete' : 'finalizing',
                ended_at: meeting.ended_at || Date.now(),
                failure_reason: interrupted
                    ? 'Recording interrupted by server restart; recovered media may be incomplete'
                    : null,
            });
        }
        try {
            const pending = this.store
                .listTracks(meeting.id)
                .filter((track) => ['starting', 'recording', 'recovering', 'finalizing'].includes(track.state));
            for (const saved of pending) {
                // Older versions only saved raw_path at stop time. Their file
                // name is deterministic from the persisted peer/type/track ID.
                const rawRelativePath =
                    saved.raw_path ||
                    path.join('tracks', `${safeName(saved.peer_name)}-${safeName(saved.media_type)}-${saved.id}.mkv`);
                const rawPath = path.join(this.meetingDir(meeting), rawRelativePath);
                const track = {
                    id: saved.id,
                    meetingId: meeting.id,
                    meeting,
                    rawRelativePath,
                    rawPath,
                    partialPath: `${rawPath}.partial`,
                    codecMimeType: (saved.codec || '').toLowerCase(),
                    timeline: JSON.parse(saved.timeline_json || '[]'),
                };
                let endedAt = saved.ended_at;
                try {
                    if (!endedAt) {
                        const stat = await fsp.stat(rawPath).catch((error) => {
                            if (error.code !== 'ENOENT') throw error;
                            return fsp.stat(track.partialPath);
                        });
                        endedAt = Math.max(saved.started_at, Math.floor(stat.mtimeMs));
                    }
                    await this.finalizeTrackMedia(track, endedAt);
                    await track.finalization;
                } catch (error) {
                    this.markTrackIncomplete(track, error, endedAt || saved.started_at);
                }
            }
            if (!meeting.ended_at) {
                const ends = this.store.listTracks(meeting.id).map((track) => track.ended_at || track.started_at);
                this.store.updateMeeting(meeting.id, { ended_at: Math.max(meeting.started_at, ...ends) });
            }
            this.refreshMeetingState(meeting.id);
            if (['queued', 'running'].includes(meeting.composition_state)) {
                await this.queueComposition(meeting.id, meeting.composition_primary_track_id);
            }
        } catch (error) {
            this.store.updateMeeting(meeting.id, {
                state: meeting.state === 'failed' ? 'failed' : 'incomplete',
                failure_reason: error.message,
                ...(['queued', 'running'].includes(meeting.composition_state) ? { composition_state: 'failed' } : {}),
            });
        }
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
        const partialPath = outputPath.replace(/\.(webm|mp4)$/, '.partial.$1');
        await fsp.mkdir(path.dirname(outputPath), { recursive: true });
        const args = ['-nostdin', '-y', '-loglevel', 'error', '-i', track.rawPath, '-c', 'copy', partialPath];
        const processInfo = await waitForSpawn(this.config.ffmpegPath, args);
        const exit = await waitForExit(processInfo.child);
        if (exit.code !== 0) throw new Error(`Playback remux failed: ${processInfo.getStderr() || exit.code}`);
        if (!(await fsp.stat(partialPath)).size) throw new Error('Playback remux produced an empty file');
        await fsp.rename(partialPath, outputPath);
        track.playbackRelativePath = relativePath;
        track.state = 'ready';
        this.store.updateTrack(track.id, { state: 'ready', playback_path: relativePath, failure_reason: null });
    }

    startBackground(job, meetingId = null) {
        if (meetingId) this.meetingJobs.set(meetingId, (this.meetingJobs.get(meetingId) || 0) + 1);
        let tracked;
        tracked = Promise.resolve(job).finally(() => {
            this.backgroundJobs.delete(tracked);
            if (meetingId) {
                const remaining = this.meetingJobs.get(meetingId) - 1;
                if (remaining) this.meetingJobs.set(meetingId, remaining);
                else this.meetingJobs.delete(meetingId);
            }
        });
        this.backgroundJobs.add(tracked);
        return tracked;
    }

    async finishMeeting(room, reason = 'ended') {
        const meeting = this.meetings.get(room.getSessionId());
        if (!meeting || !meeting.required) return;
        if (meeting.ending) return meeting.ending;
        meeting.ending = this.startBackground(
            (async () => {
                const failed = meeting.state === 'failed';
                if (!failed) {
                    meeting.state = 'finalizing';
                    this.store.updateMeeting(meeting.id, { state: 'finalizing', ended_at: Date.now() });
                }
                for (const producerId of meeting.recoveries.keys()) this.clearRecovery(meeting, producerId);
                const tracks = [...meeting.tracks.values()];
                const results = await Promise.allSettled(tracks.map((track) => this.stopTrack(track, reason)));
                results.forEach((result, index) => {
                    if (result.status === 'rejected') this.markTrackIncomplete(tracks[index], result.reason);
                });
                this.meetings.delete(meeting.id);
                this.refreshMeetingState(meeting.id);
            })(),
            meeting.id
        );
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
        return meeting ? this.describeMeeting({ ...meeting, tracks: this.store.listTracks(meetingId) }) : null;
    }

    listMeetings(options) {
        return (this.store?.listMeetings(options) || []).map((meeting) => this.describeMeeting(meeting));
    }

    describeMeeting(meeting) {
        return { ...meeting, views: describeViews(meeting), can_delete: this.canDeleteMeeting(meeting.id) };
    }

    preparePlayback(meetingId, viewId, { retry = false } = {}) {
        const meeting = this.getMeeting(meetingId);
        const view = meeting && playbackViews(meeting).find((item) => item.id === viewId);
        if (!view) throw Object.assign(new Error('未找到此参与者的回放'), { statusCode: 404 });
        if (this.deletingMeetings.has(meetingId) || !view.ready)
            throw Object.assign(new Error('录像仍在处理中，请稍后重试'), { statusCode: 409 });
        const file = path.join(this.config.storageDir, meetingId, 'views', `${view.assetId}.mp4`);
        if (fs.existsSync(file))
            return {
                state: 'ready',
                assetId: view.assetId,
                started_at: view.started_at,
                posterAssetId: fs.existsSync(file.replace(/\.mp4$/, '.jpg')) ? `${view.assetId}-poster` : null,
            };
        const key = `${meetingId}/${view.assetId}`;
        const existing = this.playbackJobs.get(key);
        if (existing && !(retry && existing.state === 'failed')) return existing;
        const status = { state: 'processing', assetId: view.assetId, started_at: view.started_at };
        this.playbackJobs.set(key, status);
        const run = async () => {
            try {
                await renderPlayback({ meeting, view, ...this.config });
                status.state = 'ready';
                status.posterAssetId = fs.existsSync(file.replace(/\.mp4$/, '.jpg')) ? `${view.assetId}-poster` : null;
            } catch {
                status.state = 'failed';
                status.error = '回放准备失败，请重试。原始录像仍然保留。';
            }
        };
        this.compositionQueue = this.startBackground(this.compositionQueue.then(run, run), meetingId);
        return status;
    }

    canDeleteMeeting(meetingId) {
        return (
            !this.meetings.has(meetingId) && !this.meetingJobs.has(meetingId) && !this.deletingMeetings.has(meetingId)
        );
    }

    async deleteMeeting(meetingId) {
        if (!this.store?.getMeeting(meetingId)) return false;
        if (!this.canDeleteMeeting(meetingId)) {
            throw Object.assign(new Error('录像正在录制、处理或删除中，请稍后重试。'), { statusCode: 409 });
        }
        const directory = path.resolve(this.config.storageDir, meetingId);
        if (path.dirname(directory) !== this.config.storageDir || directory === this.config.storageDir) {
            throw Object.assign(new Error('Invalid recording directory'), { statusCode: 400 });
        }
        this.deletingMeetings.add(meetingId);
        try {
            // Keep metadata on a filesystem failure so deletion can be retried.
            // Foreign keys also remove tracks and invalidate every share link.
            await fsp.rm(directory, { recursive: true, force: true });
            this.store.deleteMeeting(meetingId);
            for (const key of this.playbackJobs.keys())
                if (key.startsWith(`${meetingId}/`)) this.playbackJobs.delete(key);
            return true;
        } finally {
            this.deletingMeetings.delete(meetingId);
        }
    }

    getAsset(meetingId, assetId, { publicOnly = false } = {}) {
        const meeting = this.getMeeting(meetingId);
        if (!meeting) return null;
        const poster = assetId.endsWith('-poster');
        const view = playbackViews(meeting).find((item) => item.assetId === (poster ? assetId.slice(0, -7) : assetId));
        if (view) {
            const file = path.join(
                this.config.storageDir,
                meetingId,
                'views',
                `${view.assetId}.${poster ? 'jpg' : 'mp4'}`
            );
            return fs.existsSync(file) ? { path: file, type: poster ? 'image/jpeg' : 'video/mp4', public: true } : null;
        }
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
        if (this.deletingMeetings.has(meetingId)) throw new Error('录像正在删除中。');
        if (!this.store.getMeeting(meetingId)) throw new Error('Meeting not found');
        if (this.compositionJobs.has(meetingId)) throw new Error('Composition is already queued or running');
        this.store.updateMeeting(meetingId, {
            composition_state: 'queued',
            composition_primary_track_id: primaryTrackId || null,
        });
        const run = async () => {
            try {
                return await this.composeMeeting(meetingId, primaryTrackId);
            } catch (error) {
                this.store.updateMeeting(meetingId, { composition_state: 'failed' });
                throw error;
            } finally {
                this.compositionJobs.delete(meetingId);
            }
        };
        this.compositionQueue = this.startBackground(this.compositionQueue.then(run, run), meetingId);
        this.compositionJobs.set(meetingId, this.compositionQueue);
        return this.compositionQueue;
    }

    async composeMeeting(meetingId, primaryTrackId) {
        const meeting = this.getMeeting(meetingId);
        if (!meeting) throw new Error('Meeting not found');
        const videos = meeting.tracks.filter(
            (track) => track.kind === 'video' && track.raw_path && track.state === 'ready'
        );
        const audio = meeting.tracks.filter(
            (track) => track.kind === 'audio' && track.raw_path && track.state === 'ready'
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
        const inputs = orderedVideos;
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
        const filters = [];
        if (videoInputs.length) {
            const labels = videoInputs.map(
                (index) =>
                    `[${index}:v]fps=30,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2[v${index}]`
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
        const tempRelativePath = path.join('composition', 'current.partial.mp4');
        const outputRelativePath = path.join('composition', 'current.mp4');
        const tempPath = path.join(this.config.storageDir, meeting.id, tempRelativePath);
        const outputPath = path.join(this.config.storageDir, meeting.id, outputRelativePath);
        await fsp.mkdir(path.dirname(tempPath), { recursive: true });
        const normalizedAudio = path.join(path.dirname(tempPath), 'current.audio.flac');
        try {
            if (audio.length) {
                await normalizeAudio(
                    audio.map((track) => ({
                        file: path.join(this.config.storageDir, meeting.id, track.raw_path),
                        offset: Math.max(0, track.started_at - meeting.started_at) / 1000,
                    })),
                    normalizedAudio,
                    this.config.ffmpegPath
                );
                args.push('-i', normalizedAudio);
            }
            if (filters.length) args.push('-filter_complex', filters.join(';'));
            if (videoInputs.length)
                args.push('-map', '[vout]', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p');
            if (audio.length) args.push('-map', `${orderedVideos.length}:a`, '-c:a', 'aac', '-b:a', '128k');
            args.push('-movflags', '+faststart', tempPath);
            const processInfo = await waitForSpawn(this.config.ffmpegPath, args);
            const exit = await waitForExit(processInfo.child);
            if (exit.code !== 0) throw new Error(`Composition failed: ${processInfo.getStderr() || exit.code}`);
            await fsp.rename(tempPath, outputPath);
            this.store.updateMeeting(meetingId, {
                composition_state: 'ready',
                composition_path: outputRelativePath,
                composition_updated_at: Date.now(),
            });
            return this.getMeeting(meetingId);
        } catch (error) {
            this.store.updateMeeting(meetingId, { composition_state: 'failed' });
            throw error;
        } finally {
            await fsp.rm(normalizedAudio, { force: true });
            await fsp.rm(tempPath, { force: true });
        }
    }
}

module.exports = ManagedRecording;
