-- Safe additive migration for existing MailFlow databases.
-- Keeps original OAuth accounts, numeric account IDs, campaigns and follow-ups.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS auth_method TEXT NOT NULL DEFAULT 'oauth';
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS smtp_password_encrypted TEXT;
