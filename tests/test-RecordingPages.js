'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '../public/js/Recordings.js'), 'utf8');
const meeting = {
    id: 'meeting',
    room_id: '<img src=x onerror=alert(1)>',
    started_at: 1000,
    ended_at: 345000,
    state: 'ready',
    can_delete: true,
    tracks: [
        {
            id: 'v',
            socket_id: 'alice',
            peer_name: 'Alice',
            kind: 'video',
            started_at: 2000,
            ended_at: 44000,
            playback_path: 'video.webm',
        },
        {
            id: 'a',
            socket_id: 'alice',
            peer_name: 'Alice',
            kind: 'audio',
            started_at: 2000,
            ended_at: 44000,
            playback_path: 'audio.webm',
        },
    ],
    views: [
        {
            id: 'alice-camera',
            name: 'Alice',
            kind: 'camera',
            ready: true,
            has_audio: true,
            has_video: true,
            started_at: 2000,
        },
    ],
};
async function page(name, pathname, handler) {
    const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../public/views', name), 'utf8'), {
        url: `http://localhost${pathname}`,
        runScripts: 'outside-only',
    });
    const calls = [];
    dom.window.HTMLMediaElement.prototype.load = function () {};
    dom.window.HTMLMediaElement.prototype.pause = function () {};
    dom.window.HTMLMediaElement.prototype.play = async function () {};
    dom.window.fetch = async (url, options) => {
        calls.push({ url, options });
        const body =
            handler?.(url, options) ??
            (url === '/api/admin/recording/session'
                ? { csrfToken: 'csrf', settings: { enabled: true } }
                : url.startsWith('/api/admin/recordings?')
                  ? { meetings: [meeting], total: 1, summary: { total: 1, ready: 1, processing: 0 } }
                  : url.includes('/playback/')
                    ? { state: 'ready', assetId: 'combined', started_at: 2000 }
                    : meeting);
        return { ok: true, status: 200, json: async () => body };
    };
    dom.window.eval(source);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { dom, doc: dom.window.document, calls };
}
describe('recording pages', () => {
    it('keeps the library separate from playback and uses recording duration without grace time', async () => {
        const { dom, doc } = await page('recordings.html', '/recordings');
        try {
            assert.equal(doc.querySelector('#player'), null);
            assert.equal(doc.querySelector('.card-title').textContent, meeting.room_id);
            assert.equal(doc.querySelector('.card-title img'), null);
            assert.equal(doc.querySelector('.open-recording').getAttribute('href'), '/recordings/meeting');
            assert.equal(doc.querySelector('.duration-pill').textContent, '0:42');
            assert.equal(doc.querySelectorAll('.card-delete').length, 1);
        } finally {
            dom.window.close();
        }
    });
    it('defaults to one synchronized participant view and one downloadable media file', async () => {
        const { dom, doc, calls } = await page('recordingDetail.html', '/recordings/meeting');
        try {
            assert.equal(doc.querySelectorAll('.angle-button').length, 1);
            assert(doc.querySelector('.angle-button').textContent.includes('含声音'));
            assert(doc.querySelector('#syncLabel').textContent.includes('同步'));
            assert(doc.querySelector('#player').src.endsWith('/assets/combined'));
            assert(doc.querySelector('#download').href.endsWith('/assets/combined?download=1'));
            const request = calls.find((call) => call.url.endsWith('/playback/alice-camera'));
            assert.equal(request.options.method, 'POST');
            assert.equal(request.options.headers['X-CSRF-Token'], 'csrf');
            assert.equal(doc.querySelector('#aboutPeople').textContent, '1 人');
        } finally {
            dom.window.close();
        }
    });
    it('uses the same synchronized viewing model for a public share', async () => {
        const { dom, doc, calls } = await page('recordingShare.html', '/recordings/share/id/secret');
        try {
            assert(doc.querySelector('#player').src.includes('/api/public/recordings/id/secret/assets/combined'));
            assert(!calls.some((call) => call.url.includes('/api/admin/')));
            assert.equal(doc.body.dataset.page, 'share');
        } finally {
            dom.window.close();
        }
    });
    it('shows audio artwork for an audio-only participant', async () => {
        const audio = {
            ...meeting,
            tracks: [meeting.tracks[1]],
            views: [{ ...meeting.views[0], kind: 'audio', has_video: false }],
        };
        const { dom, doc } = await page('recordingDetail.html', '/recordings/meeting', (url) =>
            url === '/api/admin/recordings/meeting' ? audio : undefined
        );
        try {
            assert.equal(doc.querySelector('#audioArtwork').hidden, false);
            assert.equal(doc.querySelector('#audioName').textContent, 'Alice');
        } finally {
            dom.window.close();
        }
    });
});
