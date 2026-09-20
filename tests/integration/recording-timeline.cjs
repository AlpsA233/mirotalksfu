'use strict';
// Real FFmpeg regression: a microphone that starts two seconds after the
// camera must remain delayed in the single downloadable playback file.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { playbackViews, renderPlayback } = require('../../app/src/RecordingPlayback');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-timeline-'));
const ffmpegPath = process.env.FFMPEG_PATH || '/usr/bin/ffmpeg';
const ffprobePath = process.env.FFPROBE_PATH || '/usr/bin/ffprobe';
(async () => {
    const dir = path.join(root, 'meeting', 'playback');
    fs.mkdirSync(dir, { recursive: true });
    execFileSync(ffmpegPath, [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=red:s=160x90:r=10:d=4',
        '-c:v',
        'libvpx',
        '-threads',
        '1',
        path.join(dir, 'video.webm'),
    ]);
    execFileSync(ffmpegPath, [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000:duration=1',
        '-c:a',
        'libopus',
        path.join(dir, 'audio.webm'),
    ]);
    const meeting = {
        id: 'meeting',
        tracks: [
            {
                id: 'v',
                socket_id: 'p',
                peer_name: 'Person',
                kind: 'video',
                media_type: 'videoType',
                started_at: 1000,
                ended_at: 5000,
                state: 'ready',
                playback_path: 'playback/video.webm',
            },
            {
                id: 'a',
                socket_id: 'p',
                peer_name: 'Person',
                kind: 'audio',
                media_type: 'audioType',
                started_at: 3000,
                ended_at: 4000,
                state: 'ready',
                playback_path: 'playback/audio.webm',
            },
        ],
    };
    const view = playbackViews(meeting)[0];
    const output = await renderPlayback({ meeting, view, storageDir: root, ffmpegPath, ffprobePath });
    const probe = JSON.parse(
        execFileSync(ffprobePath, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output], {
            encoding: 'utf8',
        })
    );
    assert.equal(probe.streams.length, 2);
    assert(Math.abs(Number(probe.format.duration) - 4) < 0.2);
    const { spawnSync } = require('node:child_process');
    const silence = spawnSync(
        ffmpegPath,
        ['-hide_banner', '-i', output, '-vn', '-af', 'silencedetect=noise=-50dB:d=0.1', '-f', 'null', '-'],
        { encoding: 'utf8' }
    );
    assert.equal(silence.status, 0);
    const match = /silence_end: ([\d.]+)/.exec(silence.stderr);
    assert(match, 'Expected initial silence for a late-starting microphone');
    assert(Math.abs(Number(match[1]) - 2) < 0.08, `Audio offset was lost: ${match[1]}`);
    assert(fs.statSync(output.replace(/\.mp4$/, '.jpg')).size > 100);
    execFileSync(ffmpegPath, [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=660:sample_rate=48000:duration=4',
        '-af',
        "aselect='not(between(t,1,3))'",
        '-c:a',
        'libopus',
        path.join(dir, 'gapped.webm'),
    ]);
    const gappedMeeting = {
        ...meeting,
        tracks: [
            meeting.tracks[0],
            {
                ...meeting.tracks[1],
                id: 'gapped',
                started_at: 1000,
                ended_at: 5000,
                playback_path: 'playback/gapped.webm',
            },
        ],
    };
    const gappedOutput = await renderPlayback({
        meeting: gappedMeeting,
        view: playbackViews(gappedMeeting)[0],
        storageDir: root,
        ffmpegPath,
        ffprobePath,
    });
    const gapProbe = JSON.parse(
        execFileSync(ffprobePath, ['-v', 'error', '-show_streams', '-of', 'json', gappedOutput], { encoding: 'utf8' })
    );
    const audioDuration = Number(gapProbe.streams.find((stream) => stream.codec_type === 'audio').duration);
    assert(audioDuration > 3.8, `Timestamp gaps collapsed in audio: ${audioDuration}`);
    const gaps = spawnSync(
        ffmpegPath,
        ['-hide_banner', '-i', gappedOutput, '-vn', '-af', 'silencedetect=noise=-50dB:d=0.3', '-f', 'null', '-'],
        { encoding: 'utf8' }
    );
    const gapEnd = /silence_end: ([\d.]+)/.exec(gaps.stderr);
    assert(gapEnd && Number(gapEnd[1]) > 2.9 && Number(gapEnd[1]) < 3.2, 'Silence interval was not preserved');
    console.log(
        JSON.stringify({
            check: 'microphone_silence_preserved',
            duration: audioDuration,
            silenceEnd: Number(gapEnd[1]),
            passed: true,
        })
    );
    console.log(
        JSON.stringify({
            check: 'delayed_audio_alignment',
            silenceSeconds: Number(match[1]),
            videoDuration: probe.format.duration,
            poster: true,
            passed: true,
        })
    );
})()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => fs.rmSync(root, { recursive: true, force: true }));
