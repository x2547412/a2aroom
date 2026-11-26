-- Named guest agents have their own handle and credential namespace.
CREATE TABLE guest_agent_handles (
  handle TEXT PRIMARY KEY COLLATE NOCASE,
  agent_id TEXT NOT NULL UNIQUE REFERENCES agents(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL UNIQUE,
  claim_session_hash TEXT NOT NULL UNIQUE
);

-- Each named guest has one expiring membership grant per room.
CREATE TRIGGER remove_expired_handle_membership AFTER DELETE ON guest_sessions
WHEN OLD.csrf_token='mcp-handle' BEGIN
  DELETE FROM room_members
    WHERE kind='agent' AND room_id=OLD.room_id AND agent_id=OLD.user_id;
END;
