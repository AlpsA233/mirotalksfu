'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

// A viewing angle belongs to a connection, never to a display name: two people
// may have the same name. Repeated camera/microphone segments share a timeline.
function playbackViews(meeting) {
    const peers = new Map();
    for (const track of meeting.tracks) {
        // Failed segments stay in the archive metadata, but must not prevent
        // playback of usable segments captured before/after a recovery.
        if (['failed', 'incomplete'].includes(track.state) && !track.playback_path) continue;
        const key = track.socket_id || track.id;
        if (!peers.has(key)) peers.set(key, { name: track.peer_name, tracks: [] });
        peers.get(key).tracks.push(track);
    }
    const views = [];
    for (const [key, peer] of peers) {
        const audio = peer.tracks.filter((track) => track.kind === 'audio');
        const cameras = peer.tracks.filter((track) => track.kind === 'video' && !/screen/i.test(track.media_type));
        const screens = peer.tracks.filter((track) => track.kind === 'video' && /screen/i.test(track.media_type));
        const angles = [
            ...(cameras.length ? [['camera', cameras]] : []),
            ...(screens.length ? [['screen', screens]] : []),
        ];
        if (!angles.length) angles.push(['audio', []]);
        for (const [kind, video] of angles) {
            const sources = [...video, ...audio].sort(
                (a, b) => a.started_at - b.started_at || a.id.localeCompare(b.id)
            );
            const id = crypto.createHash('sha256').update(`${key}:${kind}`).digest('hex').slice(0, 24);
            const version = crypto
                .createHash('sha256')
                .update('synchronized-playback-v7:')
                .update(
                    JSON.stringify(
                        sources.map((track) => [
                            track.id,
                            track.checksum,
                            track.playback_path,
                            track.started_at,
                            track.ended_at,
                        ])
                    )
                )
                .digest('hex')
                .slice(0, 24);
            views.push({
                id,
                name: peer.name,
                kind,
                has_audio: audio.length > 0,
                has_video: video.length > 0,
                ready: sources.length > 0 && sources.every((track) => track.state === 'ready' && track.playback_path),
                started_at: Math.min(...sources.map((track) => track.started_at)),
                assetId: `view-${id}-${version}`,
                sources,
            });
        }
    }
    return views;
}

function describeViews(meeting) {
    return playbackViews(meeting).map(({ sources, ...view }) => view);
}

async function normalizeAudio(audio, output, ffmpegPath) {
    // Reconstruct sparse microphone timestamps before the video filter
    // graph is evaluated. A lossless intermediate keeps silence and
    // pause intervals on a continuous sample clock during multiplexing.
    const audioArgs = ['-nostdin', '-y', '-loglevel', 'error'];
    audio.forEach((input) => audioArgs.push('-i', input.file));
    const audioFilters = audio.map(
        (input, index) =>
            `[${index}:a]asetpts=PTS-STARTPTS,aresample=async=1:first_pts=0,asetpts=N/SR/TB,adelay=${Math.round(input.offset * 1000)}:all=1[a${index}]`
    );
    audioFilters.push(
        `${audio.map((_, index) => `[a${index}]`).join('')}amix=inputs=${audio.length}:duration=longest:normalize=0,alimiter=level=false[aout]`
    );
    audioArgs.push('-filter_complex', audioFilters.join(';'), '-map', '[aout]', '-c:a', 'flac', output);
    await run(ffmpegPath, audioArgs, { maxBuffer: 1024 * 1024 });
}

async function renderPlayback({ meeting, view, storageDir, ffmpegPath, ffprobePath }) {
    const directory = path.join(storageDir, meeting.id);
    const output = path.join(directory, 'views', `${view.assetId}.mp4`);
    try {
        await fs.access(output);
        return output;
    } catch {
        /* First request prepares the synchronized playback file. */
    }
    await fs.mkdir(path.dirname(output), { recursive: true });
    const inputs = [];
    for (const track of view.sources) {
        const file = path.join(directory, track.playback_path);
        const { stdout } = await run(
            ffprobePath,
            ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file],
            { timeout: 30000 }
        );
        const duration = Number(JSON.parse(stdout).format.duration);
        if (!Number.isFinite(duration) || duration <= 0) throw new Error('录制文件缺少有效时长');
        inputs.push({ track, file, duration, offset: Math.max(0, track.started_at - view.started_at) / 1000 });
    }
    const duration = Math.max(...inputs.map((input) => input.offset + input.duration));
    const videos = inputs.filter((input) => input.track.kind === 'video');
    const audio = inputs.filter((input) => input.track.kind === 'audio');
    const normalizedAudio = output.replace(/\.mp4$/, '.audio.flac');
    const args = ['-nostdin', '-y', '-loglevel', 'error', '-filter_complex_threads', '1'];
    for (const input of videos) args.push('-i', input.file);
    if (audio.length) args.push('-i', normalizedAudio);
    const filters = [];
    if (videos.length) {
        filters.push(`color=c=0x10131a:s=1280x720:r=30:d=${duration}[base0]`);
        videos.forEach((input, index) => {
            filters.push(
                `[${index}:v]fps=30,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,setpts=PTS-STARTPTS+${input.offset}/TB[v${index}]`
            );
            filters.push(
                `[base${index}][v${index}]overlay=eof_action=pass:repeatlast=0:enable='between(t,${input.offset},${input.offset + input.duration})'[base${index + 1}]`
            );
        });
    }
    if (filters.length) args.push('-filter_complex', filters.join(';'));
    if (videos.length)
        args.push(
            '-map',
            `[base${videos.length}]`,
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-crf',
            '22',
            '-pix_fmt',
            'yuv420p',
            '-threads',
            '2'
        );
    if (audio.length) args.push('-map', `${videos.length}:a`, '-c:a', 'aac', '-b:a', '128k');
    const partial = output.replace(/\.mp4$/, '.partial.mp4');
    args.push('-movflags', '+faststart', partial);
    try {
        if (audio.length) {
            await normalizeAudio(audio, normalizedAudio, ffmpegPath);
        }
        await run(ffmpegPath, args, { maxBuffer: 1024 * 1024 });
        if (videos.length) {
            // Cameras often start with a blank frame. Pick a preview shortly
            // after startup, independent of any audio-only timeline lead-in.
            await run(ffmpegPath, [
                '-nostdin',
                '-y',
                '-loglevel',
                'error',
                '-ss',
                String(Math.min(0.5, videos[0].duration / 2)),
                '-i',
                videos[0].file,
                '-frames:v',
                '1',
                '-vf',
                'scale=960:-2',
                '-threads',
                '1',
                output.replace(/\.mp4$/, '.jpg'),
            ]).catch(() => {});
        }
        await fs.rename(partial, output);
        return output;
    } finally {
        await fs.rm(partial, { force: true });
        await fs.rm(normalizedAudio, { force: true });
    }
}

module.exports = { playbackViews, describeViews, renderPlayback, normalizeAudio };
