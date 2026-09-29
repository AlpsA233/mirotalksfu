'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const CameraCapture = require('../public/js/CameraCapture');
const source = fs.readFileSync(path.join(__dirname, '../public/js/RoomClient.js'), 'utf8');
function fixture() {
    const context = vm.createContext({
        window: { location: { origin: 'https://test.local' } },
        CameraCapture,
        videoQuality: { value: '4k' },
        videoSelect: { value: 'new-camera' },
        videoFps: { value: '60' },
    });
    vm.runInContext(`${source}; globalThis.Client = RoomClient;`, context);
    const previous = { deviceId: 'previous-camera', quality: 'hd', fps: 30, fpsSelection: 'max' };
    const client = Object.assign(Object.create(context.Client.prototype), {
        videoCaptureGeneration: 0,
        lastCameraConfig: previous,
        userLog() {},
        closeProducer() {
            this.videoCaptureGeneration++;
        },
    });
    return { client, context, previous };
}
describe('camera reconfiguration', () => {
    it('restores the last working device, quality and frame-rate choice when changing fails', async () => {
        const { client, context, previous } = fixture();
        const calls = [];
        client.produce = async (...args) => {
            calls.push(args);
            if (calls.length === 1)
                throw Object.assign(new Error('Unsupported camera'), { name: 'OverconstrainedError' });
            return {};
        };
        await client.restartCamera('new-camera', false);
        assert.equal(calls.length, 2);
        assert.equal(calls[1][1], 'previous-camera');
        assert.equal(calls[1][4], previous);
        assert.equal(context.videoQuality.value, 'hd');
        assert.equal(context.videoFps.value, 'max');
        assert.equal(context.videoSelect.disabled, false);
    });
    it('does not try to reacquire after permission is denied', async () => {
        const { client } = fixture();
        let calls = 0;
        client.produce = async () => {
            calls++;
            client.lastCameraError = { name: 'NotAllowedError' };
        };
        await client.restartCamera('new-camera', true);
        assert.equal(calls, 1);
    });
    it('does not restore a camera that was switched off while acquisition was pending', async () => {
        const { client } = fixture();
        let finish,
            calls = 0;
        client.produce = () => {
            calls++;
            return new Promise((resolve) => {
                finish = resolve;
            });
        };
        const pending = client.restartCamera('new-camera', false);
        client.closeProducer();
        finish();
        await pending;
        assert.equal(calls, 1);
    });
});
