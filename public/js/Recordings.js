'use strict';

(() => {
    const paths = {
        aperture: '<circle cx="12" cy="12" r="9"/><path d="m5 6 7 1 4 6-2 7M12 3l4 6-3 7-8 1M21 12l-6 4-7-3-3-7"/>',
        library: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18M8 4v5M16 4v5m-5 4 4 2-4 2z"/>',
        video: '<rect x="3" y="5" width="12" height="14" rx="3"/><path d="m15 10 6-3v10l-6-3"/>',
        user: '<circle cx="12" cy="8" r="3"/><path d="M5 21v-3a7 7 0 0 1 14 0v3"/>',
        users: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m2-16a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 5v2"/>',
        logout: '<path d="M9 4H4v16h5m-1-8h13m-4-4 4 4-4 4"/>',
        arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
        arrowDown: '<path d="M12 4v16m-6-6 6 6 6-6"/>',
        refresh: '<path d="M20 7v5h-5M4 17v-5h5m-4-4a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3"/>',
        check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
        clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
        search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
        sort: '<path d="M7 4v16m-3-3 3 3 3-3M14 6h7m-7 6h5m-5 6h3"/>',
        chevronLeft: '<path d="m14 6-6 6 6 6"/>',
        chevronRight: '<path d="m10 6 6 6-6 6"/>',
        play: '<path d="m8 5 11 7-11 7z"/>',
        calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-13 4h2m4 0h2"/>',
        trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
        link: '<path d="m10 7 3-3a5 5 0 0 1 7 7l-3 3m-3 3-3 3a5 5 0 0 1-7-7l3-3m2 5 6-6"/>',
        close: '<path d="m6 6 12 12M6 18 18 6"/>',
        headphones:
            '<path d="M3 14v-2a9 9 0 0 1 18 0v2"/><rect x="3" y="12" width="4" height="9" rx="2"/><rect x="17" y="12" width="4" height="9" rx="2"/>',
        film: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 8h4m-4 8h4M17 8h4m-4 8h4"/>',
        layers: '<path d="m12 3 10 6-10 6L2 9zm-9 11 9 5 9-5M3 19l9 5 9-5"/>',
        download: '<path d="M12 3v12m-5-5 5 5 5-5M4 15v6h16v-6"/>',
        mic: '<rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2m-7 9v3m-3 0h6"/>',
        screen: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/>',
    };
    const $ = (id) => document.getElementById(id);
    const icon = (name) =>
        `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.video}</svg>`;
    function hydrate(root = document) {
        root.querySelectorAll('[data-icon]').forEach((el) => {
            el.innerHTML = icon(el.dataset.icon);
        });
    }
    function el(tag, className, text) {
        const item = document.createElement(tag);
        if (className) item.className = className;
        if (text != null) item.textContent = text;
        return item;
    }
    function withIcon(tag, className, name, text = '') {
        const item = el(tag, className);
        item.innerHTML = icon(name);
        if (text) item.append(document.createTextNode(text));
        return item;
    }
    const mode = document.body.dataset.page;
    const shared = mode === 'share';
    const parts = location.pathname.split('/').filter(Boolean);
    const base = shared
        ? `/api/public/recordings/${encodeURIComponent(parts.at(-2))}/${encodeURIComponent(parts.at(-1))}`
        : mode === 'detail'
          ? `/api/admin/recordings/${encodeURIComponent(parts.at(-1))}`
          : null;
    let csrf,
        current,
        selectedId,
        selectedStart = 0,
        activeToken = 0,
        activeAsset,
        pollTimer,
        refreshTimer,
        toastTimer;
    let offset = 0,
        statusFilter = '',
        search = '',
        listToken = 0,
        pageTotal = 0;
    const pageSize = 12;
    const player = $('player');
    hydrate();
    const date = (timestamp) =>
        new Date(timestamp).toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        });
    const duration = (seconds) => {
        const value = Math.max(0, Math.round(seconds || 0));
        return value >= 3600
            ? `${Math.floor(value / 3600)}:${String(Math.floor(value / 60) % 60).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
            : `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
    };
    function meetingSeconds(meeting) {
        if (meeting.tracks.length) {
            const start = Math.min(...meeting.tracks.map((track) => track.started_at));
            const end = Math.max(...meeting.tracks.map((track) => track.ended_at || meeting.ended_at || Date.now()));
            return Math.max(0, (end - start) / 1000);
        }
        return Math.max(0, ((meeting.ended_at || Date.now()) - meeting.started_at) / 1000);
    }
    function people(meeting) {
        return [
            ...new Map(
                meeting.tracks.map((track) => [
                    track.socket_id || track.participant_id || track.peer_name,
                    track.peer_name,
                ])
            ).values(),
        ];
    }
    function stateBadge(meeting) {
        const states = {
            ready: ['已就绪', ''],
            recording: ['录制中', 'processing'],
            finalizing: ['整理中', 'processing'],
            failed: ['需关注', 'failed'],
        };
        const [label, css] = states[meeting.state] || ['待处理', 'processing'];
        return el('span', `status-pill ${css}`, label);
    }
    function toast(message, error = false) {
        clearTimeout(toastTimer);
        $('toast').textContent = message;
        $('toast').className = `toast${error ? ' error' : ''}`;
        $('toast').hidden = false;
        toastTimer = setTimeout(() => {
            $('toast').hidden = true;
        }, 5000);
    }
    async function request(url, options = {}) {
        const headers = { ...(options.headers || {}) };
        if (options.body) headers['Content-Type'] = 'application/json';
        if (csrf && options.method && options.method !== 'GET') headers['X-CSRF-Token'] = csrf;
        const response = await fetch(url, { ...options, headers, cache: 'no-store' });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            const error = new Error(
                response.status === 401 ? '登录已过期，请重新登录。' : data.error || '暂时无法完成操作，请重试。'
            );
            error.status = response.status;
            if (response.status === 401 && csrf && !shared) showLogin();
            throw error;
        }
        return response.status === 204 ? null : response.json();
    }
    function showLogin() {
        clearTimeout(refreshTimer);
        clearTimeout(pollTimer);
        activeToken++;
        player?.pause();
        $('login').hidden = false;
        $('content').hidden = true;
        $('logout').hidden = true;
    }
    async function dialog({ title, text, shareUrl }) {
        const node = $('actionDialog');
        $('dialogTitle').textContent = title;
        $('dialogText').textContent = text;
        $('shareFields').hidden = !shareUrl;
        $('dialogConfirm').hidden = Boolean(shareUrl);
        $('dialogIcon').innerHTML = icon(shareUrl ? 'link' : 'trash');
        if (shareUrl) {
            $('shareUrl').value = shareUrl;
            $('copyShare').textContent = '复制';
        }
        node.showModal();
        return new Promise((resolve) =>
            node.addEventListener('close', () => resolve(node.returnValue === 'confirm'), { once: true })
        );
    }
    $('copyShare').onclick = async () => {
        try {
            await navigator.clipboard.writeText($('shareUrl').value);
            $('copyShare').textContent = '已复制';
            toast('回放链接已复制');
        } catch {
            $('shareUrl').select();
            toast('请复制已选中的链接');
        }
    };
    async function removeMeeting(meeting, button) {
        if (
            !(await dialog({
                title: '删除这场会议录像？',
                text: `「${meeting.room_id}」的全部音视频和合成文件将永久删除，分享链接也会失效。此操作无法撤销。`,
            }))
        )
            return;
        button.disabled = true;
        try {
            await request(`/api/admin/recordings/${encodeURIComponent(meeting.id)}`, { method: 'DELETE' });
            if (mode === 'detail') {
                location.assign('/recordings');
                return;
            }
            toast('录像已删除');
            if ($('meetings').children.length === 1 && offset > 0) offset = Math.max(0, offset - pageSize);
            await loadLibrary();
        } catch (error) {
            toast(error.message, true);
            button.disabled = false;
        }
    }
    function card(meeting) {
        const node = el('article', 'recording-card');
        const href = `/recordings/${encodeURIComponent(meeting.id)}`;
        const preview = el('a', 'card-preview');
        preview.href = href;
        preview.setAttribute('aria-label', `观看 ${meeting.room_id}`);
        preview.append(
            withIcon(
                'span',
                'preview-art',
                meeting.tracks.some((track) => track.kind === 'video') ? 'video' : 'headphones'
            )
        );
        const track = meeting.tracks.find((track) => track.kind === 'video' && track.playback_path);
        if (track) {
            preview.classList.add('has-preview');
            const video = el('video');
            video.muted = true;
            video.playsInline = true;
            video.preload = 'metadata';
            video.tabIndex = -1;
            video.setAttribute('aria-hidden', 'true');
            video.src = `/api/admin/recordings/${encodeURIComponent(meeting.id)}/assets/${encodeURIComponent(track.id)}#t=0.5`;
            video.onerror = () => video.remove();
            preview.append(video);
        }
        preview.append(
            el('span', 'preview-shade'),
            stateBadge(meeting),
            withIcon('span', 'preview-play', 'play'),
            el('span', 'duration-pill', duration(meetingSeconds(meeting)))
        );
        const body = el('div', 'card-body'),
            title = el('a', 'card-title', meeting.room_id);
        title.href = href;
        title.title = meeting.room_id;
        const names = people(meeting),
            peers = el('div', 'card-participants'),
            avatars = el('div', 'avatar-stack');
        names.slice(0, 3).forEach((name) => avatars.append(el('span', 'tiny-avatar', Array.from(name || '?')[0])));
        peers.append(
            avatars,
            el(
                'span',
                'participant-names',
                names.length
                    ? `${names.slice(0, 2).join('、')}${names.length > 2 ? ' 等' : ''} · ${names.length} 人参与`
                    : '暂无参与者'
            )
        );
        const bottom = el('div', 'card-bottom'),
            open = withIcon('a', 'open-recording', 'play', '打开回放');
        open.href = href;
        const remove = withIcon('button', 'card-delete', 'trash', '删除');
        remove.setAttribute('aria-label', `删除 ${meeting.room_id} 的录像`);
        remove.disabled = !meeting.can_delete;
        remove.title = meeting.can_delete ? '删除这场录像' : '录制或处理完成后可删除';
        remove.onclick = () => removeMeeting(meeting, remove);
        bottom.append(open, remove);
        body.append(title, withIcon('div', 'card-date', 'calendar', date(meeting.started_at)), peers, bottom);
        node.append(preview, body);
        return node;
    }
    async function loadLibrary({ skeleton = false } = {}) {
        const token = ++listToken;
        if (skeleton) {
            $('emptyState').hidden = true;
            $('meetings').replaceChildren(...Array.from({ length: 3 }, () => el('div', 'skeleton')));
        }
        $('refresh').disabled = true;
        try {
            const query = new URLSearchParams({ limit: pageSize, offset, search, status: statusFilter });
            const data = await request(`/api/admin/recordings?${query}`);
            if (token !== listToken) return;
            pageTotal = data.total;
            $('totalCount').textContent = data.summary.total;
            $('readyCount').textContent = data.summary.ready;
            $('processingCount').textContent = data.summary.processing;
            $('meetings').replaceChildren(...data.meetings.map(card));
            $('listCaption').textContent = `共 ${data.total} 场会议${search ? ` · 搜索「${search}」` : ''}`;
            $('emptyState').hidden = data.meetings.length > 0;
            $('emptyTitle').textContent = search || statusFilter ? '没有找到符合条件的录像' : '还没有会议录像';
            $('emptyText').textContent =
                search || statusFilter
                    ? '试试其他关键词，或切换到全部录像。'
                    : '开启自动录制后，结束的会议会出现在这里。';
            $('pageInfo').textContent = data.total
                ? `${Math.floor(offset / pageSize) + 1} / ${Math.ceil(data.total / pageSize)}`
                : '';
            $('previousPage').disabled = offset === 0;
            $('nextPage').disabled = offset + pageSize >= data.total;
        } catch (error) {
            if (token !== listToken) return;
            if (skeleton) $('meetings').replaceChildren();
            $('listCaption').textContent = '加载失败，请点击刷新重试';
            toast(error.message, true);
        } finally {
            if (token === listToken) $('refresh').disabled = false;
        }
    }
    function assetUrl(id) {
        return `${base}/assets/${encodeURIComponent(id)}`;
    }
    function overlay(title, text, { loading = false, retry = false } = {}) {
        $('playerOverlay').hidden = false;
        $('playerOverlay').classList.toggle('loading', loading);
        $('overlaySymbol').innerHTML = icon(loading ? 'refresh' : 'video');
        $('overlayTitle').textContent = title;
        $('overlayText').textContent = text;
        $('retryPlayback').hidden = !retry;
    }
    function disableDownload() {
        $('download').removeAttribute('href');
        $('download').classList.add('disabled');
        $('download').setAttribute('aria-disabled', 'true');
    }
    function updateAngles() {
        const views = current.views || [];
        const composition = current.composition_path || current.composition_available;
        const buttons = [];
        if (composition)
            buttons.push(
                angleButton({ id: 'composition', name: '会议总览', kind: 'composition', ready: true, has_audio: true })
            );
        for (const view of views) buttons.push(angleButton(view));
        $('angles').replaceChildren(...buttons);
        if (!buttons.length) $('angles').append(el('p', 'angles-intro', '本场会议尚未生成可观看的内容。'));
        $('angleCount').textContent = buttons.length;
    }
    function angleButton(view) {
        const button = el('button', `angle-button${selectedId === view.id ? ' active' : ''}`);
        button.setAttribute('aria-pressed', String(selectedId === view.id));
        const label = { camera: '摄像头', screen: '屏幕共享', audio: '纯音频', composition: '所有参与者' }[view.kind];
        const avatar =
            view.kind === 'camera'
                ? el('span', 'angle-avatar', Array.from(view.name || '?')[0])
                : withIcon(
                      'span',
                      'angle-avatar',
                      view.kind === 'audio' ? 'headphones' : view.kind === 'screen' ? 'screen' : 'layers'
                  );
        const text = el('span', 'angle-text');
        text.append(
            el('strong', '', view.name),
            withIcon(
                'small',
                '',
                view.has_audio ? 'mic' : 'video',
                `${label} · ${view.ready ? (view.has_audio ? '含声音' : '无音频') : '整理中'}`
            )
        );
        button.append(avatar, text, withIcon('span', 'angle-check', selectedId === view.id ? 'check' : 'chevronRight'));
        button.onclick = () => selectAngle(view.id);
        return button;
    }
    function bindMedia(status, view, token, resumeAt, resumePlaying) {
        if (token !== activeToken) return;
        activeAsset = status.assetId;
        selectedStart = status.started_at || current.started_at;
        if (status.posterAssetId) player.poster = assetUrl(status.posterAssetId);
        else player.removeAttribute('poster');
        player.src = assetUrl(status.assetId);
        player.playbackRate = Number($('playbackRate').value);
        player.onloadedmetadata = () => {
            if (token !== activeToken) return;
            const seek = Math.max(0, (resumeAt - selectedStart) / 1000);
            // A zero-second seek hides the poster before playback and exposes
            // the legitimate black lead-in of a late-starting camera.
            if (seek > 0.02 && Number.isFinite(player.duration) && seek < player.duration) player.currentTime = seek;
            $('playerOverlay').hidden = true;
            if (resumePlaying) player.play().catch(() => toast('点击播放按钮即可开始观看'));
        };
        player.onerror = () => {
            if (token === activeToken) overlay('暂时无法播放', '请重试，或下载回放后在本地观看。', { retry: true });
        };
        $('audioArtwork').hidden = view.kind !== 'audio';
        $('audioAvatar').textContent = Array.from(view.name || '?')[0];
        $('audioName').textContent = view.name;
        $('download').href = `${assetUrl(status.assetId)}?download=1`;
        $('download').setAttribute('download', `${current.room_id}-${view.name}.mp4`);
        $('download').classList.remove('disabled');
        $('download').setAttribute('aria-disabled', 'false');
    }
    async function selectAngle(id, retry = false) {
        const token = ++activeToken;
        clearTimeout(pollTimer);
        const resumeAt = selectedStart + (player.currentTime || 0) * 1000,
            resumePlaying = !player.paused;
        player.pause();
        player.removeAttribute('src');
        player.removeAttribute('poster');
        player.load();
        activeAsset = null;
        selectedId = id;
        updateAngles();
        disableDownload();
        $('audioArtwork').hidden = true;
        const view =
            id === 'composition'
                ? { name: '会议总览', kind: 'composition', ready: true, has_audio: true }
                : current.views.find((item) => item.id === id);
        if (!view) return;
        $('angleTitle').textContent = `${view.name}${view.kind === 'screen' ? ' · 屏幕共享' : ''}`;
        $('syncLabel').textContent =
            view.kind === 'audio' ? '完整音频回放' : view.has_audio ? '画面与声音同步' : '本视角没有录制声音';
        $('viewingNote').textContent =
            view.kind === 'composition'
                ? '会议总览包含各位参与者的画面与混合声音。'
                : `正在观看 ${view.name} 的${view.kind === 'screen' ? '共享屏幕' : view.kind === 'audio' ? '音频' : '摄像头'}。${view.has_audio && view.kind !== 'audio' ? '声音与画面已合并，拖动进度和暂停都会同步生效。' : ''}`;
        if (!view.ready) {
            overlay('录像正在整理中', '音视频准备完成后，这里就可以一起播放。');
            return;
        }
        overlay(
            id === 'composition' ? '正在载入会议总览' : '正在准备同步回放',
            '首次观看需要短暂整理，完成后可以直接回看。',
            { loading: true }
        );
        if (id === 'composition') {
            bindMedia({ assetId: 'composition', started_at: current.started_at }, view, token, resumeAt, resumePlaying);
            return;
        }
        let attempt = 0;
        const poll = async () => {
            try {
                const status = await request(
                    `${base}/playback/${encodeURIComponent(id)}`,
                    shared ? {} : { method: 'POST', body: JSON.stringify({ retry: retry && attempt === 0 }) }
                );
                if (token !== activeToken) return;
                attempt++;
                if (status.state === 'ready') {
                    bindMedia(status, view, token, resumeAt, resumePlaying);
                    return;
                }
                if (status.state === 'failed') {
                    overlay('回放准备失败', status.error || '请稍后重试。', { retry: !shared });
                    return;
                }
                if (attempt > 15)
                    $('overlayText').textContent = '这场会议较长，仍在整理音画。你可以先浏览其他录像，稍后回来观看。';
                pollTimer = setTimeout(poll, Math.min(1500 + attempt * 100, 4000));
            } catch (error) {
                if (token === activeToken) overlay('回放暂时不可用', error.message, { retry: !shared });
            }
        };
        await poll();
    }
    function describeDetail() {
        document.title = `${current.room_id} · 会议回放`;
        $('meetingTitle').textContent = current.room_id;
        const names = people(current);
        $('meetingMeta').replaceChildren(
            stateBadge(current),
            withIcon('span', '', 'calendar', date(current.started_at)),
            withIcon('span', '', 'clock', duration(meetingSeconds(current))),
            withIcon('span', '', 'users', `${names.length} 位参与者`)
        );
        $('aboutDate').textContent = date(current.started_at);
        $('aboutDuration').textContent = duration(meetingSeconds(current));
        $('aboutPeople').textContent = `${names.length} 人`;
        if (!shared) {
            $('deleteMeeting').disabled = !current.can_delete;
            $('deleteMeeting').title = current.can_delete ? '删除本场录像' : '正在录制或处理，完成后可删除';
            $('compose').disabled = !current.can_delete || !current.views.some((view) => view.ready);
            $('composeLabel').textContent =
                current.composition_state === 'running'
                    ? '正在生成…'
                    : current.composition_path
                      ? '重新生成会议总览'
                      : '生成会议总览';
        }
        updateAngles();
    }
    async function loadDetail({ initial = false } = {}) {
        clearTimeout(refreshTimer);
        try {
            const previous = current?.views?.find((view) => view.id === selectedId);
            current = await request(base);
            $('detailError').hidden = true;
            $('detailContent').hidden = false;
            describeDetail();
            if (initial || !selectedId) {
                const first =
                    current.composition_path || current.composition_available
                        ? 'composition'
                        : current.views.find((view) => view.ready)?.id || current.views[0]?.id;
                if (first) await selectAngle(first);
                else overlay('没有可播放的内容', '这场会议尚未保存音视频，或录制未能完成。');
            } else if (previous && !previous.ready && current.views.find((view) => view.id === selectedId)?.ready)
                await selectAngle(selectedId);
            if (shared ? current.views.some((view) => !view.ready) : !current.can_delete)
                refreshTimer = setTimeout(() => loadDetail(), 6000);
        } catch (error) {
            if (initial) {
                $('meetingTitle').textContent = shared ? '此回放链接不可用' : '暂时无法打开这场录像';
                $('detailError').hidden = false;
                $('detailError').textContent =
                    error.status === 404 ? '录像不存在、已被删除，或分享链接已失效。' : error.message;
            } else toast(error.message, true);
        }
    }
    async function boot() {
        try {
            if (!shared) {
                const session = await request('/api/admin/recording/session');
                csrf = session.csrfToken;
                $('login').hidden = true;
                $('logout').hidden = false;
                if (mode === 'library') $('recordingEnabled').checked = session.settings.enabled;
            }
            $('content').hidden = false;
            if (mode === 'library') await loadLibrary({ skeleton: true });
            else {
                if (!shared) $('detailCrumb').hidden = false;
                await loadDetail({ initial: true });
            }
        } catch {
            if (!shared) showLogin();
        }
    }
    if (!shared) {
        $('loginForm').onsubmit = async (event) => {
            event.preventDefault();
            $('loginButton').disabled = true;
            $('loginError').textContent = '';
            try {
                const session = await request('/api/admin/recording/session', {
                    method: 'POST',
                    body: JSON.stringify({ username: $('username').value, password: $('password').value }),
                });
                csrf = session.csrfToken;
                $('password').value = '';
                await boot();
            } catch {
                $('loginError').textContent = '账号或密码不正确，或服务暂时不可用。';
            } finally {
                $('loginButton').disabled = false;
            }
        };
        $('logout').onclick = async () => {
            try {
                await request('/api/admin/recording/session', { method: 'DELETE' });
                csrf = null;
                showLogin();
            } catch (error) {
                toast(error.message, true);
            }
        };
    }
    if (mode === 'library') {
        $('refresh').onclick = () => loadLibrary();
        $('previousPage').onclick = () => {
            offset = Math.max(0, offset - pageSize);
            loadLibrary({ skeleton: true });
        };
        $('nextPage').onclick = () => {
            if (offset + pageSize < pageTotal) {
                offset += pageSize;
                loadLibrary({ skeleton: true });
            }
        };
        document.querySelector('.filter-tabs').addEventListener('keydown', (event) => {
            const tabs = [...document.querySelectorAll('[data-status]')];
            const index = tabs.indexOf(document.activeElement);
            if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const target =
                event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? tabs.length - 1
                      : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
            tabs[target].focus();
            tabs[target].click();
        });
        let searchTimer;
        $('search').oninput = () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                search = $('search').value.trim();
                offset = 0;
                loadLibrary({ skeleton: true });
            }, 250);
        };
        document.querySelectorAll('[data-status]').forEach((button) => {
            button.onclick = () => {
                statusFilter = button.dataset.status;
                offset = 0;
                document.querySelectorAll('[data-status]').forEach((item) => {
                    item.classList.toggle('active', item === button);
                    item.setAttribute('aria-selected', String(item === button));
                });
                loadLibrary({ skeleton: true });
            };
        });
        $('recordingEnabled').onchange = async () => {
            const toggle = $('recordingEnabled');
            toggle.disabled = true;
            try {
                await request('/api/admin/recording/settings', {
                    method: 'PATCH',
                    body: JSON.stringify({ enabled: toggle.checked }),
                });
                toast(toggle.checked ? '新会议将自动录制，已开始的会议不受影响。' : '已关闭新会议自动录制。');
            } catch (error) {
                toggle.checked = !toggle.checked;
                toast(error.message, true);
            } finally {
                toggle.disabled = false;
            }
        };
    } else {
        player.onplay = () => $('playerStage').classList.add('is-playing');
        player.onpause = () => $('playerStage').classList.remove('is-playing');
        $('playbackRate').onchange = () => {
            player.playbackRate = Number($('playbackRate').value);
        };
        $('retryPlayback').onclick = () => selectAngle(selectedId, true);
        if (!shared) {
            $('deleteMeeting').onclick = () => removeMeeting(current, $('deleteMeeting'));
            $('share').onclick = async () => {
                $('share').disabled = true;
                try {
                    const result = await request(`${base}/share`, { method: 'POST', body: '{}' });
                    await dialog({
                        title: '让交流继续发生',
                        text: '将这场会议分享给需要回顾的人。对方打开链接后即可观看同步回放，无需登录。',
                        shareUrl: result.url,
                    });
                } catch (error) {
                    toast(error.message, true);
                } finally {
                    $('share').disabled = false;
                }
            };
            $('compose').onclick = async () => {
                $('compose').disabled = true;
                $('deleteMeeting').disabled = true;
                $('composeLabel').textContent = '正在生成…';
                $('compositionMessage').hidden = false;
                $('compositionMessage').textContent = '正在合成所有参与者的画面和声音，当前回放仍可继续观看。';
                try {
                    await request(`${base}/composition`, { method: 'POST', body: '{}' });
                    toast('会议总览已生成，可在右侧观看视角中选择。');
                    $('compositionMessage').textContent = '会议总览已就绪。';
                    await loadDetail();
                } catch (error) {
                    $('compositionMessage').textContent = error.message;
                    toast(error.message, true);
                    await loadDetail();
                }
            };
        }
    }
    window.addEventListener('pagehide', () => {
        activeToken++;
        clearTimeout(pollTimer);
        clearTimeout(refreshTimer);
        player?.pause();
    });
    window.addEventListener('pageshow', (event) => {
        if (event.persisted) boot();
    });
    boot();
})();
