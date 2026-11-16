'use strict';

const nodemailer = require('nodemailer');
const { decryptAppPassword } = require('./smtp-crypto');

function gmailTransport(email, appPassword) {
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new TypeError('A valid Gmail or Google Workspace address is required.');
  }
  if (typeof appPassword !== 'string' || !appPassword.trim()) {
    throw new TypeError('An App Password is required.');
  }
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: email.trim(), pass: appPassword.replace(/\s/g, '') },
    tls: { minVersion: 'TLSv1.2' },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 30000,
  });
}

async function verifyGmailAccount({ email, appPassword }) {
  const transport = gmailTransport(email, appPassword);
  try {
    await transport.verify();
    return true;
  } finally {
    transport.close();
  }
}

async function sendGmailMail({ email, encryptedAppPassword, to, subject, text, html, fromName, inReplyTo }) {
  const appPassword = decryptAppPassword(encryptedAppPassword);
  const transport = gmailTransport(email, appPassword);
  try {
    // Caller must validate recipient consent, authorization, contents and rate limits.
    const info = await transport.sendMail({
      from: fromName ? { name: fromName, address: email.trim() } : email.trim(),
      ...(inReplyTo ? { inReplyTo, references: inReplyTo } : {}),
      to,
      subject,
      text,
      html,
    });
    return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
  } finally {
    transport.close();
  }
}

module.exports = { gmailTransport, verifyGmailAccount, sendGmailMail };
