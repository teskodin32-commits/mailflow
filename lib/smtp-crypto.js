'use strict';

const crypto = require('node:crypto');

function getEncryptionKey() {
  const hex = process.env.SMTP_CREDENTIALS_KEY;
  if (typeof hex !== 'string' || !/^[a-fA-F0-9]{64}$/.test(hex)) {
    throw new Error('SMTP_CREDENTIALS_KEY must be 64 hexadecimal characters (32 bytes).');
  }
  return Buffer.from(hex, 'hex');
}

// AES-256-GCM authenticated encryption. Never send encrypted values to the frontend.
function encryptAppPassword(appPassword) {
  if (typeof appPassword !== 'string' || !appPassword.trim()) {
    throw new TypeError('App Password is required.');
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(appPassword.trim(), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

function decryptAppPassword(value) {
  if (typeof value !== 'string') {
    throw new Error('Invalid encrypted credential.');
  }
  const parts = value.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Unsupported encrypted credential format.');
  }
  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const data = Buffer.from(parts[3], 'base64');
  if (iv.length !== 12 || tag.length !== 16 || data.length === 0) {
    throw new Error('Malformed encrypted credential.');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

module.exports = { encryptAppPassword, decryptAppPassword };
