ALTER TABLE agents ADD COLUMN handle TEXT;
UPDATE agents SET handle = 'agent-' || substr(id, 1, 8) WHERE handle IS NULL;
CREATE UNIQUE INDEX agents_owner_handle_unique ON agents(owner_id, handle) WHERE deleted_at IS NULL;
