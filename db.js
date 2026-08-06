const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  const client = await pool.connect();
  try {
    // Create tables for fresh installs
    await client.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        display_name TEXT,
        access_token TEXT,
        refresh_token TEXT,
        token_expiry BIGINT,
        daily_sent INTEGER DEFAULT 0,
        last_reset TEXT,
        status TEXT DEFAULT 'active',
        created_at TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
      );

      CREATE TABLE IF NOT EXISTS contacts (
        id SERIAL PRIMARY KEY,
        list_name TEXT NOT NULL,
        email TEXT NOT NULL,
        created_at TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
      );

      CREATE TABLE IF NOT EXISTS campaigns (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        subject TEXT NOT NULL,
        body_html TEXT,
        body_plain TEXT,
        contact_list TEXT NOT NULL,
        delay_seconds INTEGER DEFAULT 30,
        start_time TEXT DEFAULT '00:00',
        end_time TEXT DEFAULT '23:59',
        schedule_type TEXT DEFAULT 'immediate',
        content_variations TEXT,
        content_mode TEXT DEFAULT 'random',
        status TEXT DEFAULT 'draft',
        total_contacts INTEGER DEFAULT 0,
        sent_count INTEGER DEFAULT 0,
        failed_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
      );

      CREATE TABLE IF NOT EXISTS templates (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        subject TEXT NOT NULL,
        body_html TEXT,
        body_plain TEXT,
        created_at TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
      );

      CREATE TABLE IF NOT EXISTS queue (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER NOT NULL,
        recipient_email TEXT NOT NULL,
        account_id INTEGER,
        status TEXT DEFAULT 'pending',
        retry_count INTEGER DEFAULT 0,
        last_error TEXT,
        scheduled_at TEXT,
        sent_at TEXT,
        error TEXT,
        message_id TEXT,
        thread_id TEXT
      );

      CREATE TABLE IF NOT EXISTS logs (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER,
        account_id INTEGER,
        recipient_email TEXT,
        status TEXT,
        message TEXT,
        retry_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
      );

      CREATE TABLE IF NOT EXISTS opens (
        id SERIAL PRIMARY KEY,
        queue_id INTEGER,
        campaign_id INTEGER,
        recipient_email TEXT,
        opened_at TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
        ip_address TEXT,
        user_agent TEXT,
        is_bot BOOLEAN DEFAULT FALSE
      );

      CREATE TABLE IF NOT EXISTS clicks (
        id SERIAL PRIMARY KEY,
        queue_id INTEGER,
        campaign_id INTEGER,
        recipient_email TEXT,
        original_url TEXT,
        clicked_at TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
        ip_address TEXT,
        user_agent TEXT
      );

      CREATE TABLE IF NOT EXISTS followups (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        subject TEXT,
        body_html TEXT,
        body_plain TEXT,
        delay_days INTEGER DEFAULT 0,
        delay_hours INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active',
        created_at TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
      );

      CREATE TABLE IF NOT EXISTS followup_queue (
        id SERIAL PRIMARY KEY,
        followup_id INTEGER NOT NULL,
        campaign_id INTEGER NOT NULL,
        recipient_email TEXT NOT NULL,
        account_id INTEGER,
        original_queue_id INTEGER,
        message_id TEXT,
        thread_id TEXT,
        status TEXT DEFAULT 'pending',
        scheduled_at TEXT,
        retry_count INTEGER DEFAULT 0,
        error TEXT,
        sent_at TEXT
      );

      CREATE TABLE IF NOT EXISTS exclusions (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER,
        email TEXT NOT NULL,
        reason TEXT DEFAULT 'replied',
        created_at TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
      );
    `);

    // MIGRATE: Add missing columns to existing tables
    await client.query(`
      ALTER TABLE queue ADD COLUMN IF NOT EXISTS message_id TEXT;
      ALTER TABLE queue ADD COLUMN IF NOT EXISTS thread_id TEXT;
      ALTER TABLE followup_queue ADD COLUMN IF NOT EXISTS thread_id TEXT;
    `);

    // MIGRATE: Add indexes for performance
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_list_email ON contacts(list_name, email);
      CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_queue_campaign_status ON queue(campaign_id, status);
      CREATE INDEX IF NOT EXISTS idx_followup_queue_status ON followup_queue(status, scheduled_at);
    `);

    console.log('Database initialized and migrated successfully');
  } finally {
    client.release();
  }
}

initDB().catch(console.error);

const db = {
  query: (text, params) => pool.query(text, params),

  async get(text, params) {
    const res = await pool.query(text, params);
    return res.rows[0] || null;
  },

  async all(text, params) {
    const res = await pool.query(text, params);
    return res.rows;
  },

  async run(text, params) {
    const res = await pool.query(text, params);
    return res;
  },

  prepare(text) {
    return {
      get: async (...params) => {
        const flatParams = params.flat();
        const res = await pool.query(text, flatParams);
        return res.rows[0] || null;
      },
      all: async (...params) => {
        const flatParams = params.flat();
        const res = await pool.query(text, flatParams);
        return res.rows;
      },
      run: async (...params) => {
        const flatParams = params.flat();
        const res = await pool.query(text, flatParams);
        return res;
      }
    };
  }
};

module.exports = db;
