'use strict';

// Node 24+, mediasoup worker, FFmpeg and ffprobe. No microphone hardware is used.
// FFMPEG_PATH=/path/ffmpeg FFPROBE_PATH=/path/ffprobe node tests/integration/record-only-audio.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const mediasoup = require('mediasoup');
const Room = require('../../app/src/Room');
const Peer = require('../../app/src/Peer');
const ManagedRecording = require('../../app/src/ManagedRecording');
const AudioRouting = require('../../app/src/AudioRouting');
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const senders = [];
let worker, manager, root;
const timeout = setTimeout(() => {
    console.error('Audio verification timed out');
    process.exit(1);
}, 60000);

(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mirotalk-record-only-'));
    worker = await mediasoup.createWorker({ logLevel: 'error' });
    const router = await worker.createRouter({
        mediaCodecs: [{ kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 }],
    });
    const owner = new Peer('owner', { peer_info: { peer_name: 'Owner' } });
    const listener = new Peer('listener', { peer_info: { peer_name: 'Listener' } });
    const room = Object.assign(Object.create(Room.prototype), {
        id: 'record-only',
        sessionId: 'record-only',
        router,
        _moderator: {},
        peers: new Map([
            [owner.id, owner],
            [listener.id, listener],
        ]),
        broadCast() {},
        sendToAll() {},
        send() {},
    });
    manager = new ManagedRecording({
        enabled: true,
        defaultEnabled: true,
        storageDir: path.join(root, 'media'),
        dbPath: path.join(root, 'state.sqlite'),
        ffmpegPath: ffmpeg,
        ffprobePath: ffprobe,
        rtpPortMin: 47000,
        rtpPortMax: 47199,
    });
    await manager.initialize();
    await manager.prepareMeeting(room);
    const producers = [];
    for (const [index, peer] of [owner, listener].entries()) {
        const transport = await router.createPlainTransport({
            listenInfo: { protocol: 'udp', ip: '127.0.0.1' },
            rtcpMux: false,
            comedia: true,
        });
        peer.transports.set(transport.id, transport);
        const ssrc = 3456000 + index;
        const id = await room.produce(
            peer.id,
            transport.id,
            {
                codecs: [{ mimeType: 'audio/opus', payloadType: 111, clockRate: 48000, channels: 2, parameters: {} }],
                encodings: [{ ssrc }],
                rtcp: { cname: peer.id, reducedSize: true },
            },
            'audio',
            'audioType',
            true
        );
        const producer = peer.getProducer(id);
        producers.push(producer);
        manager.markProducerPending(room, peer, producer);
        await manager.captureProducer(room, peer, producer, { kind: 'audio', mediaType: 'audioType' });
        const sender = spawn(
            ffmpeg,
            [
                '-nostdin',
                '-loglevel',
                'error',
                '-re',
                '-f',
                'lavfi',
                '-i',
                `sine=frequency=${440 * (index + 1)}:sample_rate=48000`,
                '-t',
                '40',
                '-c:a',
                'libopus',
                '-ac',
                '2',
                '-b:a',
                '64k',
                '-payload_type',
                '111',
                '-ssrc',
                String(ssrc),
                '-f',
                'rtp',
                `rtp://127.0.0.1:${transport.tuple.localPort}?rtcpport=${transport.rtcpTuple.localPort}`,
            ],
            { stdio: ['ignore', 'ignore', 'pipe'] }
        );
        sender.stderr.on('data', (data) => process.stderr.write(data));
        senders.push(sender);
    }

    const receiver = await router.createDirectTransport();
    listener.transports.set(receiver.id, receiver);
    assert.equal(room.getProducerListForPeer(listener.id).length, 0);
    await assert.rejects(room.consume(listener.id, receiver.id, producers[0].id, router.rtpCapabilities, 'audioType'), {
        code: 'AUDIO_NOT_LIVE',
    });
    await delay(3000);

    await AudioRouting.setMode(room, owner, producers[0], 'live');
    const params = await room.consume(listener.id, receiver.id, producers[0].id, router.rtpCapabilities, 'audioType');
    const consumer = listener.getConsumer(params.id);
    let receivedPackets = 0;
    consumer.on('rtp', () => receivedPackets++);
    await room.resumeConsumer(listener.id, consumer.id);
    await delay(3000);
    assert(receivedPackets > 30, 'Live listener received no audio RTP');

    await AudioRouting.setMode(room, owner, producers[0], 'record_only');
    assert(consumer.closed, 'Live listener was not disconnected');
    await delay(150);
    const packetsAtMute = receivedPackets;
    await delay(3000);
    assert.equal(receivedPackets, packetsAtMute, 'Private audio leaked after ending speaking');
    assert.equal(room.getProducerListForPeer(listener.id).length, 0);
    assert.equal(producers[0].paused, false, 'The recorded producer was paused');
    assert.equal(producers[1].paused, false, 'The second recorded producer was paused');

    await manager.finishMeeting(room, 'verified');
    await Promise.allSettled([...manager.backgroundJobs]);
    const meeting = manager.getMeeting(room.sessionId);
    assert.equal(meeting.state, 'ready');
    assert.equal(meeting.tracks.length, 2, 'Speaking transitions split the recording');
    for (const track of meeting.tracks) {
        const asset = manager.getAsset(meeting.id, track.id);
        const pcm = execFileSync(ffmpeg, [
            '-v',
            'error',
            '-i',
            asset.path,
            '-ac',
            '1',
            '-ar',
            '8000',
            '-f',
            'f32le',
            'pipe:1',
        ]);
        const samples = pcm.length / 4;
        console.log(JSON.stringify({ participant: track.peer_name, decodedSeconds: samples / 8000 }));
        assert(samples / 8000 >= 8.5, 'Recording did not include all phases');
        for (const seconds of [1, 4.5, 7.5]) {
            let sum = 0;
            for (let i = seconds * 8000; i < (seconds + 0.5) * 8000; i++) sum += pcm.readFloatLE(i * 4) ** 2;
            assert(Math.sqrt(sum / 4000) > 0.015, `Silent recording at ${seconds}s for ${track.peer_name}`);
        }
        const view = meeting.views.find((value) => value.name === track.peer_name);
        manager.preparePlayback(meeting.id, view.id);
        await Promise.allSettled([...manager.backgroundJobs]);
        assert.equal(manager.preparePlayback(meeting.id, view.id).state, 'ready');
        console.log(
            JSON.stringify({ participant: track.peer_name, seconds: samples / 8000, allPhasesHaveAudio: true })
        );
    }
    console.log('RECORD_ONLY_AUDIO_VERIFICATION_PASSED');
})()
    .catch((error) => {
        console.error(error.stack);
        process.exitCode = 1;
    })
    .finally(async () => {
        for (const sender of senders) if (sender.exitCode === null) sender.kill('SIGKILL');
        if (manager) await manager.shutdown().catch(() => {});
        if (worker) worker.close();
        clearTimeout(timeout);
        if (root && !process.env.KEEP_RECORDING_TEST_ARTIFACTS) fs.rmSync(root, { recursive: true, force: true });
        else if (root) console.log(`Recording artifacts: ${root}`);
    });
