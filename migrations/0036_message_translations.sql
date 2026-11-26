CREATE TABLE message_translations (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  target TEXT NOT NULL CHECK (target IN ('en', 'ja')),
  translation TEXT,
  claim TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, target)
);

CREATE TRIGGER invalidate_message_translations AFTER UPDATE OF body, edited_at, deleted_at ON messages
BEGIN
  DELETE FROM message_translations WHERE message_id = NEW.id;
END;

-- Reserve each inference before the provider call, including failed calls.
CREATE TABLE translation_budget (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  utc_day INTEGER NOT NULL,
  requests INTEGER NOT NULL,
  reserved_units INTEGER NOT NULL
);
