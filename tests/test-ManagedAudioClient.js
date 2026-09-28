'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '../public/js/RoomClient.js'), 'utf8');
const context = vm.createContext({
    window: { location: { origin: 'https://example.test' } },
    microphoneSelect: { value: 'mic' },
});
vm.runInContext(`${source}; globalThis.Client = RoomClient;`, context);

function fixture() {
    const producer = {
        id: 'mic',
        pause: () => assert.fail('Paused a recording source'),
        resume: () => assert.fail('Resumed a recording source'),
    };
    const client = Object.assign(Object.create(context.Client.prototype), {
        peer_id: 'owner',
        peer_info: {},
        peers: new Map(),
        recordOnlyAudio: true,
        audioMode: 'record_only',
        audioModeRevision: 0,
        audioCaptureGeneration: 0,
        producerLabel: new Map([['audioType', producer.id]]),
        producers: new Map([[producer.id, producer]]),
        setIsAudio: (id, live) => {
            client.peer_info.peer_audio = live;
        },
        event: () => {},
        updatePeerInfoInLocalStorage: () => {},
        renderManagedAudio: () => {},
        userLog: () => {},
        socket: {
            request: async (name, data) => ({
                peer_id: 'owner',
                producer_id: producer.id,
                mode: data.mode,
                revision: ++client.serverRevision,
            }),
        },
        serverRevision: 0,
    });
    return { client, producer };
}

describe('managed audio client', () => {
    it('routes existing speaking controls without pausing microphone capture', async () => {
        const { client } = fixture();
        await client.resumeProducer('audioType');
        assert.equal(client.audioMode, 'live');
        await client.pauseProducer('audioType');
        assert.equal(client.audioMode, 'record_only');
        assert.equal(client.peer_info.peer_audio, false);
        assert.equal(client.peer_info.peer_audio_capture, true);
    });

    it('does not lose a quick push-to-talk release while a press is pending', async () => {
        const { client } = fixture();
        await Promise.all([client.resumeProducer('audioType'), client.pauseProducer('audioType')]);
        assert.equal(client.audioMode, 'record_only');
    });

    it('closes capture on an uncertain acknowledgement and ignores queued speaking requests', async () => {
        const { client } = fixture();
        let stopped = 0;
        client.socket.request = async () => {
            throw new Error('timeout');
        };
        client.stopManagedAudioCapture = () => {
            stopped++;
            client.audioCaptureGeneration++;
            client.managedAudioBusy = false;
            client.audioMode = 'off';
        };
        await Promise.all([client.resumeProducer('audioType'), client.pauseProducer('audioType')]);
        assert.equal(stopped, 1);
        assert.equal(client.audioMode, 'off');
        assert.equal(client.managedAudioBusy, false);
    });

    it('does not stop a new capture when an older mode request fails', async () => {
        const { client } = fixture();
        let rejectRequest;
        client.socket.request = () =>
            new Promise((resolve, reject) => {
                rejectRequest = reject;
            });
        client.stopManagedAudioCapture = () => assert.fail('Stopped the replacement microphone');
        const oldRequest = client.resumeProducer('audioType');
        await new Promise((resolve) => setImmediate(resolve));
        // The user stops and resumes capture while the old request is pending.
        client.audioCaptureGeneration++;
        client.managedAudioBusy = true;
        client.audioMode = 'record_only';
        rejectRequest(new Error('timeout'));
        assert.equal(await oldRequest, false);
        assert.equal(client.managedAudioBusy, true);
        assert.equal(client.audioMode, 'record_only');
    });

    it('ignores stale mode events and never reopens a locally closed microphone', () => {
        const { client } = fixture();
        client.applyAudioMode({ peer_id: 'owner', mode: 'record_only', revision: 3 });
        client.applyAudioMode({ peer_id: 'owner', mode: 'live', revision: 2 });
        assert.equal(client.audioMode, 'record_only');
        client.producerLabel.clear();
        client.applyAudioMode({ peer_id: 'owner', mode: 'off' });
        client.applyAudioMode({ peer_id: 'owner', mode: 'live', revision: 4 });
        assert.equal(client.audioMode, 'off');
    });

    it('reconnects using capture state instead of the muted meeting indicator', () => {
        const { client } = fixture();
        Object.assign(client, {
            room_id: 'test',
            RoomPassword: false,
            peer_name: 'Owner',
            getPeerInfoFromLocalStorage: () => ({
                peer_audio: false,
                peer_audio_capture: true,
                peer_video: true,
                peer_screen: false,
            }),
        });
        assert(client.getReconnectDirectJoinURL().includes('audio=true'));
        client.getPeerInfoFromLocalStorage = () => ({ peer_audio: false, peer_audio_capture: false });
        assert(client.getReconnectDirectJoinURL().includes('audio=false'));
    });

    it('remembers the capture choice across a transport ending', () => {
        const { client } = fixture();
        Object.assign(client, {
            room_id: 'test',
            peer_name: 'Owner',
            getPeerInfoFromLocalStorage: () => ({
                peer_audio: false,
                peer_audio_capture: false,
                peer_audio_capture_allowed: true,
            }),
        });
        assert(client.getReconnectDirectJoinURL().includes('audio=true'));
    });

    it('releases both the raw and processed microphones when capture stops', () => {
        const { client } = fixture();
        let stopped = 0;
        let processingStopped = false;
        const stream = () => ({ getTracks: () => [{ stop: () => stopped++ }] });
        client.managedMicrophoneStream = stream();
        client.localAudioStream = stream();
        client.closeProducer = () => client.producerLabel.clear();
        client.disableRNNoiseSuppression = () => {
            processingStopped = true;
        };
        client.stopManagedAudioCapture();
        assert.equal(stopped, 2);
        assert.equal(processingStopped, true);
        assert.equal(client.audioMode, 'off');
        assert.equal(client.peer_info.peer_audio_capture, false);
    });

    it('renders distinct recording, speaking and stopped states in the meeting DOM', () => {
        const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../public/views/Room.html'), 'utf8'));
        const roomSource = fs.readFileSync(path.join(__dirname, '../public/js/Room.js'), 'utf8');
        const begin = roomSource.indexOf('function updateManagedAudioUi(');
        const end = roomSource.indexOf('async function setPushToTalkPressed(', begin);
        const doc = dom.window.document;
        const dictionary = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/lang/zh.json'), 'utf8'));
        dom.window.i18n = { t: (key, namespace) => dictionary[namespace]?.[key] || key };
        const sandbox = vm.createContext({
            window: dom.window,
            document: doc,
            Event: dom.window.Event,
            getId: (id) => doc.getElementById(id),
            startAudioButton: doc.getElementById('startAudioButton'),
            stopAudioButton: doc.getElementById('stopAudioButton'),
            show: (element) => element.classList.remove('hidden'),
            hide: (element) => element.classList.add('hidden'),
            applyKeepAwake() {},
            BUTTONS: { main: { startAudioButton: true } },
            isBroadcastingEnabled: false,
            isPresenter: false,
        });
        vm.runInContext(roomSource.slice(begin, end), sandbox);
        const client = { recordOnlyAudio: true, managedAudioReady: true, audioMode: 'record_only' };
        const status = doc.getElementById('managedAudioStatus');
        sandbox.updateManagedAudioUi(client);
        assert.equal(status.textContent, '仅录音中，其他人听不到');
        assert.equal(doc.getElementById('startAudioButton').getAttribute('aria-label'), '开始发言');
        client.audioMode = 'live';
        sandbox.updateManagedAudioUi(client);
        assert.equal(status.textContent, '正在发言并录音');
        assert(!doc.getElementById('stopAudioButton').classList.contains('hidden'));
        client.audioMode = 'off';
        client.managedAudioReady = false;
        sandbox.updateManagedAudioUi(client);
        assert.equal(status.textContent, '麦克风采集已停止');
        dom.window.close();
    });
});
