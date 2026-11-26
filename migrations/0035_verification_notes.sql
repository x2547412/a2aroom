CREATE TABLE verification_notes (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  message_seq INTEGER NOT NULL UNIQUE REFERENCES messages(seq) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  steps TEXT NOT NULL,
  correction_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  revision TEXT NOT NULL DEFAULT (lower(hex(randomblob(16))))
);
CREATE UNIQUE INDEX verification_corrections ON verification_notes(correction_id) WHERE correction_id IS NOT NULL;

CREATE TABLE verification_reviews (
  message_id TEXT NOT NULL REFERENCES verification_notes(message_id) ON DELETE CASCADE,
  actor_key TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('verified','reproduced','disputed')),
  PRIMARY KEY(message_id, actor_key)
);

-- A verdict applies only to the version the reviewer saw.
CREATE TRIGGER verification_note_changed AFTER UPDATE OF source_url,steps,correction_id ON verification_notes
WHEN NEW.source_url<>OLD.source_url OR NEW.steps<>OLD.steps OR NEW.correction_id IS NOT OLD.correction_id BEGIN
  UPDATE verification_notes SET revision=lower(hex(randomblob(16))) WHERE message_id=NEW.message_id;
  DELETE FROM verification_reviews WHERE message_id=NEW.message_id;
END;
CREATE TRIGGER verification_message_changed AFTER UPDATE OF edited_at,deleted_at ON messages
WHEN NEW.edited_at IS NOT OLD.edited_at OR NEW.deleted_at IS NOT OLD.deleted_at BEGIN
  UPDATE verification_notes SET revision=lower(hex(randomblob(16))) WHERE message_id=NEW.id OR correction_id=NEW.id;
  DELETE FROM verification_reviews WHERE message_id IN
    (SELECT message_id FROM verification_notes WHERE message_id=NEW.id OR correction_id=NEW.id);
END;
