'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const sinon = require('sinon');
const ManagedRecording = require('../app/src/ManagedRecording');
const { createRecordingRouter } = require('../app/src/RecordingHttp');

describe('recording deletion', function () {
    let root, manager, server, base, cookie, csrf;
    const secret = 'test-share-secret';

    beforeEach(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-deletion-'));
        manager = new ManagedRecording({
            enabled: true,
            defaultEnabled: true,
            storageDir: path.join(root, 'media'),
            dbPath: path.join(root, 'state.sqlite'),
            ffmpegPath: process.execPath,
        });
        await manager.initialize();
        const app = express();
        app.use(express.json());
        app.use(
            createRecordingRouter({
                manager,
                config: { admin: { username: 'admin', password: 'test-password' } },
                viewsDir: path.join(__dirname, '../public/views'),
            })
        );
        server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
        const login = await fetch(base + '/api/admin/recording/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: 'test-password' }),
        });
        cookie = login.headers.get('set-cookie').split(';')[0];
        csrf = (await login.json()).csrfToken;
    });

    afterEach(async () => {
        sinon.restore();
        await new Promise((resolve) => server.close(resolve));
        await manager.shutdown();
        fs.rmSync(root, { recursive: true, force: true });
    });

    function fixture(id = 'meeting') {
        manager.store.createMeeting({ id, roomId: id, startedAt: 1, recordingEnabled: true });
        manager.store.updateMeeting(id, { state: 'ready', ended_at: 2, composition_path: 'composition/current.mp4' });
        manager.store.createTrack({
            id: `${id}-track`,
            meetingId: id,
            socketId: 'peer',
            peerName: 'Test',
            kind: 'video',
            mediaType: 'video',
            producerId: 'producer',
            startedAt: 1,
            state: 'ready',
        });
        manager.store.createShare({
            id: `${id}-share`,
            meetingId: id,
            secretHash: crypto.createHash('sha256').update(secret).digest('hex'),
            createdAt: 1,
        });
        const directory = path.join(manager.config.storageDir, id);
        for (const file of ['tracks/raw.mkv', 'playback/video.webm', 'composition/current.mp4']) {
            fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
            fs.writeFileSync(path.join(directory, file), 'synthetic test media');
        }
        return directory;
    }

    function remove(id = 'meeting', headers = { Cookie: cookie, 'X-CSRF-Token': csrf }) {
        return fetch(`${base}/api/admin/recordings/${encodeURIComponent(id)}`, { method: 'DELETE', headers });
    }

    it('requires administrator authentication and a valid CSRF token', async () => {
        const directory = fixture();
        assert.equal((await remove('meeting', {})).status, 401);
        assert.equal((await remove('meeting', { Cookie: cookie })).status, 403);
        assert.equal((await remove('meeting', { Cookie: cookie, 'X-CSRF-Token': 'wrong' })).status, 403);
        assert(fs.existsSync(directory));
        assert(manager.getMeeting('meeting'));
    });

    it('deletes all media, cascades metadata and shares, and preserves other meetings', async () => {
        const directory = fixture();
        const other = fixture('other');
        assert.equal((await fetch(`${base}/api/public/recordings/meeting-share/${secret}`)).status, 200);
        assert.equal((await remove()).status, 204);
        assert(!fs.existsSync(directory));
        assert.equal(manager.getMeeting('meeting'), null);
        assert.equal(manager.store.getTrack('meeting-track'), null);
        assert.equal(manager.store.getShare('meeting-share'), null);
        assert.equal((await fetch(`${base}/api/public/recordings/meeting-share/${secret}`)).status, 404);
        assert(fs.existsSync(other));
        assert(manager.getMeeting('other'));
        assert.equal((await remove()).status, 404);
    });

    it('blocks deletion while the meeting is active, even with failed metadata', async () => {
        fixture();
        manager.store.updateMeeting('meeting', { state: 'failed' });
        manager.meetings.set('meeting', { required: false });
        assert.equal(manager.getMeeting('meeting').can_delete, false);
        assert.equal((await remove()).status, 409);
        manager.meetings.delete('meeting');
        assert.equal((await remove()).status, 204);
    });

    it('blocks deletion until remux work has settled', async () => {
        fixture();
        let finish;
        const job = manager.startBackground(
            new Promise((resolve) => {
                finish = resolve;
            }),
            'meeting'
        );
        assert.equal((await remove()).status, 409);
        finish();
        await job;
        assert.equal((await remove()).status, 204);
    });

    it('protects queued compositions before processing starts', async () => {
        fixture();
        let release;
        manager.compositionQueue = new Promise((resolve) => {
            release = resolve;
        });
        sinon.stub(manager, 'composeMeeting').resolves();
        const job = manager.queueComposition('meeting');
        assert.equal((await remove()).status, 409);
        release();
        await job;
        assert.equal((await remove()).status, 204);
    });

    it('keeps metadata on filesystem failure and allows retry', async () => {
        const directory = fixture();
        const stub = sinon.stub(fsp, 'rm').rejects(new Error('simulated storage error'));
        const response = await remove();
        assert.equal(response.status, 500);
        assert(!(await response.text()).includes('simulated storage error'));
        assert(manager.getMeeting('meeting'));
        assert(fs.existsSync(directory));
        stub.restore();
        assert.equal((await remove()).status, 204);
    });

    it('rejects traversal and allows removal of orphaned records after restart', async () => {
        manager.store.createMeeting({ id: '..', roomId: 'invalid', startedAt: 1, recordingEnabled: true });
        await assert.rejects(manager.deleteMeeting('..'), { statusCode: 400 });
        fixture();
        manager.store.updateMeeting('meeting', { state: 'recording' });
        assert.equal((await remove()).status, 204);
        assert(fs.existsSync(path.join(root, 'state.sqlite')));
    });

    it('prevents concurrent deletion and composition from recreating files', async () => {
        fixture();
        let release;
        const original = fsp.rm;
        sinon.stub(fsp, 'rm').callsFake(async (...args) => {
            await new Promise((resolve) => {
                release = resolve;
            });
            return original(...args);
        });
        const deletion = manager.deleteMeeting('meeting');
        await assert.rejects(manager.deleteMeeting('meeting'), { statusCode: 409 });
        await assert.rejects(manager.queueComposition('meeting'), /删除/);
        release();
        assert.equal(await deletion, true);
    });
});
