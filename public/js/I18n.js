'use strict';

/**
 * MiroTalk SFU - Native translation for the meeting UI and entry pages.
 *
 * When a native language file exists at `public/lang/<lang>.json` for the configured
 * UI language, it is used to translate the in-room UI and the Google Translate widget
 * is skipped (see Translate.js). When no native file exists, the existing runtime
 * machine translation (Google) remains untouched.
 *
 * Namespaces (see public/lang/README.md):
 *   - tooltips : tippy tooltips (setTippy)
 *   - buttons  : text/attributes on <button> elements in the static HTML
 *   - labels   : all other static HTML text and title/placeholder/aria-label attributes
 *   - dialogs  : SweetAlert (Swal.fire) titles, buttons, placeholders and body text
 *   - toasts   : snackbar/toast notifications (RoomClient.userLog)
 *
 * Keys within each namespace are the original English source strings. Missing keys
 * fall back to the original English text (the Google widget is not re-enabled).
 *
 * @link    GitHub: https://github.com/miroslavpejic85/mirotalksfu
 * @license AGPLv3
 */

(function () {
    const LANG_PATH = '/lang/';

    // Flag + native name shown in the in-room Language settings when native mode is active.
    const LANG_DISPLAY = {
        en: { flag: '🇬🇧', name: 'English' },
        hu: { flag: '🇭🇺', name: 'Magyar' },
        es: { flag: '🇪🇸', name: 'Español' },
        fr: { flag: '🇫🇷', name: 'Français' },
        de: { flag: '🇩🇪', name: 'Deutsch' },
        pt: { flag: '🇵🇹', name: 'Português' },
        it: { flag: '🇮🇹', name: 'Italiano' },
        ru: { flag: '🇷🇺', name: 'Русский' },
        zh: { flag: '🇨🇳', name: '中文' },
        ja: { flag: '🇯🇵', name: '日本語' },
        ar: { flag: '🇸🇦', name: 'العربية' },
        hi: { flag: '🇮🇳', name: 'हिन्दी' },
        sr: { flag: '🇷🇸', name: 'Srpski' },
        id: { flag: '🇮🇩', name: 'Bahasa Indonesia' },
        ko: { flag: '🇰🇷', name: '한국어' },
        tr: { flag: '🇹🇷', name: 'Türkçe' },
        nl: { flag: '🇳🇱', name: 'Nederlands' },
    };

    const ATTR_KEYS = ['title', 'placeholder', 'aria-label', 'data-tippy-content'];

    // Elements whose text content must never be translated.
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'TEXTAREA']);

    const state = {
        native: false,
        dict: null,
        lang: 'en',
        mode: 'auto',
        googleActive: false,
    };

    /**
     * Resolve a translation for a given source string within a namespace.
     * Preserves surrounding whitespace of the original string.
     */
    const NS_ORDER = ['tooltips', 'buttons', 'labels', 'dialogs', 'toasts', 'pages'];

    function lookup(key, namespace) {
        const table = state.dict && state.dict[namespace];
        if (table) {
            const value = table[key];
            if (typeof value === 'string' && value.length > 0 && value !== key) return value;
        }
        return null;
    }

    function translate(text, namespace, values) {
        const translated = translateSource(text, namespace);
        if (!values || typeof translated !== 'string') return translated;
        return translated.replace(/\{(\w+)\}/g, (token, key) =>
            Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : token
        );
    }

    function translateSource(text, namespace) {
        if (!state.native || typeof text !== 'string' || text.length === 0) return text;
        const source = text.trim();
        const key = source.replace(/\s+/g, ' ');
        if (key.length === 0) return text;
        // Preferred namespace first (keeps context-specific translations like "Cancel"),
        // then fall back across the others so a string is still translated if it exists elsewhere.
        let value = lookup(key, namespace);
        if (value === null) {
            for (const ns of NS_ORDER) {
                if (ns === namespace) continue;
                value = lookup(key, ns);
                if (value !== null) break;
            }
        }
        return value !== null ? text.replace(source, () => value) : text;
    }

    // Public API used by Translate.js and (optionally) other scripts.
    window.i18n = {
        /**
         * Resolves once the native decision is made.
         * @returns {Promise<boolean>} true if native mode is active.
         */
        ready: null,
        t: translate,
        isNative: () => state.native,
        getLang: () => state.lang,
        setLanguage: applyLanguage,
        setGoogleActive: (active) => (state.googleActive = active),
        googleAllowed: true,
    };

    // ####################################################
    // HOOKS (choke points) - no continuous DOM observer
    // ####################################################

    let hookRetries = 0;

    function wrapTippy() {
        if (typeof window.tippy !== 'function') return false; // not loaded yet, retry
        if (window.tippy.__i18nWrapped) return true;
        const original = window.tippy;
        const wrapped = function (targets, options) {
            let source = null;
            if (options && typeof options.content === 'string') {
                source = options.content;
                options = Object.assign({}, options, { content: translate(options.content, 'tooltips') });
            }
            const inst = original(targets, options);
            // Remember the original content so a live language switch can re-translate the tooltip.
            if (source != null && inst) {
                const list = Array.isArray(inst) ? inst : [inst];
                for (const it of list) if (it) it.__i18nSrc = source;
            }
            return inst;
        };
        // Preserve tippy's static helpers (setDefaultProps, delegate, hideAll, ...).
        Object.assign(wrapped, original);
        wrapped.__i18nWrapped = true;
        window.tippy = wrapped;
        return true;
    }

    function wrapSwal() {
        if (typeof window.Swal === 'undefined' || !window.Swal) return false; // not loaded yet, retry
        if (window.Swal.__i18nWrapped) return true;
        const Swal = window.Swal;
        // Keep the original unbound so `this` is preserved for Swal.mixin(...) subclasses
        // (toasts use Swal.mixin({toast:true,...}).fire(); binding to Swal would drop their params).
        const originalFire = Swal.fire;
        const SCALAR_FIELDS = [
            'title',
            'titleText',
            'text',
            'confirmButtonText',
            'cancelButtonText',
            'denyButtonText',
            'inputPlaceholder',
            'footer',
        ];
        Swal.fire = function (...args) {
            const options = args[0];
            if (options && typeof options === 'object' && !Array.isArray(options)) {
                for (const field of SCALAR_FIELDS) {
                    if (typeof options[field] === 'string') {
                        options[field] = translate(options[field], 'dialogs');
                    }
                }
                // Translate the rendered popup text nodes (covers `html` bodies safely).
                const userDidOpen = options.didOpen;
                options.didOpen = function (popup) {
                    try {
                        translateTree(popup, 'dialogs');
                    } catch (err) {
                        console.warn('i18n Swal didOpen error', err.message);
                    }
                    if (typeof userDidOpen === 'function') userDidOpen(popup);
                };
            }
            return originalFire.apply(this, args);
        };
        Swal.__i18nWrapped = true;
        return true;
    }

    function wrapUserLog() {
        if (typeof window.RoomClient !== 'function' || !window.RoomClient.prototype) return false;
        const proto = window.RoomClient.prototype;
        if (typeof proto.userLog !== 'function' || proto.userLog.__i18nWrapped) return true;
        const original = proto.userLog;
        const wrapped = function (type, message, position, ...rest) {
            const translated = typeof message === 'string' ? translate(message, 'toasts') : message;
            return original.call(this, type, translated, position, ...rest);
        };
        wrapped.__i18nWrapped = true;
        proto.userLog = wrapped;
        return true;
    }

    function installHooks() {
        // Evaluate all so an early-ready hook installs even if another lib is still loading.
        const tippyOk = wrapTippy();
        const swalOk = wrapSwal();
        const userLogOk = wrapUserLog();
        if (!(tippyOk && swalOk && userLogOk) && hookRetries < 50) {
            hookRetries++;
            setTimeout(installHooks, 100);
        }
    }

    // ####################################################
    // STATIC DOM PASS (one-time, structure-preserving)
    // ####################################################

    function namespaceFor(node) {
        const parent = node.parentElement;
        if (!parent) return 'labels';
        if (parent.closest('[data-tippy-root], .tippy-box')) return 'tooltips';
        if (parent.closest('button, [role="button"]')) return 'buttons';
        return 'labels';
    }

    function shouldSkip(element) {
        if (!element) return false;
        if (SKIP_TAGS.has(element.tagName)) return true;
        if (element.closest('.notranslate, [translate="no"], [data-i18n-skip]')) return true;
        return false;
    }

    function translateAttributes(element) {
        const ns = element.closest('[data-tippy-root], .tippy-box')
            ? 'tooltips'
            : element.closest('button, [role="button"]')
              ? 'buttons'
              : 'labels';
        for (const attr of ATTR_KEYS) {
            const current = element.getAttribute(attr);
            if (typeof current !== 'string' || current.trim().length === 0) continue;
            // Keep the original value so switching language can re-translate from English.
            const prop = '__i18nAttr_' + attr;
            const previous = element[prop];
            const source = previous && previous.rendered === current ? previous.source : current;
            const next = translate(source, ns);
            element[prop] = { source, rendered: next };
            if (next !== current) {
                element.setAttribute(attr, next);
            }
        }
    }

    function translateTextNode(node) {
        const parent = node.parentElement;
        if (!parent || shouldSkip(parent)) return;
        if (parent.closest('.notranslate, [translate="no"], [data-i18n-skip]')) return;
        const previous = node.__i18nText;
        const source = previous && previous.rendered === node.nodeValue ? previous.source : node.nodeValue;
        const next = translate(source, namespaceFor(node));
        node.__i18nText = { source, rendered: next };
        if (next !== node.nodeValue) {
            node.nodeValue = next;
        }
    }

    function translateTree(root, forcedNamespace) {
        if (!root) return;
        // Attributes on the root and its descendants.
        const elements = root.nodeType === Node.ELEMENT_NODE ? [root, ...root.querySelectorAll('*')] : [];
        for (const el of elements) {
            if (shouldSkip(el)) continue;
            translateAttributes(el);
        }
        // Text nodes.
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (!node.nodeValue || node.nodeValue.trim().length === 0) return NodeFilter.FILTER_REJECT;
                const parent = node.parentElement;
                if (!parent || shouldSkip(parent)) return NodeFilter.FILTER_REJECT;
                if (parent.closest('.notranslate, [translate="no"], [data-i18n-skip]')) {
                    return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
            },
        });
        const nodes = [];
        let current;
        while ((current = walker.nextNode())) nodes.push(current);
        for (const node of nodes) {
            if (forcedNamespace) {
                const parent = node.parentElement;
                const ns = parent && parent.closest('button, [role="button"]') ? 'buttons' : forcedNamespace;
                const previous = node.__i18nText;
                const source = previous && previous.rendered === node.nodeValue ? previous.source : node.nodeValue;
                const next = translate(source, ns);
                node.__i18nText = { source, rendered: next };
                if (next !== node.nodeValue) {
                    node.nodeValue = next;
                }
            } else {
                translateTextNode(node);
            }
        }
    }

    function applyStatic() {
        translateTree(document.body);
        translateTree(document.querySelector('title'));
        document.documentElement.lang = state.lang === 'zh' ? 'zh-CN' : state.lang;
    }

    // Translate content added after load (device menus, chat list, participant menus, tooltips).
    // Only update changed text and known attributes; preserve elements and event handlers.
    let observer = null;

    function installObserver() {
        if (observer || typeof MutationObserver === 'undefined' || !document.body) return;
        observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.type === 'characterData') translateTextNode(mutation.target);
                if (mutation.type === 'attributes' && !shouldSkip(mutation.target))
                    translateAttributes(mutation.target);
                for (const node of mutation.addedNodes) {
                    try {
                        if (node.nodeType === Node.ELEMENT_NODE) translateTree(node);
                        else if (node.nodeType === Node.TEXT_NODE) translateTextNode(node);
                    } catch (err) {
                        console.warn('i18n observer error', err.message);
                    }
                }
            }
        });
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ATTR_KEYS,
        });
    }

    // Update already-created tippy tooltips to the current language (uses recorded originals).
    function refreshTooltips() {
        const elements = document.querySelectorAll('*');
        for (const el of elements) {
            const inst = el._tippy;
            if (inst && inst.__i18nSrc != null && typeof inst.setContent === 'function') {
                try {
                    inst.setContent(translate(inst.__i18nSrc, 'tooltips'));
                } catch (err) {
                    /* ignore */
                }
            }
        }
    }

    // Live language switch (no reload): load the dict, then re-translate the page from stored originals.
    let languageRequest = 0;
    async function applyLanguage(lang) {
        lang = normalizeLang(lang);
        if (!LANG_DISPLAY[lang]) return false;
        const request = ++languageRequest;
        let dict = null;
        try {
            if (lang !== 'en') {
                const response = await fetch(`${LANG_PATH}${encodeURIComponent(lang)}.json`, { cache: 'no-cache' });
                const data = response.ok ? await response.json() : null;
                if (!data || typeof data !== 'object' || !Object.keys(data).length)
                    throw new Error('Language unavailable');
                dict = data;
            }
        } catch (error) {
            if (request !== languageRequest) return false;
            console.warn(`i18n: cannot load "${lang}"`, error.message);
            updateLanguageControls(true);
            return false;
        }
        if (request !== languageRequest) return false;
        persistLanguage(lang);
        // Remove machine-translated DOM through a reload before using the native dictionary.
        if (state.googleActive) {
            location.reload();
            return true;
        }
        state.lang = lang;
        state.dict = dict;
        state.native = Boolean(dict);
        window.i18n.googleAllowed = false;
        applyStatic();
        refreshTooltips();
        updateLanguageControls();
        document.dispatchEvent(new CustomEvent('i18n:changed', { detail: { lang } }));
        return true;
    }

    const OVERRIDE_KEY = 'uiLanguageOverride';

    function normalizeLang(lang) {
        const code = String(lang || 'en').toLowerCase();
        if (/^zh(?:-|$)/.test(code)) return 'zh';
        return LANG_DISPLAY[code.split('-')[0]] ? code.split('-')[0] : code;
    }

    function persistLanguage(lang) {
        try {
            localStorage.setItem(OVERRIDE_KEY, lang);
            localStorage.removeItem('googleTransLang');
            // Prevent a previous Google selection from translating the native page on reload.
            document.cookie = 'googtrans=; Max-Age=0; path=/';
        } catch (error) {
            console.warn('i18n: cannot persist language choice', error.message);
        }
    }

    function getOverride() {
        try {
            return localStorage.getItem(OVERRIDE_KEY);
        } catch (e) {
            return null;
        }
    }

    function configLang() {
        // BRAND is declared with `let` in Brand.js (global lexical binding, not window.BRAND).
        const brand = typeof BRAND !== 'undefined' && BRAND ? BRAND : window.BRAND || {};
        return normalizeLang(brand.app && brand.app.language);
    }

    // UI_TRANSLATION_MODE (via config.ui.brand.app.translationMode): auto | native | google.
    // A user's native language choice also works on existing installations configured for Google.
    function configMode() {
        const override = getOverride();
        if (override && LANG_DISPLAY[normalizeLang(override)]) return 'native';
        const brand = typeof BRAND !== 'undefined' && BRAND ? BRAND : window.BRAND || {};
        const m = brand.app && brand.app.translationMode;
        return m === 'native' || m === 'auto' || m === 'google' ? m : 'auto';
    }

    // Per-browser override (set via the in-room picker) wins over the server UI_LANGUAGE.
    function resolveLang() {
        const override = getOverride();
        if (override && LANG_DISPLAY[normalizeLang(override)]) return normalizeLang(override);
        return configLang();
    }

    function updateLanguageControls(failed = false) {
        document.querySelectorAll('[data-i18n-select]').forEach((select) => {
            if (![...select.options].some((option) => option.value === state.lang)) {
                const info = LANG_DISPLAY[state.lang];
                const option = document.createElement('option');
                option.value = state.lang;
                option.textContent = info ? `${info.flag} ${info.name}` : state.lang;
                select.appendChild(option);
            }
            select.value = state.lang;
        });
        document.querySelectorAll('[data-i18n-error]').forEach((message) => {
            message.textContent = failed ? '语言加载失败，请重试 / Unable to load language. Please try again.' : '';
        });
    }

    // In-room language picker (human-translated languages + English). Switches live without reload.
    function renderLanguageSelect(current) {
        const containers = document.querySelectorAll('#tabLanguages, [data-language-picker]');
        containers.forEach((container, index) => renderPicker(container, current, index));
    }

    function renderPicker(container, current, index) {
        if (container.querySelector('[data-i18n-select]')) return;
        const select = document.createElement('select');
        select.id = container.id === 'tabLanguages' ? 'i18nLanguageSelect' : `pageLanguageSelect${index}`;
        select.dataset.i18nSelect = '';
        select.className = 'language-select notranslate';
        select.setAttribute('aria-label', 'Language / 语言');
        const pagePicker = container.hasAttribute('data-language-picker');

        let matched = false;
        for (const code of Object.keys(LANG_DISPLAY)) {
            if (pagePicker && code !== 'en' && code !== 'zh' && code !== current) continue;
            const info = LANG_DISPLAY[code];
            const opt = document.createElement('option');
            opt.value = code;
            opt.textContent = `${info.flag} ${info.name}`;
            if (code === current) {
                opt.selected = true;
                matched = true;
            }
            select.appendChild(opt);
        }
        // Reflect a machine-translated (non-native) language if that is the current one.
        if (!matched) {
            const opt = document.createElement('option');
            opt.value = current;
            opt.textContent = `🌐 ${current}`;
            opt.selected = true;
            select.appendChild(opt);
        }
        // Always offer the server default language so a saved override can be reset back to it.
        const cfg = configLang();
        if (cfg !== 'en' && !LANG_DISPLAY[cfg] && cfg !== current) {
            const opt = document.createElement('option');
            opt.value = cfg;
            opt.textContent = `🌐 ${cfg}`;
            select.appendChild(opt);
        }

        select.addEventListener('change', () => {
            const chosen = select.value;
            // Machine-translated (non-native) languages need a page load for Google; native/English switch live.
            const needsGoogle = chosen !== 'en' && !LANG_DISPLAY[chosen];
            if (needsGoogle) {
                persistLanguage(chosen);
                location.reload();
                return;
            }
            applyLanguage(chosen);
        });

        // Place the select right under the "Language:" title (avoids the empty <br> gap below it).
        const title = container.querySelector('.title');
        if (title) title.insertAdjacentElement('afterend', select);
        else container.appendChild(select);
        const error = document.createElement('span');
        error.dataset.i18nError = '';
        error.className = 'language-error notranslate';
        error.setAttribute('role', 'status');
        container.appendChild(error);
    }

    // In 'google' mode the Google combo is the switcher, so reveal it in the Language tab
    // (Translate.css hides #google_translate_element by default).
    function revealGoogleWidget() {
        const el = document.getElementById('google_translate_element');
        if (el) el.style.setProperty('display', 'block', 'important');
    }

    // ####################################################
    // INIT
    // ####################################################

    function whenBrandReady() {
        return window.brandReady || Promise.resolve();
    }

    function whenDomReady() {
        return new Promise((resolve) => {
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
            } else {
                resolve();
            }
        });
    }

    window.i18n.ready = (async function init() {
        await whenBrandReady();

        const mode = configMode();
        state.mode = mode;
        const lang = resolveLang();
        state.lang = lang;

        // 'google' forces machine translation; 'auto'/'native' try the human file first.
        if (mode !== 'google' && lang !== 'en') {
            try {
                const response = await fetch(`${LANG_PATH}${encodeURIComponent(lang)}.json`, { cache: 'no-cache' });
                if (response.ok) {
                    const data = await response.json();
                    if (data && typeof data === 'object' && Object.keys(data).length > 0) {
                        state.dict = data;
                        state.native = true;
                    }
                }
            } catch (error) {
                console.warn(`i18n: no native language file for "${lang}"`, error.message);
            }
        }

        // Whether Translate.js may load the Google widget.
        // English needs no translation, so 'auto' only uses Google for a non-English language
        // that has no native file.
        const googleAllowed = mode === 'google' ? true : mode === 'native' ? false : lang !== 'en' && !state.native;
        window.i18n.googleAllowed = googleAllowed;
        state.googleActive = googleAllowed && lang !== 'en' && !state.native;

        if (state.native) console.log(`i18n: native translation active for "${lang}" (mode: ${mode})`);

        await whenDomReady();

        installHooks();
        applyStatic();
        renderLanguageSelect(lang);
        installObserver();
        if (googleAllowed) revealGoogleWidget();
        document.dispatchEvent(new CustomEvent('i18n:changed', { detail: { lang: state.lang } }));

        return state.native;
    })();
})();
