'use strict';

require('should');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ManagedRecording = require('../app/src/ManagedRecording');
const RecordingStore = require('../app/src/RecordingStore');
const { publicMeeting } = require('../app/src/RecordingHttp');

describe('test-ManagedRecording', () => {
    let root;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'mirotalk-managed-recording-'));
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    function createManager(defaultEnabled = true) {
        return new ManagedRecording({
            enabled: true,
            defaultEnabled,
            storageDir: path.join(root, 'media'),
            dbPath: path.join(root, 'state', 'recordings.sqlite'),
            // Initialization validates executability only; no FFmpeg process is
            // started by these metadata/lifecycle tests.
            ffmpegPath: process.execPath,
            rtpPortMin: 42000,
            rtpPortMax: 42005,
        });
    }

    it('snapshots the administrator default once per meeting', async () => {
        const manager = createManager(true);
        await manager.initialize();
        const firstRoom = { id: 'room-a', getSessionId: () => 'meeting-a' };
        const first = await manager.prepareMeeting(firstRoom);
        first.should.containEql({ required: true, meetingId: 'meeting-a', state: 'recording' });

        manager.setEnabled(false);
        (await manager.prepareMeeting(firstRoom)).required.should.be.true();
        (await manager.prepareMeeting({ id: 'room-b', getSessionId: () => 'meeting-b' })).required.should.be.false();

        manager.getMeeting('meeting-a').state.should.equal('recording');
        await manager.shutdown();
    });

    it('persists a ready meeting only after the shared finalization path completes', async () => {
        const manager = createManager(true);
        await manager.initialize();
        const room = { id: 'room-a', getSessionId: () => 'meeting-a' };
        await manager.prepareMeeting(room);
        await manager.finishMeeting(room, 'api_end');
        const meeting = manager.getMeeting('meeting-a');
        meeting.state.should.equal('ready');
        meeting.ended_at.should.be.a.Number();
        await manager.shutdown();
    });

    it('uses an even RTP/RTCP port pair and writes SDP with an explicit common endpoint', () => {
        const manager = createManager();
        manager.allocatePorts().should.deepEqual({ rtpPort: 42000, rtcpPort: 42001 });
        manager.allocatePorts().should.deepEqual({ rtpPort: 42002, rtcpPort: 42003 });
        const sdp = manager.createSdp(
            {
                kind: 'audio',
                rtpParameters: {
                    codecs: [
                        { mimeType: 'audio/opus', payloadType: 111, clockRate: 48000, channels: 2, parameters: {} },
                    ],
                    encodings: [{ ssrc: 1234 }],
                },
            },
            42000,
            42001
        );
        sdp.should.containEql('m=audio 42000 RTP/AVPF 111');
        sdp.should.containEql('a=rtcp:42001 IN IP4 127.0.0.1');
        sdp.should.containEql('a=ssrc:1234 cname:mirotalk-recording');
    });

    it('does not let a resume request bypass a recorder gate that is still preparing', async () => {
        const manager = createManager();
        await manager.initialize();
        const room = { id: 'room-a', getSessionId: () => 'meeting-a' };
        await manager.prepareMeeting(room);
        let resumes = 0;
        const producer = {
            id: 'producer-a',
            closed: false,
            pause: async () => {},
            resume: async () => {
                resumes += 1;
            },
        };
        manager.markProducerPending(room, { id: 'socket-a' }, producer);

        (await manager.setProducerUserPaused(room, producer.id, false)).should.be.true();
        resumes.should.equal(0);

        manager.meetings.get('meeting-a').producerGates.get(producer.id).ready = true;
        await manager.setProducerUserPaused(room, producer.id, false);
        resumes.should.equal(1);
        await manager.shutdown();
    });

    it('keeps public playback metadata free of raw source paths', () => {
        const publicValue = publicMeeting(null, {
            id: 'meeting',
            room_id: 'room',
            started_at: 1,
            ended_at: 2,
            state: 'ready',
            composition_state: 'none',
            composition_path: null,
            tracks: [
                {
                    id: 'playable',
                    peer_name: 'Ada',
                    kind: 'video',
                    media_type: 'camera',
                    playback_path: 'playback/a.webm',
                },
                { id: 'raw-only', peer_name: 'Ben', kind: 'audio', media_type: 'audio', raw_path: 'tracks/b.mkv' },
            ],
        });
        publicValue.tracks.should.have.length(1);
        publicValue.tracks[0].id.should.equal('playable');
        JSON.stringify(publicValue).should.not.containEql('tracks/b.mkv');
    });

    it('stores raw and public asset state separately', () => {
        const store = new RecordingStore(path.join(root, 'state.sqlite'));
        store.createMeeting({ id: 'meeting', roomId: 'room', startedAt: 1, recordingEnabled: true });
        store.createTrack({
            id: 'track',
            meetingId: 'meeting',
            socketId: 'socket',
            peerName: 'Ada',
            kind: 'video',
            mediaType: 'camera',
            producerId: 'producer',
            startedAt: 1,
        });
        store.updateTrack('track', { raw_path: 'tracks/a.mkv', playback_path: 'playback/a.webm', state: 'ready' });
        store.getTrack('track').raw_path.should.equal('tracks/a.mkv');
        store.getTrack('track').playback_path.should.equal('playback/a.webm');
        store.close();
    });
});
