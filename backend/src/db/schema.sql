-- ReachInbox scheduler schema.
-- One table for scheduled/sent emails (status field), not two separate tables,
-- to keep the model simple: "sent emails" is just a filtered view of this table.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  google_id VARCHAR(255) UNIQUE NOT NULL,
  email VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS slack_integrations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  team_name VARCHAR(255),
  access_token TEXT NOT NULL,
  webhook_url TEXT NOT NULL,
  channel VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scheduled_emails (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender VARCHAR(255) NOT NULL,        -- identity used for per-sender hourly rate limit
  recipient VARCHAR(255) NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  scheduled_time TIMESTAMPTZ NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'scheduled', -- scheduled | processing | sent | failed
  job_id VARCHAR(150),
  hourly_limit INTEGER NOT NULL DEFAULT 200,  -- per-batch emails/hour cap chosen in Compose UI, clamped server-side to MAX_EMAILS_PER_HOUR_PER_SENDER
  preview_url TEXT,                    -- Ethereal preview link, set after sending
  error TEXT,
  sent_time TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_emails_status_time
  ON scheduled_emails (status, scheduled_time);

CREATE INDEX IF NOT EXISTS idx_scheduled_emails_user
  ON scheduled_emails (user_id);

-- Safe to re-run: adds the column for databases created before this field
-- existed. No-op if scheduled_emails already has it (e.g. fresh installs
-- that picked it up from the CREATE TABLE above).
ALTER TABLE scheduled_emails ADD COLUMN IF NOT EXISTS hourly_limit INTEGER NOT NULL DEFAULT 200;
