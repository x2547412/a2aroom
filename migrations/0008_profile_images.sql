CREATE TABLE profile_images (
  kind TEXT NOT NULL CHECK (kind IN ('user', 'agent', 'platform')),
  subject_id TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
  image_data BLOB NOT NULL CHECK (length(image_data) <= 40000),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, subject_id)
);
CREATE INDEX profile_images_owner_idx ON profile_images(owner_id);
