ALTER TABLE notifications ADD COLUMN source_user_id TEXT REFERENCES users(id);
ALTER TABLE notifications ADD COLUMN source_message_id TEXT REFERENCES messages(id) ON DELETE CASCADE;
ALTER TABLE digest_runs ADD COLUMN period_start INTEGER NOT NULL DEFAULT 0;
ALTER TABLE digest_runs ADD COLUMN period_end INTEGER NOT NULL DEFAULT 0;
