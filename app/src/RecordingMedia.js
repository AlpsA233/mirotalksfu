'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const QUALITY_HEIGHTS = [2160, 1440, 1080, 720, 480, 360, 240];
// Bump when the encoder or scaling policy changes to invalidate derived files.
const MEDIA_VERSION = 'h264-aac-crf22-v1';

function rate(value) {
    const [n, d = 1] = String(value || '')
        .split('/')
        .map(Number);
    return Number.isFinite(n / d) && n / d > 0 ? n / d : null;
}

function describeMedia(data, bytes) {
    const video = data.streams?.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
    const audio = data.streams?.find((s) => s.codec_type === 'audio');
    const rotation = Number(
        video?.side_data_list?.find((s) => s.rotation != null)?.rotation || video?.tags?.rotate || 0
    );
    const rotated = Math.abs(rotation % 180) === 90;
    const duration =
        Number(data.format?.duration) || Math.max(0, ...(data.streams || []).map((s) => Number(s.duration) || 0));
    const reportedBitrate = Number(data.format?.bit_rate) || null;
    return {
        width: video ? Number(rotated ? video.height : video.width) : null,
        height: video ? Number(rotated ? video.width : video.height) : null,
        rotation,
        fps: video ? rate(video.avg_frame_rate) || rate(video.r_frame_rate) : null,
        videoCodec: video?.codec_name || null,
        audioCodec: audio?.codec_name || null,
        duration,
        bytes,
        bitrate: reportedBitrate || (duration > 0 ? Math.round((bytes * 8) / duration) : null),
        bitrateEstimated: !reportedBitrate && duration > 0,
        sampleRate: Number(audio?.sample_rate) || null,
        channels: Number(audio?.channels) || null,
    };
}

async function probeMedia(file, ffprobePath) {
    const [{ stdout }, stat] = await Promise.all([
        run(ffprobePath, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], {
            timeout: 30000,
            maxBuffer: 4 * 1024 * 1024,
        }),
        fs.stat(file),
    ]);
    return describeMedia(JSON.parse(stdout), stat.size);
}

function playbackCanvas(media) {
    const videos = media.filter((m) => m.width && m.height);
    const even = (n) => Math.ceil(n / 2) * 2;
    return {
        width: even(Math.max(0, ...videos.map((m) => m.width))),
        height: even(Math.max(0, ...videos.map((m) => m.height))),
        fps: Math.max(0, ...videos.map((m) => m.fps || 30)),
    };
}

function qualities(media) {
    const source = { id: 'source', label: '源分辨率', width: media.width, height: media.height };
    if (!media.width || !media.height) return [source];
    const shortSide = Math.min(media.width, media.height);
    return [
        source,
        ...QUALITY_HEIGHTS.filter((p) => p < shortSide).map((p) => {
            const scale = p / shortSide;
            return {
                id: `${p}p`,
                label: `${p}p`,
                width: Math.max(2, Math.floor((media.width * scale) / 2) * 2),
                height: Math.max(2, Math.floor((media.height * scale) / 2) * 2),
            };
        }),
    ];
}

function validateQuality(quality) {
    if (quality !== 'source' && !QUALITY_HEIGHTS.some((p) => quality === `${p}p`))
        throw Object.assign(new Error('不支持的清晰度'), { statusCode: 400 });
    return quality;
}

async function transcodeQuality({ source, output, quality, ffmpegPath }) {
    const partial = output.replace(/\.mp4$/, '.partial.mp4');
    await fs.mkdir(path.dirname(output), { recursive: true });
    try {
        await run(
            ffmpegPath,
            [
                '-nostdin',
                '-y',
                '-loglevel',
                'error',
                '-i',
                source,
                '-map',
                '0:v:0',
                '-map',
                '0:a:0?',
                '-vf',
                `scale=${quality.width}:${quality.height},setsar=1`,
                '-c:v',
                'libx264',
                '-preset',
                'veryfast',
                '-crf',
                '22',
                '-pix_fmt',
                'yuv420p',
                '-threads',
                '2',
                '-c:a',
                'aac',
                '-b:a',
                '128k',
                '-movflags',
                '+faststart',
                partial,
            ],
            { maxBuffer: 1024 * 1024 }
        );
        await fs.rename(partial, output);
    } finally {
        await fs.rm(partial, { force: true });
    }
}

module.exports = {
    MEDIA_VERSION,
    probeMedia,
    describeMedia,
    playbackCanvas,
    qualities,
    validateQuality,
    transcodeQuality,
};
