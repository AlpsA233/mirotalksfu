'use strict';
// Node 24+, native FFmpeg/ffprobe; FFMPEG_PATH and FFPROBE_PATH may override binaries.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const ManagedRecording = require('../../app/src/ManagedRecording');
const { MEDIA_VERSION, probeMedia } = require('../../app/src/RecordingMedia');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'playback-quality-'));
const config = {
    enabled: true,
    storageDir: path.join(root, 'media'),
    dbPath: path.join(root, 'state.sqlite'),
    ffmpegPath: process.env.FFMPEG_PATH || '/usr/bin/ffmpeg',
    ffprobePath: process.env.FFPROBE_PATH || '/usr/bin/ffprobe',
};
const ffmpeg = (...args) =>
    execFileSync(config.ffmpegPath, ['-nostdin', '-y', '-v', 'error', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
let manager;
async function start() {
    manager = new ManagedRecording(config);
    await manager.initialize();
}
async function prepare(id, viewId, quality = 'source', retry = false) {
    const status = manager.preparePlayback(id, viewId, { quality, retry });
    await manager.compositionQueue;
    assert.equal(status.state, 'ready', JSON.stringify(status));
    return status;
}
function fixture(id, segments) {
    const directory = path.join(config.storageDir, id, 'playback');
    fs.mkdirSync(directory, { recursive: true });
    manager.store.createMeeting({ id, roomId: id, startedAt: 1000, recordingEnabled: true });
    segments.forEach(([width, height, fps, rotation = 0], index) => {
        const file = path.join(directory, `${index}.mp4`);
        ffmpeg(
            '-f',
            'lavfi',
            '-i',
            `color=c=red:s=${width}x${height}:r=${fps}:d=0.5`,
            '-c:v',
            'libx264',
            '-preset',
            'ultrafast',
            '-threads',
            '2',
            '-pix_fmt',
            'yuv420p',
            file
        );
        if (rotation) {
            ffmpeg('-i', file, '-c', 'copy', '-metadata:s:v:0', `rotate=${rotation}`, file + '.rotated.mp4');
            fs.renameSync(file + '.rotated.mp4', file);
        }
        const trackId = `${id}-${index}`;
        manager.store.createTrack({
            id: trackId,
            meetingId: id,
            socketId: id,
            peerName: id,
            kind: 'video',
            mediaType: 'video',
            producerId: trackId,
            startedAt: 1000 + index * 500,
            state: 'ready',
        });
        manager.store.updateTrack(trackId, {
            playback_path: `playback/${index}.mp4`,
            raw_path: `playback/${index}.mp4`,
            ended_at: 1500 + index * 500,
            checksum: trackId,
        });
    });
    manager.store.updateMeeting(id, { state: 'ready', ended_at: 1000 + segments.length * 500 });
    return manager.getMeeting(id).views[0];
}
(async () => {
    await start();
    const cases = [
        ['720', [[1280, 720, 25]], 1280, 720, 25],
        ['1080', [[1920, 1080, 24]], 1920, 1080, 24],
        ['4k', [[3840, 2160, 30]], 3840, 2160, 30],
        ['portrait', [[1080, 1920, 24]], 1080, 1920, 24],
        ['rotated', [[1920, 1080, 24, 90]], 1080, 1920, 24],
        [
            'mixed',
            [
                [1280, 720, 25],
                [1920, 1080, 30],
            ],
            1920,
            1080,
            30,
        ],
    ];
    for (const [id, segments, width, height, fps] of cases) {
        const view = fixture(id, segments);
        const status = manager.preparePlayback(id, view.id);
        assert.equal(manager.preparePlayback(id, view.id), status, 'Concurrent requests must share a job');
        assert.equal(manager.canDeleteMeeting(id), false);
        await manager.compositionQueue;
        assert.equal(status.state, 'ready', id);
        assert.equal(status.metadata.width, width, id);
        assert.equal(status.metadata.height, height, id);
        assert.equal(status.metadata.fps, fps, id);
        assert.equal(status.metadata.videoCodec, 'h264');
        assert.equal(status.metadata.recordingSources.length, segments.length);
        const lower = await prepare(id, view.id, '480p');
        const ratio = width / height;
        assert.equal(Math.min(lower.metadata.width, lower.metadata.height), 480);
        assert(Math.abs(lower.metadata.width / lower.metadata.height - ratio) < 0.01);
        assert(Math.abs(lower.metadata.duration - status.metadata.duration) < 0.05);
        const file = manager.getAsset(id, lower.assetId).path,
            before = fs.statSync(file).mtimeMs;
        assert.equal(manager.preparePlayback(id, view.id, { quality: '480p' }).assetId, lower.assetId);
        assert.equal(fs.statSync(file).mtimeMs, before);
        assert.equal((await prepare(id, view.id, '2160p')).quality, 'source', 'Never upscale');
        if (id === 'mixed') {
            const pixels = ffmpeg(
                '-ss',
                '0.1',
                '-i',
                manager.getAsset(id, status.assetId).path,
                '-frames:v',
                '1',
                '-vf',
                'crop=2:2:0:0',
                '-pix_fmt',
                'rgb24',
                '-f',
                'rawvideo',
                '-'
            );
            assert(pixels[0] < 50, 'Smaller segment should be padded, not enlarged');
        }
        console.log(
            JSON.stringify({
                id,
                width,
                height,
                fps,
                lower: `${lower.metadata.width}x${lower.metadata.height}`,
                passed: true,
            })
        );
    }
    const view = manager.getMeeting('4k').views[0];
    const cached = await prepare('4k', view.id, '480p');
    await manager.shutdown();
    await start();
    assert.equal(manager.preparePlayback('4k', view.id, { quality: '480p' }).state, 'ready', 'Cache survives restart');
    assert.equal(manager.backgroundJobs.size, 0);
    // A killed transcode leaves processing metadata/partial output; next access retries it.
    const sourceVersion = `${view.assetId}-${MEDIA_VERSION}`,
        interrupted = `${sourceVersion}-360p`;
    manager.store.saveAsset('4k', {
        assetId: interrupted,
        sourceVersion,
        quality: '360p',
        path: `qualities/${interrupted}.mp4`,
        state: 'processing',
    });
    fs.writeFileSync(path.join(config.storageDir, '4k', 'qualities', `${interrupted}.partial.mp4`), 'interrupted');
    assert.equal((await prepare('4k', view.id, '360p')).state, 'ready');
    // A failed command keeps the source and can be retried.
    const binary = manager.config.ffmpegPath;
    manager.config.ffmpegPath = '/missing/ffmpeg';
    const failed = manager.preparePlayback('4k', view.id, { quality: '240p' });
    await manager.compositionQueue;
    assert.equal(failed.state, 'failed');
    assert(manager.getAsset('4k', cached.assetId));
    manager.config.ffmpegPath = binary;
    assert.equal((await prepare('4k', view.id, '240p', true)).state, 'ready');
    assert.throws(() => manager.preparePlayback('4k', view.id, { quality: '../source' }), { statusCode: 400 });
    await manager.queueComposition('720');
    const composition = await prepare('720', 'composition');
    assert.equal(composition.metadata.height, 1080);
    const compositeLow = await prepare('720', 'composition', '360p');
    assert(manager.getAsset('720', compositeLow.assetId));
    await manager.queueComposition('720');
    assert.equal(manager.getAsset('720', compositeLow.assetId), null, 'Recomposition invalidates old quality assets');
    await manager.deleteMeeting('4k');
    assert.equal(manager.store.listAssets('4k').length, 0);
    assert(!fs.existsSync(path.join(config.storageDir, '4k')));
    console.log('Cache, deduplication, restart, retry, deletion and composition invalidation passed');
})()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(async () => {
        if (manager) await manager.shutdown();
        fs.rmSync(root, { recursive: true, force: true });
    });
