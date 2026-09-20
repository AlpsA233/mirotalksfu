'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

/**
 * Small persistence boundary for managed recordings.  It deliberately keeps
 * SQLite metadata on the application host; media files may live on a mounted
 * NAS, but SQLite WAL must not be placed on a network filesystem.
 */
class RecordingStore {
    constructor(dbPath) {
        this.dbPath = path.resolve(dbPath);
        fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
        this.db = new DatabaseSync(this.dbPath);
        this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
        this.migrate();
    }

    migrate() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS recording_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            ) STRICT;
            CREATE TABLE IF NOT EXISTS recording_meetings (
                id TEXT PRIMARY KEY,
                room_id TEXT NOT NULL,
                started_at INTEGER NOT NULL,
                ended_at INTEGER,
                state TEXT NOT NULL,
                recording_enabled INTEGER NOT NULL,
                failure_reason TEXT,
                composition_state TEXT NOT NULL DEFAULT 'none',
                composition_path TEXT,
                composition_updated_at INTEGER
            ) STRICT;
            CREATE TABLE IF NOT EXISTS recording_tracks (
                id TEXT PRIMARY KEY,
                meeting_id TEXT NOT NULL REFERENCES recording_meetings(id) ON DELETE CASCADE,
                socket_id TEXT NOT NULL,
                peer_name TEXT NOT NULL,
                kind TEXT NOT NULL,
                media_type TEXT NOT NULL,
                producer_id TEXT NOT NULL,
                codec TEXT,
                resolution TEXT,
                started_at INTEGER NOT NULL,
                ended_at INTEGER,
                state TEXT NOT NULL,
                raw_path TEXT,
                playback_path TEXT,
                duration_ms INTEGER,
                bytes INTEGER,
                checksum TEXT,
                failure_reason TEXT,
                timeline_json TEXT NOT NULL DEFAULT '[]'
            ) STRICT;
            CREATE TABLE IF NOT EXISTS recording_shares (
                id TEXT PRIMARY KEY,
                meeting_id TEXT NOT NULL REFERENCES recording_meetings(id) ON DELETE CASCADE,
                secret_hash TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                revoked_at INTEGER
            ) STRICT;
            CREATE INDEX IF NOT EXISTS recording_meetings_started_at ON recording_meetings(started_at DESC);
            CREATE INDEX IF NOT EXISTS recording_tracks_meeting_id ON recording_tracks(meeting_id);
            CREATE INDEX IF NOT EXISTS recording_shares_meeting_id ON recording_shares(meeting_id);
        `);
        this.ensureColumn('recording_tracks', 'codec', 'TEXT');
        this.ensureColumn('recording_tracks', 'resolution', 'TEXT');
    }

    ensureColumn(table, column, type) {
        const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
        if (!columns.some((item) => item.name === column))
            this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }

    close() {
        this.db.close();
    }

    getSetting(key, fallback = null) {
        const row = this.db.prepare('SELECT value FROM recording_settings WHERE key = ?').get(String(key));
        return row ? JSON.parse(row.value) : fallback;
    }

    setSetting(key, value) {
        this.db
            .prepare(
                'INSERT INTO recording_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
            )
            .run(String(key), JSON.stringify(value));
        return value;
    }

    createMeeting({ id, roomId, startedAt, recordingEnabled }) {
        this.db
            .prepare(
                `INSERT INTO recording_meetings (id, room_id, started_at, state, recording_enabled)
                 VALUES (?, ?, ?, 'recording', ?)
                 ON CONFLICT(id) DO NOTHING`
            )
            .run(id, roomId, startedAt, recordingEnabled ? 1 : 0);
        return this.getMeeting(id);
    }

    updateMeeting(id, changes) {
        const allowed = [
            'ended_at',
            'state',
            'failure_reason',
            'composition_state',
            'composition_path',
            'composition_updated_at',
        ];
        const entries = Object.entries(changes).filter(([key]) => allowed.includes(key));
        if (!entries.length) return this.getMeeting(id);
        const set = entries.map(([key]) => `${key} = ?`).join(', ');
        this.db
            .prepare(`UPDATE recording_meetings SET ${set} WHERE id = ?`)
            .run(...entries.map(([, value]) => value), id);
        return this.getMeeting(id);
    }

    getMeeting(id) {
        return this.db.prepare('SELECT * FROM recording_meetings WHERE id = ?').get(id) || null;
    }

    listMeetings({ limit = 50, offset = 0 } = {}) {
        const meetings = this.db
            .prepare('SELECT * FROM recording_meetings ORDER BY started_at DESC LIMIT ? OFFSET ?')
            .all(Math.min(Math.max(Number(limit) || 50, 1), 200), Math.max(Number(offset) || 0, 0));
        return meetings.map((meeting) => ({ ...meeting, tracks: this.listTracks(meeting.id) }));
    }

    createTrack(track) {
        this.db
            .prepare(
                `INSERT INTO recording_tracks
                 (id, meeting_id, socket_id, peer_name, kind, media_type, producer_id, codec, resolution, started_at, state, timeline_json)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
                track.id,
                track.meetingId,
                track.socketId,
                track.peerName,
                track.kind,
                track.mediaType,
                track.producerId,
                track.codec || null,
                track.resolution || null,
                track.startedAt,
                track.state || 'starting',
                JSON.stringify(track.timeline || [])
            );
        return this.getTrack(track.id);
    }

    updateTrack(id, changes) {
        const allowed = [
            'ended_at',
            'state',
            'raw_path',
            'playback_path',
            'duration_ms',
            'bytes',
            'checksum',
            'failure_reason',
            'timeline_json',
        ];
        const entries = Object.entries(changes).filter(([key]) => allowed.includes(key));
        if (!entries.length) return this.getTrack(id);
        const set = entries.map(([key]) => `${key} = ?`).join(', ');
        this.db
            .prepare(`UPDATE recording_tracks SET ${set} WHERE id = ?`)
            .run(...entries.map(([, value]) => value), id);
        return this.getTrack(id);
    }

    getTrack(id) {
        return this.db.prepare('SELECT * FROM recording_tracks WHERE id = ?').get(id) || null;
    }

    listTracks(meetingId) {
        return this.db
            .prepare('SELECT * FROM recording_tracks WHERE meeting_id = ? ORDER BY started_at ASC')
            .all(meetingId);
    }

    createShare({ id, meetingId, secretHash, createdAt }) {
        this.db
            .prepare('INSERT INTO recording_shares (id, meeting_id, secret_hash, created_at) VALUES (?, ?, ?, ?)')
            .run(id, meetingId, secretHash, createdAt);
        return this.getShare(id);
    }

    getShare(id) {
        return this.db.prepare('SELECT * FROM recording_shares WHERE id = ?').get(id) || null;
    }

    revokeShare(id, revokedAt) {
        this.db.prepare('UPDATE recording_shares SET revoked_at = ? WHERE id = ?').run(revokedAt, id);
        return this.getShare(id);
    }
}

module.exports = RecordingStore;
