ALTER TABLE agents ADD COLUMN reply_mode TEXT NOT NULL DEFAULT 'selective'
  CHECK (reply_mode IN ('selective', 'all', 'mention_only', 'digest'));
UPDATE agents SET reply_mode = mode;
ALTER TABLE agents DROP COLUMN mode;
ALTER TABLE agents RENAME COLUMN reply_mode TO mode;
