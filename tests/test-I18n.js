'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const publicDir = path.join(__dirname, '../public');
const source = fs.readFileSync(path.join(publicDir, 'js/I18n.js'), 'utf8');
const locales = Object.fromEntries(
    ['en', 'zh', 'fr'].map((lang) => [lang, JSON.parse(fs.readFileSync(path.join(publicDir, `lang/${lang}.json`)))])
);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('native UI language switching', () => {
    const windows = [];
    afterEach(() => windows.splice(0).forEach((window) => window.close()));

    async function page({ html, name, lang = 'en', mode, saved, url = '/', fetch, brandReady, brand = false } = {}) {
        const dom = new JSDOM(
            html ||
                (name && fs.readFileSync(path.join(publicDir, `views/${name}.html`), 'utf8')) ||
                '<html lang="en"><body><div data-language-picker></div><div id="tabLanguages"></div><button id="mute" title="Mute">Mute</button></body></html>',
            { url: `http://localhost${url}`, runScripts: 'outside-only' }
        );
        const { window } = dom;
        windows.push(window);
        const requests = [];
        window.BRAND = { app: { language: lang, translationMode: mode } };
        window.brandReady = brandReady || Promise.resolve();
        window.tippy = () => ({});
        window.Swal = { fire: () => {} };
        window.RoomClient = function () {};
        window.RoomClient.prototype.userLog = () => {};
        window.console.log = () => {};
        window.console.warn = () => {};
        if (saved) window.localStorage.setItem('uiLanguageOverride', saved);
        window.fetch = async (url) => {
            requests.push(url);
            if (fetch) return fetch(url);
            const lang = /\/lang\/(\w+)\.json$/.exec(url)?.[1];
            return { ok: Boolean(locales[lang]), json: async () => locales[lang] };
        };
        if (brand) {
            window.sessionStorage.setItem('brandData', JSON.stringify(window.BRAND));
            window.eval(fs.readFileSync(path.join(publicDir, 'js/Brand.js'), 'utf8'));
        }
        window.eval(source);
        await window.i18n.ready;
        return { window, doc: window.document, requests };
    }

    it('switches the real landing page in both directions without replacing controls or user input', async () => {
        const { window, doc } = await page({ name: 'landing', brand: true });
        const button = doc.querySelector('#joinRoomButton');
        const englishButton = button.textContent;
        const input = doc.querySelector('#roomName');
        input.value = 'My room';
        let clicks = 0;
        button.addEventListener('click', () => clicks++);
        doc.querySelector('#lastRoom').textContent = 'Share';
        const picker = doc.querySelector('[data-i18n-select]');
        picker.value = 'zh';
        picker.dispatchEvent(new window.Event('change'));
        await tick();
        assert.equal(button.textContent.trim(), '加入房间');
        assert(doc.querySelector('#appTitle').textContent.includes('让交流，更近一点。'));
        assert.equal(doc.documentElement.lang, 'zh-CN');
        assert.equal(window.localStorage.getItem('uiLanguageOverride'), 'zh');
        assert.equal(doc.querySelector('#lastRoom').textContent, 'Share');
        assert.equal(input.value, 'My room');
        button.click();
        assert.equal(clicks, 1);
        await window.i18n.setLanguage('en');
        assert.equal(doc.querySelector('#joinRoomButton'), button);
        assert.equal(button.textContent, englishButton);
        assert(doc.querySelector('#appTitle').textContent.includes('A little closer.'));
        assert.equal(doc.documentElement.lang, 'en');
        assert.equal(window.localStorage.getItem('uiLanguageOverride'), 'en');
    });

    it('loads saved Chinese on nested room URLs even with a legacy Google configuration', async () => {
        const { window, doc, requests } = await page({ saved: 'zh', mode: 'google', url: '/join/my-room' });
        assert.equal(doc.querySelector('#mute').textContent, '静音');
        assert.deepEqual(requests, ['/lang/zh.json']);
        assert.equal(window.i18n.googleAllowed, false);
        assert.equal(doc.querySelectorAll('[data-i18n-select]').length, 2);
        await window.i18n.setLanguage('en');
        assert([...doc.querySelectorAll('[data-i18n-select]')].every((select) => select.value === 'en'));
        const next = await page({
            saved: window.localStorage.getItem('uiLanguageOverride'),
            lang: 'zh',
            mode: 'google',
        });
        assert.equal(next.doc.querySelector('#mute').textContent, 'Mute');
        assert.equal(next.window.i18n.googleAllowed, false);
    });

    it('uses native Chinese by default, including region-qualified language codes', async () => {
        const { window, requests } = await page({ lang: 'zh-CN' });
        assert.equal(window.i18n.getLang(), 'zh');
        assert.equal(window.i18n.isNative(), true);
        assert.equal(window.i18n.googleAllowed, false);
        assert.deepEqual(requests, ['/lang/zh.json']);
    });

    it('offers a working Chinese picker in existing English Google installations', async () => {
        const { window, doc } = await page({ mode: 'google' });
        assert(doc.querySelector('[data-i18n-select] option[value="zh"]'));
        await window.i18n.setLanguage('zh');
        assert.equal(doc.querySelector('#mute').textContent, '静音');
        assert.equal(window.i18n.googleAllowed, false);
    });

    it('waits for branding before resolving the language', async () => {
        let resolveBrand;
        const ready = new Promise((resolve) => (resolveBrand = resolve));
        const pending = page({ brandReady: ready });
        const window = windows.at(-1);
        await tick();
        window.BRAND.app.language = 'zh';
        resolveBrand();
        const { doc } = await pending;
        assert.equal(doc.querySelector('#mute').textContent, '静音');
    });

    it('keeps the previous language and preference when a dictionary fails to load', async () => {
        const { window, doc } = await page({ saved: 'en', fetch: async () => ({ ok: false }) });
        assert.equal(await window.i18n.setLanguage('zh'), false);
        assert.equal(doc.querySelector('#mute').textContent, 'Mute');
        assert.equal(window.localStorage.getItem('uiLanguageOverride'), 'en');
        assert.equal(window.i18n.getLang(), 'en');
        assert(doc.querySelector('[data-i18n-error]').textContent.includes('语言加载失败'));
    });

    it('honors the latest selection if a previous dictionary request is still pending', async () => {
        let finish;
        const { window } = await page({
            fetch: () => new Promise((resolve) => (finish = () => resolve({ ok: true, json: async () => locales.zh }))),
        });
        const chinese = window.i18n.setLanguage('zh');
        await window.i18n.setLanguage('en');
        finish();
        assert.equal(await chinese, false);
        assert.equal(window.i18n.getLang(), 'en');
        assert.equal(window.localStorage.getItem('uiLanguageOverride'), 'en');
    });

    it('translates later text and attribute changes and restores their latest English source', async () => {
        const { window, doc } = await page({ saved: 'zh' });
        const button = doc.querySelector('#mute');
        button.firstChild.nodeValue = 'Unmute';
        button.title = 'Unmute';
        const label = doc.createElement('p');
        label.textContent = 'Welcome back';
        doc.body.appendChild(label);
        await tick();
        assert.equal(button.textContent, window.i18n.t('Unmute'));
        assert.equal(button.title, window.i18n.t('Unmute'));
        assert.equal(label.textContent, '欢迎回来');
        await window.i18n.setLanguage('en');
        assert.equal(button.textContent, 'Unmute');
        assert.equal(button.title, 'Unmute');
        assert.equal(label.textContent, 'Welcome back');
    });

    it('preserves excluded user content, including nested text and attributes', async () => {
        const { window, doc } = await page({
            html: '<body><div translate="no"><span title="Share">Share</span></div><textarea>Share</textarea><script>Share</script><input placeholder="Username" value="Share"></body>',
        });
        await window.i18n.setLanguage('zh');
        assert.equal(doc.querySelector('span').textContent, 'Share');
        assert.equal(doc.querySelector('span').title, 'Share');
        assert.equal(doc.querySelector('textarea').value, 'Share');
        assert.equal(doc.querySelector('script').textContent, 'Share');
        assert.equal(doc.querySelector('input').value, 'Share');
        assert.equal(doc.querySelector('input').placeholder, '用户名');
    });

    for (const [name, selector, translated] of [
        ['newroom', '#newRoomTitle', '一个链接，'],
        ['login', '#loginHeading', '欢迎回来'],
        ['whoAreYou', '#waitingRoomHeading', '正在等待主持人…'],
        ['customizeRoom', '.cr-title', '打造您的会议空间'],
        ['activeRooms', 'h1', '活动房间'],
        ['Room', '#tabLanguages h3', '语言'],
    ]) {
        it(`applies the saved Chinese choice on ${name}`, async () => {
            const { doc } = await page({ name, saved: 'zh', brand: true });
            assert(doc.querySelector(selector).textContent.includes(translated));
            assert(doc.querySelector('[data-i18n-select] option[value="en"]'));
            assert(doc.querySelector('[data-i18n-select] option[value="zh"]'));
            assert.equal(doc.documentElement.lang, 'zh-CN');
        });
    }

    it('translates a dynamically opened scheduling form without changing input values', async () => {
        const { window, doc } = await page({ name: 'landing', saved: 'zh' });
        const dialog = doc.createElement('div');
        dialog.innerHTML = fs.readFileSync(path.join(publicDir, 'views/scheduleMeeting.html'), 'utf8');
        dialog.querySelector('#schTitle').value = 'Share';
        doc.body.appendChild(dialog);
        await tick();
        assert(dialog.querySelector('label[for="schTitle"]').textContent.includes('会议标题'));
        assert.equal(dialog.querySelector('#schTitle').placeholder, '例如：团队晨会');
        assert.equal(dialog.querySelector('#schTitle').value, 'Share');
        await window.i18n.setLanguage('en');
        assert.equal(dialog.querySelector('#schTitle').placeholder, 'e.g. Team standup');
    });

    it('keeps the entry picker in sync with other languages selected in meeting settings', async () => {
        const { window, doc } = await page();
        await window.i18n.setLanguage('fr');
        assert([...doc.querySelectorAll('[data-i18n-select]')].every((select) => select.value === 'fr'));
    });

    it('updates active-room counts in both languages while preserving room names and search', async () => {
        const { window, doc } = await page({ name: 'activeRooms' });
        window.axios = {
            get: async () => ({ status: 200, data: { activeRooms: [{ id: 'Share', peers: 2, join: '/join/Share' }] } }),
        };
        window.eval(fs.readFileSync(path.join(publicDir, 'js/ActiveRooms.js'), 'utf8'));
        await tick();
        doc.querySelector('#searchInput').value = 'Share';
        await window.i18n.setLanguage('zh');
        await tick();
        assert.equal(doc.querySelector('#roomCountBadge').textContent, '1 个房间');
        assert(doc.querySelector('.peer-status').textContent.includes('2 人已连接'));
        assert.equal(doc.querySelector('.room-title').textContent.trim(), 'Share');
        assert.equal(doc.querySelector('#searchInput').value, 'Share');
        await window.i18n.setLanguage('en');
        assert.equal(doc.querySelector('#roomCountBadge').textContent, '1 room');
        assert(doc.querySelector('.peer-status').textContent.includes('2 peers connected'));
    });
});
