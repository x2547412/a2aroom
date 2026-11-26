import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import test from 'node:test';

test('existing rooms, accounts and messages survive image, public-mode, notification and media migrations', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const migrationNames = [
      '0001_initial.sql', '0002_policy_and_rate_limits.sql', '0003_agent_handles.sql',
      '0004_notification_sources.sql', '0005_message_agent_snapshot.sql', '0006_device_login.sql',
      '0007_agent_message_reads.sql', '0008_profile_images.sql', '0009_room_access_and_guests.sql',
      '0010_agent_push.sql', '0011_chat_media.sql', '0012_human_message_reads.sql', '0013_public_directory.sql', '0014_external_login.sql', '0015_reply_status.sql', '0016_agent_reactions.sql', '0017_google_login_confirmation.sql', '0018_agent_membership_events.sql', '0019_membership_event_profiles.sql', '0020_user_display_name.sql', '0021_account_ids.sql', '0022_account_id_changes.sql', '0023_fixed_account_ids.sql', '0024_room_moderation.sql', '0025_reply_mode.sql', '0026_retire_device_login.sql', '0027_google_registration.sql', '0028_user_bio.sql',
    ];
    const migrations = await Promise.all(migrationNames.map((name) => readFile(path.join(process.cwd(), 'migrations', name), 'utf8')));
    for (const migration of migrations.slice(0, 7)) db.exec(migration);
    db.exec(`
      INSERT INTO users (id, account_name, email, password_salt, password_hash, created_at)
        VALUES ('owner', 'owner', 'owner@example.test', 'salt', 'hash', 1);
      INSERT INTO rooms (id, host_user_id, name, visibility, created_at) VALUES
        ('private-room', 'owner', 'private', 'invite', 2), ('public-room', 'owner', 'public', 'public', 3);
      INSERT INTO room_members (id, room_id, user_id, kind, joined_at)
        VALUES ('membership', 'public-room', 'owner', 'human', 4);
      INSERT INTO messages (id, room_id, author_user_id, body, created_at)
        VALUES ('message', 'public-room', 'owner', 'preserved', 5);
    `);
    const eventSchema = migrationNames.indexOf('0018_agent_membership_events.sql');
    for (const migration of migrations.slice(7, eventSchema)) db.exec(migration);
    db.exec(`INSERT INTO agents (id,owner_id,name,platform,handle,created_at) VALUES ('a','owner','Muse','Muse','muse',6);
      INSERT INTO room_members (id,room_id,user_id,agent_id,kind,joined_at) VALUES ('agent-member','public-room','owner','a','agent',7);`);
    db.exec(migrations[eventSchema]);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_membership_events').get()?.count, 0);
    db.exec("DELETE FROM room_members WHERE id='agent-member'");
    assert.deepEqual({ ...db.prepare('SELECT action,agent_name FROM agent_membership_events').get() }, { action: 'left', agent_name: 'Muse' });
    db.exec(`INSERT INTO agents (id,owner_id,name,platform,handle,created_at) VALUES
      ('b','owner','Muse','Other','other',8),('c','owner','Muse','Muse','third',8);
      INSERT INTO room_members (id,room_id,user_id,agent_id,kind,joined_at) VALUES
      ('ma','public-room','owner','a','agent',9),('mb','public-room','owner','b','agent',10),
      ('mc','public-room','owner','c','agent',10);
      UPDATE agents SET name='Renamed' WHERE id='a';`);
    for (const migration of migrations.slice(eventSchema + 1)) db.exec(migration);
    assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name='device_login_requests'").get(), undefined);
    assert.deepEqual(db.prepare('SELECT agent_id FROM agent_membership_events ORDER BY event_order').all().map(e => e.agent_id),
      [null, 'a', null, null]);
    db.exec("DELETE FROM room_members WHERE kind='agent'");
    const departure = db.prepare("SELECT agent_name,agent_handle,agent_platform FROM agent_membership_events WHERE agent_id='a' AND action='left'").get();
    assert.deepEqual({ ...departure }, { agent_name:'Renamed', agent_handle:'muse', agent_platform:'Muse' });
    assert.deepEqual(db.prepare('SELECT id, visibility, access_mode FROM rooms ORDER BY id').all().map((row) => ({ ...row })), [
      { id: 'private-room', visibility: 'invite', access_mode: 'invite' },
      { id: 'public-room', visibility: 'public', access_mode: 'registered' },
    ]);
    assert.deepEqual({ ...db.prepare('SELECT account_name, email, is_guest FROM users WHERE id = ?').get('owner') },
      { account_name: 'owner', email: 'owner@example.test', is_guest: 0 });
    assert.deepEqual({ ...db.prepare('SELECT body, media_label_only, sticker_id FROM messages WHERE id = ?').get('message') },
      { body: 'preserved', media_label_only: 0, sticker_id: null });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM room_members').get()?.count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM rooms WHERE directory_listed=1').get()?.count, 0);
    assert.throws(() => db.exec("UPDATE users SET account_name='new-id' WHERE id='owner'"), /ACCOUNT_ID_FIXED/);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally { db.close(); }
});
