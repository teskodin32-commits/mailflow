'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const requirePin = require('./middleware/auth');
const { verifyGmailAccount, sendGmailMail } = require('../lib/gmail-smtp');
const { encryptAppPassword, decryptAppPassword } = require('../lib/smtp-crypto');

const router = express.Router();
router.use(requirePin);
router.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 15, standardHeaders: 'draft-7', legacyHeaders: false }));

function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function handleError(res, error) {
  if (error && ['EAUTH', 'EENVELOPE'].includes(error.code)) {
    return res.status(400).json({ error: 'Gmail rejected the credentials. Check your App Password and try again.' });
  }
  if (error && ['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'ECONNREFUSED'].includes(error.code)) {
    return res.status(503).json({ error: 'Cannot reach Gmail SMTP from this server. Check your hosting provider permits port 465.' });
  }
  console.error('SMTP connection failed:', error?.code || 'unexpected error');
  return res.status(500).json({ error: 'Unable to connect the account. Check your server configuration.' });
}

// Existing OAuth accounts and SMTP accounts share the same numeric account IDs.
router.post('/', async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const appPassword = typeof req.body?.appPassword === 'string' ? req.body.appPassword.replace(/\s/g, '') : '';
  if (!isValidEmail(email) || !/^[a-z0-9]{16}$/i.test(appPassword)) {
    return res.status(400).json({ error: 'Enter your email and 16-character Google App Password.' });
  }

  try {
    const existing = await db.get('SELECT id, auth_method FROM accounts WHERE lower(email) = $1', [email]);
    if (existing && existing.auth_method !== 'smtp') {
      return res.status(409).json({ error: 'This address already uses Google Sign-In. Remove that account first if you want to switch its connection type.' });
    }
    // Verify with Google before storing a secret.
    await verifyGmailAccount({ email, appPassword });
    const encrypted = encryptAppPassword(appPassword);
    const result = existing
      ? await db.run(`
          UPDATE accounts SET smtp_password_encrypted = $1, status = 'active'
          WHERE id = $2 AND auth_method = 'smtp'
          RETURNING id, email, auth_method, status, daily_sent
        `, [encrypted, existing.id])
      : await db.run(`
          INSERT INTO accounts (email, auth_method, smtp_password_encrypted, status)
          VALUES ($1, 'smtp', $2, 'active')
          RETURNING id, email, auth_method, status, daily_sent
        `, [email, encrypted]);
    if (!result.rows.length) return res.status(409).json({ error: 'This address already uses Google Sign-In.' });
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error?.code === '23505') return res.status(409).json({ error: 'Account already connected using another method.' });
    return handleError(res, error);
  }
});

router.post('/:id/verify', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid account ID.' });
  try {
    const account = await db.get("SELECT email, smtp_password_encrypted FROM accounts WHERE id = $1 AND auth_method = 'smtp'", [req.params.id]);
    if (!account) return res.status(404).json({ error: 'SMTP account not found.' });
    await verifyGmailAccount({ email: account.email, appPassword: decryptAppPassword(account.smtp_password_encrypted) });
    await db.run("UPDATE accounts SET status = 'active' WHERE id = $1", [req.params.id]);
    return res.json({ verified: true });
  } catch (error) { return handleError(res, error); }
});

router.post('/:id/test', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid account ID.' });
  try {
    const account = await db.get("SELECT email, smtp_password_encrypted FROM accounts WHERE id = $1 AND auth_method = 'smtp' AND status = 'active'", [req.params.id]);
    if (!account) return res.status(404).json({ error: 'Active SMTP account not found.' });
    await sendGmailMail({
      email: account.email,
      encryptedAppPassword: account.smtp_password_encrypted,
      to: account.email,
      subject: 'MailFlow App Password connection test',
      text: 'Your MailFlow SMTP account can send messages successfully.'
    });
    return res.json({ sent: true });
  } catch (error) { return handleError(res, error); }
});

module.exports = router;
