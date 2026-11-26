ALTER TABLE agent_membership_events ADD COLUMN agent_id TEXT;
ALTER TABLE agent_membership_events ADD COLUMN agent_handle TEXT;
ALTER TABLE agent_membership_events ADD COLUMN agent_platform TEXT;

-- A surviving membership and its join event share the exact insertion timestamp.
-- Leave ambiguous matches and old departures without an inferred identity.
WITH joins AS (
  SELECT room_id, owner_id, created_at, MIN(event_order) AS event_order
  FROM agent_membership_events WHERE action = 'joined'
  GROUP BY room_id, owner_id, created_at HAVING COUNT(*) = 1
), memberships AS (
  SELECT room_id, user_id, joined_at, MIN(agent_id) AS agent_id
  FROM room_members WHERE kind = 'agent'
  GROUP BY room_id, user_id, joined_at HAVING COUNT(*) = 1
)
UPDATE agent_membership_events AS e SET agent_id = m.agent_id
FROM joins j JOIN memberships m
  ON m.room_id = j.room_id AND m.user_id = j.owner_id AND m.joined_at = j.created_at
WHERE e.event_order = j.event_order;

DROP TRIGGER record_agent_join;
DROP TRIGGER record_agent_leave;

CREATE TRIGGER record_agent_join AFTER INSERT ON room_members WHEN NEW.kind = 'agent' BEGIN
  INSERT INTO agent_membership_events(room_id, owner_id, agent_id, agent_name, agent_handle, agent_platform, action, after_message_seq, created_at)
  SELECT NEW.room_id, NEW.user_id, a.id, a.name, a.handle, a.platform, 'joined',
    COALESCE((SELECT MAX(seq) FROM messages WHERE room_id = NEW.room_id), 0), NEW.joined_at
  FROM agents a WHERE a.id = NEW.agent_id;
END;

CREATE TRIGGER record_agent_leave AFTER DELETE ON room_members WHEN OLD.kind = 'agent' BEGIN
  INSERT INTO agent_membership_events(room_id, owner_id, agent_id, agent_name, agent_handle, agent_platform, action, after_message_seq, created_at)
  SELECT OLD.room_id, OLD.user_id, a.id, a.name, a.handle, a.platform, 'left',
    COALESCE((SELECT MAX(seq) FROM messages WHERE room_id = OLD.room_id), 0),
    CAST(unixepoch('subsec') * 1000 AS INTEGER)
  FROM agents a JOIN rooms r ON r.id = OLD.room_id JOIN users u ON u.id = OLD.user_id
  WHERE a.id = OLD.agent_id;
END;
