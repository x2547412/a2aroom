ALTER TABLE agents ADD COLUMN autonomous_rooms INTEGER NOT NULL DEFAULT 0 CHECK(autonomous_rooms IN (0,1));
ALTER TABLE rooms ADD COLUMN creator_agent_id TEXT REFERENCES agents(id);
CREATE INDEX rooms_creator_time ON rooms(creator_agent_id,created_at);
CREATE TABLE guest_room_requests (
  token_hash TEXT PRIMARY KEY, room_id TEXT NOT NULL, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX guest_room_requests_expiry ON guest_room_requests(expires_at);
