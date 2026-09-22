'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { playbackViews, describeViews } = require('../app/src/RecordingPlayback');
const ManagedRecording = require('../app/src/ManagedRecording');

function track(id, kind, socket = 'alice', started_at = 1000, media_type = kind) {
    return {
        id,
        kind,
        socket_id: socket,
        peer_name: '同名用户',
        started_at,
        ended_at: 6000,
        media_type,
        state: 'ready',
        playback_path: `playback/${id}.webm`,
        checksum: id,
    };
}

describe('participant playback', () => {
    it('pairs a participant camera with all of their microphone segments', () => {
        const views = playbackViews({
            tracks: [track('video', 'video'), track('audio1', 'audio'), track('audio2', 'audio', 'alice', 3000)],
        });
        assert.equal(views.length, 1);
        assert.equal(views[0].has_audio, true);
        assert.equal(views[0].has_video, true);
        assert.equal(views[0].ready, true);
        assert.deepEqual(views[0].sources.map((item) => item.id).sort(), ['audio1', 'audio2', 'video']);
    });
    it('does not mix audio between people with the same display name', () => {
        const views = playbackViews({
            tracks: [
                track('v1', 'video'),
                track('a1', 'audio'),
                track('v2', 'video', 'bob'),
                track('a2', 'audio', 'bob'),
            ],
        });
        assert.equal(views.length, 2);
        assert.notEqual(views[0].id, views[1].id);
        assert(views.every((view) => new Set(view.sources.map((item) => item.socket_id)).size === 1));
    });
    it('gives camera and screen distinct views with the participant audio in both', () => {
        const views = playbackViews({
            tracks: [
                track('camera', 'video'),
                track('screen', 'video', 'alice', 2000, 'screenType'),
                track('mic', 'audio'),
            ],
        });
        assert.deepEqual(
            views.map((view) => view.kind),
            ['camera', 'screen']
        );
        assert(views.every((view) => view.sources.some((item) => item.id === 'mic')));
    });
    it('supports audio-only recordings and blocks incomplete input', () => {
        const audio = track('audio', 'audio');
        assert.equal(playbackViews({ tracks: [audio] })[0].kind, 'audio');
        assert.equal(
            playbackViews({ tracks: [audio, { ...track('v', 'video'), state: 'finalizing', playback_path: null }] })[0]
                .ready,
            false
        );
    });
    it('plays surviving recovery segments while retaining their original time offsets', () => {
        const failed = { ...track('lost', 'audio'), state: 'incomplete', playback_path: null };
        const recovered = track('recovered', 'audio', 'alice', 4000);
        const view = playbackViews({ tracks: [track('before', 'audio'), failed, recovered] })[0];
        assert.equal(view.ready, true);
        assert.deepEqual(
            view.sources.map((item) => item.id),
            ['before', 'recovered']
        );
        assert.equal(view.sources[1].started_at, 4000);
    });
    it('invalidates cached playback when tracks change without exposing source paths', () => {
        const meeting = { tracks: [track('v', 'video'), track('a', 'audio')] };
        const before = describeViews(meeting)[0];
        meeting.tracks.push(track('v2', 'video', 'alice', 4000));
        const after = describeViews(meeting)[0];
        assert.equal(before.id, after.id);
        assert.notEqual(before.assetId, after.assetId);
        assert(!JSON.stringify(after).includes('playback/'));
        assert(!('sources' in after));
    });
    it('provides real search, status filters and counts for the library', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-library-'));
        const manager = new ManagedRecording({
            enabled: true,
            storageDir: path.join(root, 'media'),
            dbPath: path.join(root, 'state.sqlite'),
            ffmpegPath: process.execPath,
        });
        await manager.initialize();
        try {
            manager.store.createMeeting({ id: 'one', roomId: 'Design review', startedAt: 1, recordingEnabled: true });
            manager.store.createMeeting({ id: 'two', roomId: 'Standup', startedAt: 2, recordingEnabled: true });
            manager.store.updateMeeting('one', { state: 'ready' });
            manager.store.createTrack({
                id: 'track',
                meetingId: 'one',
                socketId: 'alice',
                peerName: 'Alice',
                kind: 'audio',
                mediaType: 'audio',
                producerId: 'a',
                startedAt: 1,
            });
            assert.equal(manager.listMeetings({ search: 'alice' }).length, 1);
            assert.equal(manager.store.countMeetings({ search: 'DESIGN', status: 'ready' }), 1);
            assert.equal(manager.store.countMeetings({ status: 'processing' }), 1);
            assert.equal(manager.store.countMeetings({ search: '%' }), 0);
            assert.deepEqual({ ...manager.store.meetingSummary() }, { total: 2, ready: 1, processing: 1 });
        } finally {
            await manager.shutdown();
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
