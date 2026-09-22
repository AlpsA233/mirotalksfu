'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const sinon = require('sinon');
const ManagedRecording = require('../app/src/ManagedRecording');

describe('recording failure and restart recovery', function () {
    let root, manager, clock;
    const room = { id: 'room', getSessionId: () => 'meeting' };

    function createManager() {
        return new ManagedRecording({
            enabled: true,
            defaultEnabled: true,
            storageDir: path.join(root, 'media'),
            dbPath: path.join(root, 'state.sqlite'),
            ffmpegPath: process.execPath,
            recoveryMs: 30,
            recoveryIntervalMs: 5,
        });
    }

    async function drain() {
        while (manager.backgroundJobs.size) await Promise.all([...manager.backgroundJobs]);
    }

    async function addTrack() {
        await manager.prepareMeeting(room);
        const meeting = manager.meetings.get('meeting');
        const producer = { id: 'producer', closed: false, pause: async () => {}, resume: async () => {} };
        const peer = { id: 'peer', peer_name: 'Ada' };
        const track = manager.createTrackState(meeting, peer, producer, 'audio', 'audio');
        track.gate = manager.markProducerPending(room, peer, producer);
        track.gate.track = track;
        meeting.tracks.set(track.id, track);
        manager.store.createTrack(track);
        await fsp.mkdir(path.dirname(track.partialPath), { recursive: true });
        await fsp.writeFile(track.partialPath, 'captured media');
        return track;
    }

    function mockRemux() {
        return sinon.stub(manager, 'generatePlayback').callsFake(async (track) => {
            assert(fs.existsSync(track.rawPath));
            const relative = `playback/${track.id}.webm`;
            const output = path.join(manager.meetingDir(track.meeting), relative);
            await fsp.mkdir(path.dirname(output), { recursive: true });
            await fsp.copyFile(track.rawPath, output);
            manager.store.updateTrack(track.id, { state: 'ready', playback_path: relative });
        });
    }

    beforeEach(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-recovery-'));
        manager = createManager();
        await manager.initialize();
    });

    afterEach(async () => {
        clock?.restore();
        clock = null;
        // Finish while test doubles are still installed, so no real media
        // process receives the deliberately invalid fixture bytes.
        await manager.shutdown();
        sinon.restore();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('ends the meeting within the original failure window despite repeated successful spawns', async () => {
        const track = await addTrack();
        clock = sinon.useFakeTimers({ now: 1000, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        const fatal = sinon.stub().resolves();
        manager.hooks.onFatal = fatal;
        sinon.stub(manager, 'stopTrack').callsFake(async (item) => {
            item.intentionalStop = true;
        });
        sinon.stub(manager, 'startTrack').callsFake(async (item) => {
            setTimeout(() => manager.handleTrackExit(item, 1), 1);
        });
        manager.scheduleRecovery(track, new Error('storage offline'));
        await clock.tickAsync(31);
        assert.equal(fatal.callCount, 1);
        assert.equal(manager.getMeeting('meeting').state, 'failed');
    });

    it('keeps the deadline active while a restart is stuck', async () => {
        const track = await addTrack();
        clock = sinon.useFakeTimers({ now: 1000, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        const fatal = sinon.stub().resolves();
        manager.hooks.onFatal = fatal;
        sinon.stub(manager, 'stopTrack').resolves();
        let release;
        sinon.stub(manager, 'startTrack').returns(
            new Promise((resolve) => {
                release = resolve;
            })
        );
        manager.scheduleRecovery(track, new Error('storage offline'));
        await clock.tickAsync(31);
        release();
        await drain();
        assert.equal(fatal.callCount, 1);
    });

    it('only cancels a failure window after advancing media is actually written', async () => {
        const track = await addTrack();
        clock = sinon.useFakeTimers({ now: 1000, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        const fatal = sinon.stub().resolves();
        manager.hooks.onFatal = fatal;
        sinon.stub(manager, 'stopTrack').callsFake(async (item) => {
            item.intentionalStop = true;
        });
        let recovered, progress;
        sinon.stub(manager, 'startTrack').callsFake(async (item) => {
            recovered = item;
            item.child = { exitCode: null, signalCode: null };
            progress = new PassThrough();
            manager.observeCaptureProgress(item, progress);
            fs.writeFileSync(item.partialPath, 'header');
        });
        manager.scheduleRecovery(track, new Error('storage offline'));
        await clock.tickAsync(6);
        progress.write('total_size=6\nout_time_us=0\nprogress=continue\n');
        assert.equal(track.meeting.recoveries.size, 1);
        fs.appendFileSync(recovered.partialPath, 'real media');
        const healthy = new Promise((resolve) => {
            const update = manager.store.updateTrack.bind(manager.store);
            sinon.stub(manager.store, 'updateTrack').callsFake((id, changes) => {
                const result = update(id, changes);
                if (id === recovered.id && changes.state === 'recording') resolve();
                return result;
            });
        });
        // Include a split progress line, as child pipes need not preserve records.
        progress.write('total_size=16\nout_time_');
        progress.write('us=1000000\nprogress=continue\n');
        await healthy;
        await clock.tickAsync(40);
        assert.equal(fatal.callCount, 0);
        assert.equal(track.meeting.recoveries.size, 0);
        // A later independent failure starts a new bounded window.
        manager.handleTrackExit(recovered, 1);
        await clock.tickAsync(31);
        assert.equal(fatal.callCount, 1);
    });

    it('preserves old media and starts a separate segment when retrying', async () => {
        const track = await addTrack();
        manager.config.recoveryMs = 5000;
        const remux = mockRemux();
        let resolveStart;
        const started = new Promise((resolve) => {
            resolveStart = resolve;
        });
        sinon.stub(manager, 'startTrack').callsFake(async (item) => {
            fs.writeFileSync(item.partialPath, 'new media');
            resolveStart(item);
        });
        manager.scheduleRecovery(track, new Error('recorder exited'));
        const next = await started;
        assert.notEqual(next.id, track.id);
        assert.notEqual(next.partialPath, track.partialPath);
        assert.equal(fs.readFileSync(track.rawPath, 'utf8'), 'captured media');
        assert.equal(next.gate.track, next);
        await manager.releaseProducer(room, track.producerId);
        await manager.finishMeeting(room);
        await drain();
        assert.equal(remux.callCount, 2);
        assert.equal(fs.readFileSync(next.rawPath, 'utf8'), 'new media');
        assert.equal(manager.getMeeting('meeting').tracks.length, 2);
    });

    it('does not interpret an intentionally paused healthy producer as a recording failure', async () => {
        const track = await addTrack();
        clock = sinon.useFakeTimers({ now: 1000, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        const fatal = sinon.stub().resolves();
        manager.hooks.onFatal = fatal;
        mockRemux();
        await manager.setProducerUserPaused(room, track.producerId, true);
        await clock.tickAsync(1000);
        assert.equal(fatal.callCount, 0);
        assert.equal(manager.getMeeting('meeting').state, 'recording');
    });

    it('reports a raw-file finalization failure instead of marking the meeting ready', async () => {
        const track = await addTrack();
        fs.writeFileSync(path.join(root, 'not-a-directory'), 'x');
        track.rawPath = path.join(root, 'not-a-directory', 'track.mkv');
        await manager.finishMeeting(room);
        await drain();
        assert.equal(manager.getMeeting('meeting').state, 'incomplete');
        assert.equal(manager.store.getTrack(track.id).state, 'incomplete');
        assert.match(manager.store.getTrack(track.id).failure_reason, /ENOTDIR/);
        assert(fs.existsSync(track.partialPath));
    });

    it('stays finalizing until remux completes without blocking room teardown', async () => {
        const track = await addTrack();
        let complete;
        sinon.stub(manager, 'generatePlayback').callsFake(
            () =>
                new Promise((resolve) => {
                    complete = () => {
                        manager.store.updateTrack(track.id, { state: 'ready', playback_path: 'playback/a.webm' });
                        resolve();
                    };
                })
        );
        await manager.finishMeeting(room);
        const pendingState = manager.getMeeting('meeting').state;
        assert.equal(manager.meetings.size, 0);
        complete();
        await drain();
        assert.equal(pendingState, 'finalizing');
        assert.equal(manager.getMeeting('meeting').state, 'ready');
    });

    it('propagates remux failures to the meeting and retains the raw recording', async () => {
        const track = await addTrack();
        sinon.stub(manager, 'generatePlayback').rejects(new Error('remux disk full'));
        await manager.finishMeeting(room);
        await drain();
        assert.equal(manager.getMeeting('meeting').state, 'incomplete');
        assert.equal(manager.store.getTrack(track.id).state, 'incomplete');
        assert.equal(fs.readFileSync(track.rawPath, 'utf8'), 'captured media');
    });

    it('keeps SQLite open when a bounded shutdown expires during track finalization', async () => {
        await addTrack();
        mockRemux();
        manager.config.shutdownTimeoutMs = 20;
        const finalize = manager.finalizeTrackMedia.bind(manager);
        let release;
        const paused = new Promise((resolve) => {
            release = resolve;
        });
        sinon.stub(manager, 'finalizeTrackMedia').callsFake(async (...args) => {
            await paused;
            return finalize(...args);
        });
        const close = sinon.spy(manager.store, 'close');
        const keepAlive = setTimeout(() => {}, 1000);
        await manager.shutdown();
        assert.equal(close.callCount, 0);
        release();
        await drain();
        clearTimeout(keepAlive);
        assert.equal(manager.getMeeting('meeting').state, 'ready');
    });

    it('recovers unfinished remux and composition after reopening the database', async () => {
        const track = await addTrack();
        manager.store.updateMeeting('meeting', {
            state: 'finalizing',
            ended_at: Date.now(),
            composition_state: 'running',
            composition_path: 'composition/current.mp4',
        });
        manager.store.updateTrack(track.id, {
            state: 'finalizing',
            raw_path: track.rawRelativePath,
            ended_at: Date.now(),
        });
        const composition = path.join(manager.meetingDir(track.meeting), 'composition/current.mp4');
        fs.mkdirSync(path.dirname(composition));
        fs.writeFileSync(composition, 'previous composition');
        manager.store.close();
        manager = createManager();
        const remux = mockRemux();
        const compose = sinon.stub(manager, 'composeMeeting').callsFake(async () => {
            assert.equal(manager.store.getTrack(track.id).state, 'ready');
            assert.equal(fs.readFileSync(composition, 'utf8'), 'previous composition');
            manager.store.updateMeeting('meeting', { composition_state: 'ready' });
        });
        await manager.initialize();
        await drain();
        assert.equal(remux.callCount, 1);
        assert.equal(compose.callCount, 1);
        assert.equal(manager.getMeeting('meeting').state, 'ready');
        assert(!fs.existsSync(track.partialPath));
    });

    it('marks interrupted capture incomplete and settles missing files rather than leaving stale recording state', async () => {
        const track = await addTrack();
        fs.unlinkSync(track.partialPath);
        manager.store.close();
        manager = createManager();
        await manager.initialize();
        await drain();
        const meeting = manager.getMeeting('meeting');
        assert.equal(meeting.state, 'incomplete');
        assert(meeting.ended_at);
        assert.equal(manager.store.getTrack(track.id).state, 'incomplete');
        assert.equal(manager.backgroundJobs.size, 0);
    });

    it('salvages legacy partial files without claiming interrupted capture was complete', async () => {
        const track = await addTrack();
        manager.store.updateTrack(track.id, { raw_path: null });
        manager.store.close();
        manager = createManager();
        const remux = mockRemux();
        await manager.initialize();
        await drain();
        assert.equal(remux.callCount, 1);
        assert.equal(manager.store.getTrack(track.id).state, 'ready');
        assert.equal(manager.getMeeting('meeting').state, 'incomplete');
        assert.equal(fs.readFileSync(track.rawPath, 'utf8'), 'captured media');
    });

    it('recovers old queued compositions beyond the library page limit with their saved selection', async () => {
        for (let index = 0; index < 205; index++) {
            const id = `meeting-${index}`;
            manager.store.createMeeting({ id, roomId: id, startedAt: index, recordingEnabled: true });
            manager.store.updateMeeting(id, { state: 'ready', ended_at: index + 1 });
        }
        manager.store.updateMeeting('meeting-0', {
            composition_state: 'queued',
            composition_primary_track_id: 'selected-camera',
        });
        manager.store.close();
        manager = createManager();
        const compose = sinon.stub(manager, 'composeMeeting').resolves();
        await manager.initialize();
        await drain();
        assert(compose.calledOnceWithExactly('meeting-0', 'selected-camera'));
    });

    it('persists a composition request before it can start processing', async () => {
        await manager.prepareMeeting(room);
        await manager.finishMeeting(room);
        let release;
        manager.compositionQueue = new Promise((resolve) => {
            release = resolve;
        });
        sinon.stub(manager, 'composeMeeting').resolves();
        const job = manager.queueComposition('meeting', 'camera');
        const saved = manager.store.getMeeting('meeting');
        release();
        await job;
        assert.equal(saved.composition_state, 'queued');
        assert.equal(saved.composition_primary_track_id, 'camera');
    });
});
