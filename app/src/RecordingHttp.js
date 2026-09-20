'use strict';

const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { describeViews } = require('./RecordingPlayback');

const COOKIE_NAME = 'mirotalk_recording_admin';
const sessions = new Map();

function parseCookies(header = '') {
    return Object.fromEntries(
        header
            .split(';')
            .map((item) => item.trim().split('='))
            .filter(([key, value]) => key && value)
            .map(([key, ...value]) => [key, decodeURIComponent(value.join('='))])
    );
}

function secureEqual(left, right) {
    const a = Buffer.from(String(left));
    const b = Buffer.from(String(right));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function derivePassword(password, salt) {
    return crypto.scryptSync(String(password), salt, 64).toString('base64');
}

function createAdminAuth(config) {
    const username = String(config.username || 'admin');
    const password = config.password || '';
    const salt = crypto.randomBytes(16).toString('base64');
    const passwordHash = password ? derivePassword(password, salt) : null;
    const secure = String(config.hostUrl || '').startsWith('https://');

    const cleanSessions = () => {
        const now = Date.now();
        for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id);
    };
    setInterval(cleanSessions, 60 * 60 * 1000).unref?.();

    return {
        configured: Boolean(passwordHash),
        login(requestUsername, requestPassword) {
            if (
                !passwordHash ||
                !secureEqual(requestUsername, username) ||
                !secureEqual(derivePassword(requestPassword, salt), passwordHash)
            ) {
                return null;
            }
            const id = crypto.randomBytes(32).toString('base64url');
            const csrf = crypto.randomBytes(24).toString('base64url');
            const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
            sessions.set(id, { csrf, expiresAt });
            return { id, csrf, expiresAt };
        },
        get(req) {
            cleanSessions();
            return sessions.get(parseCookies(req.headers.cookie)[COOKIE_NAME]) || null;
        },
        remove(req) {
            sessions.delete(parseCookies(req.headers.cookie)[COOKIE_NAME]);
        },
        cookie(value, expiresAt) {
            return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; ${secure ? 'Secure; ' : ''}Expires=${new Date(expiresAt).toUTCString()}`;
        },
        clearCookie() {
            return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; ${secure ? 'Secure; ' : ''}Max-Age=0`;
        },
    };
}

function sendRangeFile(req, res, asset) {
    fs.stat(asset.path, (error, stat) => {
        if (error || !stat.isFile()) return res.status(404).json({ error: 'Asset not found' });
        const range = req.headers.range;
        res.set({
            'Content-Type': asset.type,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff',
        });
        if (req.query.download === '1') res.attachment(`meeting-recording${path.extname(asset.path)}`);
        if (!range) {
            res.set('Content-Length', stat.size);
            return fs.createReadStream(asset.path).pipe(res);
        }
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match) return res.status(416).end();
        const suffix = !match[1] && match[2];
        const start = suffix ? Math.max(0, stat.size - Number(match[2])) : Number(match[1] || 0);
        const end = suffix ? stat.size - 1 : Math.min(match[2] ? Number(match[2]) : stat.size - 1, stat.size - 1);
        if (start < 0 || end < start || end >= stat.size)
            return res.status(416).set('Content-Range', `bytes */${stat.size}`).end();
        res.status(206).set({
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Content-Length': end - start + 1,
        });
        fs.createReadStream(asset.path, { start, end }).pipe(res);
    });
}

function publicMeeting(manager, meeting) {
    return {
        id: meeting.id,
        room_id: meeting.room_id,
        started_at: meeting.started_at,
        ended_at: meeting.ended_at,
        state: meeting.state,
        composition_state: meeting.composition_state,
        composition_available: Boolean(meeting.composition_path),
        views: describeViews(meeting),
        tracks: meeting.tracks
            .filter((track) => track.playback_path)
            .map((track) => ({
                id: track.id,
                peer_name: track.peer_name,
                participant_id: crypto
                    .createHash('sha256')
                    .update(track.socket_id || track.id)
                    .digest('hex')
                    .slice(0, 24),
                kind: track.kind,
                media_type: track.media_type,
                started_at: track.started_at,
                ended_at: track.ended_at,
                state: track.state,
            })),
    };
}

function createRecordingRouter({ manager, config, viewsDir }) {
    const router = express.Router();
    const admin = createAdminAuth(config.admin || {});
    const requireAdmin = (req, res, next) => {
        if (!manager.isAvailable()) return res.status(503).json({ error: 'Managed recording is unavailable' });
        const session = admin.get(req);
        if (!session) return res.status(401).json({ error: 'Administrator authentication required' });
        req.recordingAdminSession = session;
        next();
    };
    const requireCsrf = (req, res, next) => {
        if (!secureEqual(req.get('x-csrf-token') || '', req.recordingAdminSession.csrf)) {
            return res.status(403).json({ error: 'Invalid CSRF token' });
        }
        next();
    };
    const shareForRequest = (req) => {
        const share = manager.store?.getShare(req.params.shareId);
        if (
            !share ||
            share.revoked_at ||
            !secureEqual(crypto.createHash('sha256').update(req.params.secret).digest('hex'), share.secret_hash)
        )
            return null;
        return share;
    };

    router.get('/recordings', (req, res) => {
        if (!manager.isAvailable()) return res.status(503).send('Managed recording is unavailable.');
        if (!admin.configured)
            return res.status(503).send('Set MANAGED_RECORDING_ADMIN_PASSWORD before using recordings.');
        return res.sendFile(path.join(viewsDir, 'recordings.html'));
    });
    router.get('/recordings/share/:shareId/:secret', (req, res) => {
        if (!shareForRequest(req)) return res.status(404).send('Recording share not found.');
        res.set('Referrer-Policy', 'no-referrer');
        return res.sendFile(path.join(viewsDir, 'recordingShare.html'));
    });
    router.get('/recordings/:meetingId', (req, res) => {
        if (!manager.isAvailable() || !admin.configured)
            return res.status(503).send('Managed recording is unavailable.');
        return res.sendFile(path.join(viewsDir, 'recordingDetail.html'));
    });

    router.post('/api/admin/recording/session', (req, res) => {
        if (!manager.isAvailable() || !admin.configured)
            return res.status(503).json({ error: 'Managed recording admin is not configured' });
        const session = admin.login(req.body?.username, req.body?.password);
        if (!session) return res.status(401).json({ error: 'Invalid credentials' });
        res.set('Set-Cookie', admin.cookie(session.id, session.expiresAt));
        res.set('Cache-Control', 'no-store').json({ csrfToken: session.csrf, expiresAt: session.expiresAt });
    });
    router.get('/api/admin/recording/session', requireAdmin, (req, res) => {
        res.set('Cache-Control', 'no-store').json({
            csrfToken: req.recordingAdminSession.csrf,
            settings: manager.getSettings(),
        });
    });
    router.delete('/api/admin/recording/session', requireAdmin, requireCsrf, (req, res) => {
        admin.remove(req);
        res.set('Set-Cookie', admin.clearCookie()).status(204).end();
    });
    router.get('/api/admin/recording/settings', requireAdmin, (req, res) => res.json(manager.getSettings()));
    router.patch('/api/admin/recording/settings', requireAdmin, requireCsrf, (req, res) => {
        if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });
        return res.json(manager.setEnabled(req.body.enabled));
    });
    router.get('/api/admin/recordings', requireAdmin, (req, res) => {
        const options = {
            limit: req.query.limit,
            offset: req.query.offset,
            search: req.query.search,
            status: req.query.status,
        };
        res.json({
            meetings: manager.listMeetings(options),
            total: manager.store.countMeetings(options),
            summary: manager.store.meetingSummary(),
        });
    });
    router.get('/api/admin/recordings/:meetingId', requireAdmin, (req, res) => {
        const meeting = manager.getMeeting(req.params.meetingId);
        if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
        return res.json(meeting);
    });
    router.delete('/api/admin/recordings/:meetingId', requireAdmin, requireCsrf, async (req, res) => {
        try {
            if (!(await manager.deleteMeeting(req.params.meetingId)))
                return res.status(404).json({ error: 'Meeting not found' });
            return res.status(204).end();
        } catch (error) {
            return res.status(error.statusCode || 500).json({
                error: error.statusCode ? error.message : '删除录像失败，请稍后重试。',
            });
        }
    });
    router.get('/api/admin/recordings/:meetingId/assets/:assetId', requireAdmin, (req, res) => {
        const asset = manager.getAsset(req.params.meetingId, req.params.assetId);
        if (!asset) return res.status(404).json({ error: 'Asset not found' });
        return sendRangeFile(req, res, asset);
    });
    router.post('/api/admin/recordings/:meetingId/playback/:viewId', requireAdmin, requireCsrf, (req, res) => {
        try {
            const status = manager.preparePlayback(req.params.meetingId, req.params.viewId, {
                retry: req.body?.retry === true,
            });
            res.status(status.state === 'processing' ? 202 : 200).json(status);
        } catch (error) {
            res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : '回放暂时不可用' });
        }
    });
    router.post('/api/admin/recordings/:meetingId/composition', requireAdmin, requireCsrf, async (req, res) => {
        try {
            const meeting = await manager.queueComposition(req.params.meetingId, req.body?.primaryTrackId || null);
            res.status(202).json(meeting);
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });
    router.post('/api/admin/recordings/:meetingId/share', requireAdmin, requireCsrf, (req, res) => {
        if (!manager.getMeeting(req.params.meetingId)) return res.status(404).json({ error: 'Meeting not found' });
        const id = crypto.randomUUID();
        const secret = crypto.randomBytes(32).toString('base64url');
        manager.store.createShare({
            id,
            meetingId: req.params.meetingId,
            secretHash: crypto.createHash('sha256').update(secret).digest('hex'),
            createdAt: Date.now(),
        });
        res.status(201).json({ id, url: `${config.hostUrl}/recordings/share/${id}/${secret}` });
    });
    router.delete('/api/admin/recordings/:meetingId/share/:shareId', requireAdmin, requireCsrf, (req, res) => {
        const share = manager.store.getShare(req.params.shareId);
        if (!share || share.meeting_id !== req.params.meetingId)
            return res.status(404).json({ error: 'Share not found' });
        manager.store.revokeShare(share.id, Date.now());
        res.status(204).end();
    });

    router.get('/api/public/recordings/:shareId/:secret', (req, res) => {
        const share = shareForRequest(req);
        if (!share) return res.status(404).json({ error: 'Recording share not found' });
        const meeting = manager.getMeeting(share.meeting_id);
        if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
        res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).json(
            publicMeeting(manager, meeting)
        );
    });
    router.get('/api/public/recordings/:shareId/:secret/assets/:assetId', (req, res) => {
        const share = shareForRequest(req);
        if (!share) return res.status(404).json({ error: 'Recording share not found' });
        const asset = manager.getAsset(share.meeting_id, req.params.assetId, { publicOnly: true });
        if (!asset || !asset.public) return res.status(404).json({ error: 'Asset not found' });
        res.set('Referrer-Policy', 'no-referrer');
        return sendRangeFile(req, res, asset);
    });
    router.get('/api/public/recordings/:shareId/:secret/playback/:viewId', (req, res) => {
        const share = shareForRequest(req);
        if (!share) return res.status(404).json({ error: 'Recording share not found' });
        try {
            const status = manager.preparePlayback(share.meeting_id, req.params.viewId);
            res.set('Cache-Control', 'no-store')
                .status(status.state === 'processing' ? 202 : 200)
                .json(status);
        } catch (error) {
            res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : '回放暂时不可用' });
        }
    });
    return router;
}

module.exports = { createRecordingRouter, sendRangeFile, publicMeeting, parseCookies };
