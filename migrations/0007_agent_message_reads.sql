CREATE TABLE agent_message_reads (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, agent_id)
);
CREATE INDEX agent_message_reads_agent_idx ON agent_message_reads(agent_id);
