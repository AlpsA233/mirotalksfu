'use strict';
const assert = require('node:assert/strict');
const CameraCapture = require('../public/js/CameraCapture');

function camera({ caps = { width: { max: 3840 }, height: { max: 2160 } }, maxWidth = 3840, denied = false } = {}) {
    const calls = [];
    let settings = { width: 640, height: 480, frameRate: 30, deviceId: 'camera' };
    const track = {
        readyState: 'live',
        getCapabilities: caps ? () => caps : undefined,
        getSettings: () => settings,
        stop() {
            this.readyState = 'ended';
        },
        async applyConstraints(value) {
            calls.push(value);
            if (denied) throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
            if (value.width.exact > maxWidth || value.height.exact > maxWidth)
                throw Object.assign(new Error('unsupported'), { name: 'OverconstrainedError' });
            settings = {
                ...settings,
                width: value.width.exact || Math.min(value.width.ideal, maxWidth),
                height: value.height.exact || Math.round((Math.min(value.width.exact, maxWidth) * 9) / 16),
                frameRate: Math.min(value.frameRate.ideal, 24),
            };
        },
    };
    const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
    const devices = {
        async getUserMedia(value) {
            calls.push(value);
            return stream;
        },
    };
    return { calls, track, stream, devices };
}

describe('camera capture', () => {
    it('requests capability maximum, prioritizes resolution and reports actual device settings', async () => {
        const fixture = camera();
        const stream = await CameraCapture.acquire({ deviceId: 'camera', fps: 60 }, fixture.devices);
        assert.equal(stream.getVideoTracks()[0].getSettings().width, 3840);
        assert.equal(stream.getVideoTracks()[0].getSettings().frameRate, 24);
        assert.equal(fixture.calls[1].frameRate.ideal, 60);
        assert.equal(fixture.calls[1].deviceId.exact, 'camera');
    });
    it('tries resolutions descending when capabilities are absent or their maximum fails', async () => {
        for (const caps of [null, { width: { max: 9000 }, height: { max: 6000 } }]) {
            const fixture = camera({ caps, maxWidth: 1920 });
            await CameraCapture.acquire({}, fixture.devices);
            assert.equal(fixture.track.getSettings().width, 1920);
            assert.equal(fixture.calls.at(-1).height.exact, 1080);
        }
    });
    it('stops on permission denial without retrying other resolutions', async () => {
        const fixture = camera({ denied: true });
        await assert.rejects(CameraCapture.acquire({}, fixture.devices), { name: 'NotAllowedError' });
        assert.equal(fixture.calls.length, 2);
        assert.equal(fixture.track.readyState, 'ended');
        let requests = 0;
        await assert.rejects(
            CameraCapture.acquire(
                {},
                {
                    getUserMedia() {
                        requests++;
                        throw Object.assign(new Error(), { name: 'NotAllowedError' });
                    },
                }
            )
        );
        assert.equal(requests, 1);
    });
    it('uses the same acquisition path for front/back and exact manual resolutions', async () => {
        const fixture = camera();
        await CameraCapture.acquire({ facingMode: 'environment', quality: 'hd', fps: 25 }, fixture.devices);
        assert.equal(fixture.calls.length, 1);
        assert.deepEqual(fixture.calls[0].video, {
            facingMode: { exact: 'environment' },
            frameRate: { ideal: 25 },
            width: { exact: 1280 },
            height: { exact: 720 },
        });
    });
    it('sizes each encoding layer using its own actual dimensions and clamps the budget', () => {
        const source = { width: 3840, height: 2160, frameRate: 30 };
        assert.equal(CameraCapture.bitrate(source), 24883200);
        assert.equal(CameraCapture.bitrate(source, 2), 6220800);
        assert.equal(CameraCapture.bitrate(source, 4), 1555200);
        assert.equal(CameraCapture.bitrate({ width: 160, height: 90, frameRate: 10 }), 500000);
        assert.equal(CameraCapture.bitrate({ width: 7680, height: 4320, frameRate: 60 }), 50000000);
    });
});
