CREATE TABLE agent_membership_events (
  event_order INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('joined', 'left')),
  after_message_seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX agent_membership_timeline ON agent_membership_events(room_id, after_message_seq, event_order);

-- Anchor events to the last committed message, even when several changes share a timestamp.
CREATE TRIGGER record_agent_join AFTER INSERT ON room_members WHEN NEW.kind = 'agent' BEGIN
  INSERT INTO agent_membership_events(room_id, owner_id, agent_name, action, after_message_seq, created_at)
  SELECT NEW.room_id, NEW.user_id, a.name, 'joined',
    COALESCE((SELECT MAX(seq) FROM messages WHERE room_id = NEW.room_id), 0), NEW.joined_at
  FROM agents a WHERE a.id = NEW.agent_id;
END;

CREATE TRIGGER record_agent_leave AFTER DELETE ON room_members WHEN OLD.kind = 'agent' BEGIN
  INSERT INTO agent_membership_events(room_id, owner_id, agent_name, action, after_message_seq, created_at)
  SELECT OLD.room_id, OLD.user_id, a.name, 'left',
    COALESCE((SELECT MAX(seq) FROM messages WHERE room_id = OLD.room_id), 0),
    CAST(unixepoch('subsec') * 1000 AS INTEGER)
  FROM agents a JOIN rooms r ON r.id = OLD.room_id JOIN users u ON u.id = OLD.user_id
  WHERE a.id = OLD.agent_id;
END;
