'use strict';
const assert = require('node:assert/strict');
const { describeMedia, playbackCanvas, qualities, validateQuality } = require('../app/src/RecordingMedia');

describe('recording media parameters', () => {
    it('uses rotated display dimensions, fractional frame rate and audio parameters', () => {
        const media = describeMedia(
            {
                format: { duration: '10', bit_rate: '8000000' },
                streams: [
                    {
                        codec_type: 'video',
                        codec_name: 'h264',
                        width: 1920,
                        height: 1080,
                        avg_frame_rate: '30000/1001',
                        side_data_list: [{ rotation: -90 }],
                    },
                    { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 },
                ],
            },
            10000000
        );
        assert.equal(media.width, 1080);
        assert.equal(media.height, 1920);
        assert.equal(media.fps, 30000 / 1001);
        assert.equal(media.sampleRate, 48000);
        assert.equal(media.channels, 2);
        assert.equal(media.bitrate, 8000000);
        assert.equal(media.bitrateEstimated, false);
    });
    it('marks total bitrate estimates and handles audio-only media', () => {
        const media = describeMedia(
            { format: { duration: '2' }, streams: [{ codec_type: 'audio', codec_name: 'aac' }] },
            10000
        );
        assert.equal(media.bitrate, 40000);
        assert.equal(media.bitrateEstimated, true);
        assert.equal(media.width, null);
        assert.equal(qualities(media).length, 1);
    });
    it('fits all landscape/portrait segments without scaling them up and retains highest source fps', () => {
        assert.deepEqual(
            playbackCanvas([
                { width: 1280, height: 720, fps: 25 },
                { width: 1080, height: 1920, fps: 60 },
            ]),
            { width: 1280, height: 1920, fps: 60 }
        );
    });
    it('offers only smaller qualities, with portrait classified by its short side', () => {
        assert.deepEqual(
            qualities({ width: 3840, height: 2160 }).map((q) => q.id),
            ['source', '1440p', '1080p', '720p', '480p', '360p', '240p']
        );
        const portrait = qualities({ width: 1080, height: 1920 });
        assert.deepEqual(portrait[1], { id: '720p', label: '720p', width: 720, height: 1280 });
        assert.equal(qualities({ width: 320, height: 240 }).length, 1);
        assert.throws(() => validateQuality('../../file'), { statusCode: 400 });
    });
});
