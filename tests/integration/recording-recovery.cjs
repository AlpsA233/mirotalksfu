'use strict';

// Real RTP/FFmpeg regression for process failure and persisted job recovery.
// Run with the same FFMPEG_PATH / FFPROBE_PATH overrides as managed-recording.cjs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const mediasoup = require('mediasoup');
const ManagedRecording = require('../../app/src/ManagedRecording');

const ffmpegPath = process.env.FFMPEG_PATH || '/usr/bin/ffmpeg';
const ffprobePath = process.env.FFPROBE_PATH || '/usr/bin/ffprobe';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-real-recovery-'));
const config = {
    enabled: true,
    defaultEnabled: true,
    storageDir: path.join(root, 'media'),
    dbPath: path.join(root, 'state.sqlite'),
    ffmpegPath,
    ffprobePath,
    recoveryMs: 15000,
    recoveryIntervalMs: 100,
};
let manager, worker, sender;
const failures = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, message) {
    const deadline = Date.now() + 20000;
    while (!predicate()) {
        assert(Date.now() < deadline, message);
        assert.equal(failures.length, 0, failures[0]);
        await delay(50);
    }
}
async function drain() {
    while (manager.backgroundJobs.size) await Promise.all([...manager.backgroundJobs]);
}
function createManager() {
    return new ManagedRecording(config, {
        onFatal: async (_, reason) => {
            failures.push(reason);
        },
    });
}

(async () => {
    worker = await mediasoup.createWorker({ logLevel: 'error' });
    const codec = { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 };
    const router = await worker.createRouter({ mediaCodecs: [codec] });
    const room = { id: 'recovery', router, getSessionId: () => 'recovery' };
    manager = createManager();
    await manager.initialize();
    await manager.prepareMeeting(room);
    const transport = await router.createPlainTransport({
        listenInfo: { protocol: 'udp', ip: '127.0.0.1' },
        rtcpMux: false,
        comedia: true,
    });
    const producer = await transport.produce({
        kind: 'audio',
        paused: true,
        rtpParameters: {
            codecs: [{ mimeType: codec.mimeType, clockRate: 48000, channels: 2, payloadType: 111, parameters: {} }],
            encodings: [{ ssrc: 12345999 }],
            rtcp: { cname: 'recovery', reducedSize: true },
        },
    });
    const peer = { id: 'peer', peer_name: 'Recovery' };
    manager.markProducerPending(room, peer, producer);
    const first = await manager.captureProducer(room, peer, producer, { kind: 'audio', mediaType: 'audio' });
    sender = spawn(
        ffmpegPath,
        [
            '-nostdin',
            '-v',
            'error',
            '-re',
            '-f',
            'lavfi',
            '-i',
            'sine=frequency=440:sample_rate=48000',
            '-t',
            '30',
            '-c:a',
            'libopus',
            '-ac',
            '2',
            '-payload_type',
            '111',
            '-ssrc',
            '12345999',
            '-f',
            'rtp',
            `rtp://127.0.0.1:${transport.tuple.localPort}?rtcpport=${transport.rtcpTuple.localPort}`,
        ],
        { stdio: ['ignore', 'ignore', 'inherit'] }
    );
    await until(
        () => fs.existsSync(first.partialPath) && fs.statSync(first.partialPath).size > 4000,
        'Initial media did not arrive'
    );
    const exited = new Promise((resolve) => first.child.once('close', resolve));
    first.child.kill('SIGKILL');
    await exited;
    const active = manager.meetings.get('recovery');
    await until(
        () => first.gate.track !== first && active.recoveries.size === 0,
        'Recorder did not prove healthy writes after restarting'
    );
    const second = first.gate.track;
    assert.notEqual(first.rawPath, second.rawPath);
    assert(fs.statSync(first.rawPath).size > 4000);
    await manager.finishMeeting(room);
    await drain();
    let meeting = manager.getMeeting('recovery');
    assert.equal(meeting.state, 'ready');
    assert.equal(meeting.tracks.length, 2);
    assert(meeting.tracks.every((track) => track.state === 'ready'));
    assert(meeting.views[0].ready);
    assert.equal(failures.length, 0);
    console.log('REAL_RECORDER_RESTART_PASSED');

    await manager.queueComposition('recovery');
    const compositionPath = manager.getAsset('recovery', 'composition').path;
    const previousComposition = fs.readFileSync(compositionPath);
    // Model a process crash in remux/rebuild: persisted raw media and the old
    // published composition survive; a derived partial is not publishable.
    const saved = meeting.tracks[1];
    const playbackPath = path.join(config.storageDir, 'recovery', saved.playback_path);
    fs.unlinkSync(playbackPath);
    fs.writeFileSync(playbackPath.replace('.webm', '.partial.webm'), 'truncated output');
    manager.store.updateTrack(saved.id, { state: 'finalizing', playback_path: null });
    manager.store.updateMeeting('recovery', { state: 'finalizing', composition_state: 'running' });
    manager.store.close();
    manager = createManager();
    await manager.initialize();
    assert.deepEqual(fs.readFileSync(compositionPath), previousComposition);
    await drain();
    meeting = manager.getMeeting('recovery');
    assert.equal(meeting.state, 'ready');
    assert.equal(meeting.composition_state, 'ready');
    const probe = JSON.parse(
        execFileSync(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', playbackPath], {
            encoding: 'utf8',
        })
    );
    assert(Number(probe.format.duration) > 1);
    assert(!fs.existsSync(playbackPath.replace('.webm', '.partial.webm')));
    console.log('REAL_PERSISTED_JOB_RECOVERY_PASSED');
})()
    .catch((error) => {
        console.error(error.stack);
        process.exitCode = 1;
    })
    .finally(async () => {
        if (sender && sender.exitCode === null) sender.kill('SIGKILL');
        if (manager) await manager.shutdown();
        if (worker) worker.close();
        fs.rmSync(root, { recursive: true, force: true });
    });
