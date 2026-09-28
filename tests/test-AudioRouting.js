'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const AudioRouting = require('../app/src/AudioRouting');
const Room = require('../app/src/Room');
const Peer = require('../app/src/Peer');

function fixture() {
    const room = Object.create(Room.prototype);
    const owner = new Peer('owner', { peer_info: { peer_name: 'Owner', peer_presenter: false } });
    const listener = new Peer('listener', { peer_info: { peer_name: 'Listener' } });
    const producer = {
        id: 'mic',
        kind: 'audio',
        closed: false,
        appData: { mediaType: 'audioType', audioMode: 'record_only' },
        pause: () => assert.fail('Do not pause the recorder source'),
        resume: () => assert.fail('Do not bypass the recorder gate'),
    };
    owner.producers.set(producer.id, producer);
    const events = [];
    const observerActions = [];
    const observer = {
        addProducer: async ({ producerId }) => observerActions.push(['add', producerId]),
        removeProducer: async ({ producerId }) => observerActions.push(['remove', producerId]),
    };
    Object.assign(room, {
        peers: new Map([
            [owner.id, owner],
            [listener.id, listener],
        ]),
        recordOnlyAudio: true,
        _moderator: {},
        router: { canConsume: () => true },
        audioLevelObserver: observer,
        activeSpeakerObserver: observer,
        sendToAll: (event, data) => events.push({ event, data }),
        broadCast: (id, event, data) => events.push({ id, event, data }),
        send: (id, event, data) => events.push({ id, event, data }),
    });
    const consumer = Object.assign(new EventEmitter(), {
        id: 'consumer',
        producerId: producer.id,
        kind: 'audio',
        closed: false,
        paused: true,
        appData: { consumerTransportId: 'transport' },
        resume: async () => {
            consumer.paused = false;
        },
        close: () => {
            consumer.closed = true;
        },
    });
    listener.getTransport = () => ({ iceState: 'connected', dtlsState: 'connected' });
    listener.createConsumer = async () => {
        listener.addConsumer(consumer.id, consumer);
        return { consumer, params: { id: consumer.id } };
    };
    return { room, owner, listener, producer, consumer, events, observerActions };
}

describe('managed microphone routing', () => {
    it('hides record-only audio from late joiners and rejects direct subscriptions', async () => {
        const { room, producer } = fixture();
        assert.deepEqual(room.getProducerListForPeer('listener'), []);
        await assert.rejects(room.consume('listener', 'transport', producer.id, {}, 'audioType'), {
            code: 'AUDIO_NOT_LIVE',
        });
    });

    it('creates managed microphones with a private mode before publishing them', async () => {
        const { room, owner, producer, events } = fixture();
        owner.hasTransport = () => true;
        owner.getTransport = () => ({});
        owner.createProducer = async (...args) => {
            assert.equal(args[5], 'record_only');
            assert.equal(args[4], true);
            return producer;
        };
        await room.produce(owner.id, 'transport', { codecs: [] }, 'audio', 'audioType', true);
        assert.equal(owner.peer_info.peer_audio, false);
        assert.equal(owner.peer_info.peer_audio_mode, 'record_only');
        assert(!events.some(({ event }) => event === 'newProducers'));
    });

    it('only delivers live audio and keeps the recorder source running during toggles', async () => {
        const { room, owner, producer, consumer, events, observerActions } = fixture();
        await AudioRouting.setMode(room, owner, producer, 'live');
        assert.equal(room.getProducerListForPeer('listener').length, 1);
        assert.equal(owner.peer_info.peer_audio, true);
        await room.consume('listener', 'transport', producer.id, {}, 'audioType');
        await room.resumeConsumer('listener', consumer.id);
        assert.equal(consumer.paused, false);
        await AudioRouting.setMode(room, owner, producer, 'record_only');
        assert.equal(consumer.closed, true);
        assert.equal(producer.closed, false);
        assert.equal(owner.peer_info.peer_audio, false);
        assert.equal(owner.peer_info.peer_audio_capture, true);
        assert(events.some(({ event }) => event === 'consumerClosed'));
        assert.deepEqual(
            observerActions.map(([action]) => action),
            ['add', 'add', 'remove', 'remove']
        );
        await assert.rejects(room.resumeConsumer('listener', consumer.id), /Consumer not found/);
    });

    it('rejects a subscription that finishes after speaking ends', async () => {
        const { room, owner, producer, listener, consumer } = fixture();
        await AudioRouting.setMode(room, owner, producer, 'live');
        let finish;
        listener.createConsumer = () =>
            new Promise((resolve) => {
                finish = () => {
                    listener.addConsumer(consumer.id, consumer);
                    resolve({ consumer, params: { id: consumer.id } });
                };
            });
        const subscription = room.consume('listener', 'transport', producer.id, {}, 'audioType');
        await AudioRouting.setMode(room, owner, producer, 'record_only');
        finish();
        await assert.rejects(subscription, { code: 'AUDIO_NOT_LIVE' });
        assert.equal(consumer.closed, true);
    });

    it('rejects resuming a stale consumer while only recording', async () => {
        const { room, listener, consumer } = fixture();
        listener.addConsumer(consumer.id, consumer);
        await assert.rejects(room.resumeConsumer(listener.id, consumer.id), { code: 'AUDIO_NOT_LIVE' });
        assert.equal(consumer.paused, true);
    });

    it('serializes rapid press/release and does not duplicate announcements', async () => {
        const { room, owner, producer, events } = fixture();
        await Promise.all([
            AudioRouting.setMode(room, owner, producer, 'live'),
            AudioRouting.setMode(room, owner, producer, 'live'),
            AudioRouting.setMode(room, owner, producer, 'record_only'),
        ]);
        assert.equal(producer.appData.audioMode, 'record_only');
        assert.equal(events.filter(({ event }) => event === 'newProducers').length, 1);
    });

    it('enforces ownership, valid modes and moderator restrictions', async () => {
        const { room, owner, listener, producer } = fixture();
        await assert.rejects(AudioRouting.setMode(room, listener, producer, 'live'), /not found/);
        await assert.rejects(AudioRouting.setMode(room, owner, producer, 'invalid'), /Invalid audio mode/);
        room._moderator.audio_cant_unmute = true;
        await assert.rejects(AudioRouting.setMode(room, owner, producer, 'live'), /does not allow/);
        assert.equal(producer.appData.audioMode, 'record_only');
        owner.peer_info.peer_presenter = true;
        await AudioRouting.setMode(room, owner, producer, 'live');
        assert.equal(producer.appData.audioMode, 'live');
    });

    it('preserves ordinary audio and screen audio routing', async () => {
        const { room, owner, producer, events } = fixture();
        delete producer.appData.audioMode;
        assert.equal(room.getProducerListForPeer('listener').length, 1);
        owner.hasTransport = () => true;
        owner.getTransport = () => ({});
        owner.createProducer = async (...args) => {
            assert.equal(args[5], undefined);
            return producer;
        };
        await room.produce(owner.id, 'transport', { codecs: [] }, 'audio', 'audioTab', true);
        assert(events.some(({ event }) => event === 'newProducers'));
        room.recordOnlyAudio = false;
        await room.produce(owner.id, 'transport', { codecs: [] }, 'audio', 'audioType', false);
    });
});
