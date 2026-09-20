'use strict';

// Requires Node 24+, a built mediasoup worker, FFmpeg and ffprobe (override FFMPEG_PATH / FFPROBE_PATH if needed).
// Run: node tests/integration/managed-recording.cjs
// Also test an active sender: RECORDING_TEST_LIVE=1 node tests/integration/managed-recording.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const mediasoup = require('mediasoup');
const ManagedRecording = require('../../app/src/ManagedRecording');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const senders = [];
let worker, manager, dir;
const ffmpeg = process.env.FFMPEG_PATH || '/usr/bin/ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || '/usr/bin/ffprobe';
const live = process.env.RECORDING_TEST_LIVE === '1';
const timeout = setTimeout(() => {
    console.error('Verification timeout');
    process.exit(1);
}, 75000);
(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirotalk-recording-test-'));
    const audioCodec = { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 };
    const videoCodec = { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 };
    worker = await mediasoup.createWorker({ logLevel: 'error' });
    const router = await worker.createRouter({ mediaCodecs: [audioCodec, videoCodec] });
    const id = 'deployment-verification';
    const room = { id, router, getSessionId: () => id };
    manager = new ManagedRecording(
        {
            enabled: true,
            defaultEnabled: true,
            storageDir: path.join(dir, 'media'),
            dbPath: path.join(dir, 'state.sqlite'),
            ffmpegPath: ffmpeg,
            ffprobePath: ffprobe,
            shutdownTimeoutMs: 10000,
        },
        {
            onFatal: async (_, reason) => {
                throw new Error(reason);
            },
        }
    );
    await manager.initialize();
    await manager.prepareMeeting(room);
    for (const [index, codec] of [audioCodec, videoCodec].entries()) {
        const transport = await router.createPlainTransport({
            listenInfo: { protocol: 'udp', ip: '127.0.0.1' },
            rtcpMux: false,
            comedia: true,
        });
        const payloadType = 111 + index;
        const ssrc = 12345000 + index;
        const { kind, ...parameters } = codec;
        const producer = await transport.produce({
            kind,
            paused: true,
            rtpParameters: {
                codecs: [{ ...parameters, payloadType, parameters: {} }],
                encodings: [{ ssrc }],
                rtcp: { cname: 'deployment-verification', reducedSize: true },
            },
        });
        const peer = { id: 'test-peer', peer_name: 'Deployment verification' };
        manager.markProducerPending(room, peer, producer);
        await manager.captureProducer(room, peer, producer, { kind, mediaType: kind === 'audio' ? 'audio' : 'video' });
        const source =
            kind === 'audio'
                ? [
                      '-f',
                      'lavfi',
                      '-i',
                      'sine=frequency=440:sample_rate=48000',
                      '-c:a',
                      'libopus',
                      '-ac',
                      '2',
                      '-b:a',
                      '64k',
                  ]
                : [
                      '-f',
                      'lavfi',
                      '-i',
                      'testsrc2=size=320x180:rate=15',
                      '-c:v',
                      'libvpx',
                      '-deadline',
                      'realtime',
                      '-cpu-used',
                      '8',
                      '-g',
                      '15',
                      '-b:v',
                      '200k',
                      '-an',
                  ];
        const child = spawn(
            ffmpeg,
            [
                '-nostdin',
                '-loglevel',
                'error',
                '-re',
                ...source,
                '-t',
                live ? '60' : '10',
                '-payload_type',
                String(payloadType),
                '-ssrc',
                String(ssrc),
                '-f',
                'rtp',
                `rtp://127.0.0.1:${transport.tuple.localPort}?rtcpport=${transport.rtcpTuple.localPort}`,
            ],
            { stdio: ['ignore', 'ignore', 'pipe'] }
        );
        child.stderr.on('data', (data) => process.stderr.write(data));
        senders.push(child);
    }
    await delay(11500);
    const recordingChildren = [...manager.meetings.get(id).tracks.values()].map((track) => track.child);
    await manager.finishMeeting(room, 'deployment_verification');
    for (const child of recordingChildren) assert.equal(child.exitCode, 0, 'Recorder did not finish normally');
    await Promise.allSettled([...manager.backgroundJobs]);
    let meeting = manager.getMeeting(id);
    assert.equal(meeting.state, 'ready');
    assert.equal(meeting.tracks.length, 2);
    for (const track of meeting.tracks) {
        assert.equal(track.state, 'ready', track.failure_reason || 'track not playable');
        const asset = manager.getAsset(id, track.id);
        assert(fs.statSync(asset.path).size > 1000);
        const probe = JSON.parse(
            execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', asset.path], {
                encoding: 'utf8',
            })
        );
        assert(probe.streams.some((s) => s.codec_type === track.kind));
        assert(
            Number(probe.format.duration) >= 9 && Number(probe.format.duration) < 13,
            'Recording lost media at finalization'
        );
        console.log(
            JSON.stringify({
                check: 'recorded_track',
                kind: track.kind,
                bytes: fs.statSync(asset.path).size,
                duration: probe.format.duration,
            })
        );
    }
    const views = manager.getMeeting(id).views;
    assert.equal(views.length, 1, 'One participant must have one combined camera view');
    assert.equal(views[0].has_audio, true);
    assert.equal(views[0].has_video, true);
    const preparation = manager.preparePlayback(id, views[0].id);
    assert.equal(preparation.state, 'processing');
    assert.equal(manager.getMeeting(id).can_delete, false);
    await Promise.allSettled([...manager.backgroundJobs]);
    const prepared = manager.preparePlayback(id, views[0].id);
    assert.equal(prepared.state, 'ready');
    const combined = manager.getAsset(id, prepared.assetId);
    const combinedProbe = JSON.parse(
        execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', combined.path], {
            encoding: 'utf8',
        })
    );
    assert(combinedProbe.streams.some((stream) => stream.codec_type === 'audio' && stream.codec_name === 'aac'));
    assert(combinedProbe.streams.some((stream) => stream.codec_type === 'video' && stream.codec_name === 'h264'));
    assert(Number(combinedProbe.format.duration) >= 9 && Number(combinedProbe.format.duration) < 13);
    console.log(
        JSON.stringify({
            check: 'participant_synchronized_playback',
            audio: 'aac',
            video: 'h264',
            duration: combinedProbe.format.duration,
            passed: true,
        })
    );
    await manager.queueComposition(id);
    const composition = manager.getAsset(id, 'composition');
    const probe = JSON.parse(
        execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', composition.path], {
            encoding: 'utf8',
        })
    );
    assert(probe.streams.some((s) => s.codec_type === 'audio'));
    assert(probe.streams.some((s) => s.codec_type === 'video' && s.width === 1920 && s.height === 1080));
    const video = probe.streams.find((s) => s.codec_type === 'video');
    assert.equal(video.r_frame_rate, '30/1', 'Composition inherited an excessive RTP-derived frame rate');
    assert(Number(video.nb_frames) < 400, 'Composition generated duplicate frames');
    console.log(
        JSON.stringify({
            check: 'combined_recording',
            width: 1920,
            height: 1080,
            bytes: fs.statSync(composition.path).size,
            duration: probe.format.duration,
            passed: true,
        })
    );
    await manager.shutdown();
    manager = null;
    console.log('REAL_MEDIA_VERIFICATION_PASSED');
})()
    .catch((error) => {
        console.error(error.stack);
        process.exitCode = 1;
    })
    .finally(async () => {
        for (const child of senders) if (child.exitCode === null) child.kill('SIGKILL');
        if (manager) await manager.shutdown().catch(() => {});
        if (worker) worker.close();
        clearTimeout(timeout);
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
    });
