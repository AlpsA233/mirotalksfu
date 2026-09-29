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

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const sourceStatus = {
    state: 'ready',
    assetId: 'source-asset',
    quality: 'source',
    started_at: 2000,
    metadata: {
        width: 1920,
        height: 1080,
        videoCodec: 'h264',
        audioCodec: 'aac',
        fps: 25,
        bytes: 1000000,
        duration: 90,
        bitrate: 1000000,
        recordingSources: [{ width: 1920, height: 1080 }],
    },
    qualities: [
        { id: 'source', label: '源分辨率', width: 1920, height: 1080 },
        { id: '720p', width: 1280, height: 720 },
        { id: '480p', width: 852, height: 480 },
    ],
};
const variant = (quality) => ({
    ...sourceStatus,
    assetId: quality,
    quality,
    metadata: {
        ...sourceStatus.metadata,
        width: quality === '720p' ? 1280 : 852,
        height: quality === '720p' ? 720 : 480,
    },
});
function choose(doc, quality) {
    const select = doc.getElementById('playbackQuality');
    select.value = quality;
    select.onchange();
}
describe('playback quality controls', () => {
    it('keeps playing during generation and switches at the latest position, pause state, rate and volume', async () => {
        let complete;
        const { dom, doc } = await page('recordingDetail.html', '/recordings/meeting', (url, options) => {
            if (!url.includes('/playback/')) return;
            const quality = JSON.parse(options.body).quality;
            return quality === 'source'
                ? sourceStatus
                : new Promise((resolve) => {
                      complete = resolve;
                  });
        });
        try {
            const player = doc.getElementById('player');
            Object.defineProperty(player, 'duration', { value: 90 });
            Object.defineProperty(player, 'paused', { value: false, writable: true });
            let plays = 0,
                pauses = 0;
            player.play = async () => {
                plays++;
                player.paused = false;
            };
            player.pause = () => {
                pauses++;
                player.paused = true;
            };
            player.onloadedmetadata();
            player.currentTime = 10;
            choose(doc, '720p');
            await tick();
            assert(player.src.endsWith('/source-asset'));
            assert.equal(pauses, 0);
            assert.equal(doc.getElementById('qualityProgress').hidden, false);
            // User interaction during generation must win over the original switch position.
            player.currentTime = 37;
            player.paused = true;
            player.playbackRate = 1.5;
            player.volume = 0.3;
            complete(variant('720p'));
            await tick();
            player.currentTime = 0;
            player.onloadedmetadata();
            assert.equal(player.currentTime, 37);
            assert.equal(player.paused, true);
            assert.equal(plays, 0);
            assert.equal(player.playbackRate, 1.5);
            assert.equal(player.volume, 0.3);
            assert(doc.getElementById('download').href.endsWith('/assets/720p?download=1'));
            assert(doc.getElementById('download').textContent.includes('720p'));
        } finally {
            dom.window.close();
        }
    });
    it('applies only the last selection even if earlier replies finish later', async () => {
        const pending = {};
        const { dom, doc } = await page('recordingDetail.html', '/recordings/meeting', (url, options) => {
            if (!url.includes('/playback/')) return;
            const quality = JSON.parse(options.body).quality;
            return quality === 'source'
                ? sourceStatus
                : new Promise((resolve) => {
                      pending[quality] = resolve;
                  });
        });
        try {
            choose(doc, '720p');
            choose(doc, '480p');
            pending['480p'](variant('480p'));
            await tick();
            pending['720p'](variant('720p'));
            await tick();
            assert(doc.getElementById('player').src.endsWith('/assets/480p'));
        } finally {
            dom.window.close();
        }
    });
    it('retains the seek position when a second quality is chosen before the first file loads', async () => {
        const { dom, doc } = await page('recordingDetail.html', '/recordings/meeting', (url, options) => {
            if (!url.includes('/playback/')) return;
            const quality = JSON.parse(options.body).quality;
            return quality === 'source' ? sourceStatus : variant(quality);
        });
        try {
            const player = doc.getElementById('player');
            Object.defineProperty(player, 'duration', { value: 90 });
            player.onloadedmetadata();
            player.currentTime = 21;
            choose(doc, '720p');
            await tick();
            // No loadedmetadata event yet: the browser resets currentTime during loading.
            player.currentTime = 0;
            choose(doc, '480p');
            await tick();
            player.onloadedmetadata();
            assert.equal(player.currentTime, 21);
            assert(player.src.endsWith('/assets/480p'));
        } finally {
            dom.window.close();
        }
    });

    it('retains the current video on failure, permits public retry and displays unavailable statistics', async () => {
        let failed = false;
        const { dom, doc, calls } = await page('recordingShare.html', '/recordings/share/id/secret', (url) => {
            if (!url.includes('/playback/')) return;
            if (url.includes('quality=source')) return sourceStatus;
            if (!url.includes('retry=true')) {
                failed = true;
                return { state: 'failed', error: '请重试' };
            }
            return variant('720p');
        });
        try {
            choose(doc, '720p');
            await tick();
            assert(failed);
            assert(doc.getElementById('player').src.endsWith('/source-asset'));
            assert.equal(doc.getElementById('retryQuality').hidden, false);
            doc.getElementById('retryQuality').click();
            await tick();
            assert(doc.getElementById('player').src.endsWith('/720p'));
            assert(calls.some((c) => c.url.includes('retry=true')));
            doc.getElementById('toggleDetails').click();
            assert(doc.getElementById('fileDetails').textContent.includes('1920×1080'));
            assert(doc.getElementById('playbackStats').textContent.includes('不可用'));
            doc.getElementById('closeDetails').click();
            assert.equal(doc.getElementById('videoDetails').hidden, true);
        } finally {
            dom.window.close();
        }
    });
    it('remembers desired quality between views while displaying each actual quality', async () => {
        const other = {
            ...meeting,
            views: [...meeting.views, { ...meeting.views[0], id: 'small-view', name: 'Small' }],
        };
        const { dom, doc, calls } = await page('recordingDetail.html', '/recordings/meeting', (url, options) => {
            if (url === '/api/admin/recordings/meeting') return other;
            if (!url.includes('/playback/')) return;
            if (url.includes('small-view'))
                return { ...sourceStatus, assetId: 'small-source', qualities: [sourceStatus.qualities[0]] };
            const q = JSON.parse(options.body).quality;
            return q === 'source' ? sourceStatus : variant(q);
        });
        try {
            choose(doc, '720p');
            await tick();
            doc.querySelectorAll('.angle-button')[1].click();
            await tick();
            assert.equal(doc.getElementById('playbackQuality').value, 'source');
            doc.querySelectorAll('.angle-button')[0].click();
            await tick();
            assert.equal(doc.getElementById('playbackQuality').value, '720p');
            assert.equal(JSON.parse(calls.filter((c) => c.url.includes('small-view'))[0].options.body).quality, '720p');
        } finally {
            dom.window.close();
        }
    });
});
