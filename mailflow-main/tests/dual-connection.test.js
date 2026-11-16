'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const crypto = require('node:crypto');

process.env.SMTP_CREDENTIALS_KEY = crypto.randomBytes(32).toString('hex');
process.env.APP_PIN = '9384';

const { encryptAppPassword, decryptAppPassword } = require('../lib/smtp-crypto');
const requirePin = require('../routes/middleware/auth');

// Inject a fake SMTP transport: tests never connect to Gmail or send emails.
const smtpCalls = [];
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'nodemailer') {
    return { createTransport: options => ({
      async verify() { smtpCalls.push({ type: 'verify', options }); return true; },
      async sendMail(message) { smtpCalls.push({ type: 'send', options, message }); return { messageId: '<test@example.com>', accepted: [message.to], rejected: [] }; },
      close() { smtpCalls.push({ type: 'close' }); },
    }) };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { verifyGmailAccount, sendGmailMail } = require('../lib/gmail-smtp');
Module._load = originalLoad;

test('encrypts the App Password, decrypts only with the correct key', () => {
  const stored = encryptAppPassword('abcdefghijklmnop');
  assert.ok(stored.startsWith('v1:'));
  assert.ok(!stored.includes('abcdefghijklmnop'));
  assert.equal(decryptAppPassword(stored), 'abcdefghijklmnop');
  const old = process.env.SMTP_CREDENTIALS_KEY;
  process.env.SMTP_CREDENTIALS_KEY = crypto.randomBytes(32).toString('hex');
  assert.throws(() => decryptAppPassword(stored));
  process.env.SMTP_CREDENTIALS_KEY = old;
  assert.throws(() => decryptAppPassword(stored.slice(0,-3)+'AAA'));
});

test('SMTP verification checks Gmail over TLS 465 without sending a message', async () => {
  smtpCalls.length=0;
  await verifyGmailAccount({ email: 'owner@gmail.com', appPassword: 'abcd efgh ijkl mnop' });
  assert.equal(smtpCalls[0].type, 'verify');
  assert.equal(smtpCalls[0].options.port, 465);
  assert.equal(smtpCalls[0].options.secure, true);
  assert.equal(smtpCalls[0].options.auth.pass, 'abcdefghijklmnop');
  assert.equal(smtpCalls.at(-1).type, 'close');
});

test('SMTP sending uses decrypted secret, preserves display name and reply headers', async () => {
  smtpCalls.length=0;
  const result=await sendGmailMail({
    email:'owner@gmail.com', encryptedAppPassword:encryptAppPassword('abcdefghijklmnop'),
    fromName:'MailFlow Team', to:'owner@gmail.com', subject:'Test',
    text:'Plain', html:'<p>Plain</p>', inReplyTo:'<original@example.com>'
  });
  assert.equal(result.messageId, '<test@example.com>');
  assert.deepEqual(smtpCalls[0].message.from,{name:'MailFlow Team',address:'owner@gmail.com'});
  assert.equal(smtpCalls[0].message.inReplyTo,'<original@example.com>');
  assert.equal(smtpCalls[0].options.auth.pass,'abcdefghijklmnop');
});

test('server-side PIN denies missing/wrong PIN and accepts configured PIN', () => {
  const makeRes=()=>({statusCode:200, status(n){this.statusCode=n;return this}, json(body){this.body=body;return this}});
  for(const pin of [undefined,'1234','9381']){
    let allowed=false;
    const res=makeRes();requirePin({headers:{'x-app-pin':pin}},res,()=>{allowed=true});
    assert.equal(allowed,false);assert.equal(res.statusCode,401);
  }
  let allowed=false;
  requirePin({headers:{'x-app-pin':'9384'}},makeRes(),()=>{allowed=true});
  assert.equal(allowed,true);
});

test('SMTP account route refuses to overwrite existing Google OAuth accounts', async () => {
  const routes = {};
  const fakeRouter = {
    use() {},
    post(path, handler) { routes[path] = handler; },
  };
  const dbMock = { get: async () => ({ id: 7, auth_method: 'oauth' }), run: async () => { throw new Error('Must not update existing OAuth account'); } };
  const original = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'express') return { Router: () => fakeRouter };
    if (request === 'express-rate-limit') return () => () => {};
    if (request === '../db' && parent?.filename.endsWith('routes/smtp-accounts.js')) return dbMock;
    if (request === '../lib/gmail-smtp' && parent?.filename.endsWith('routes/smtp-accounts.js')) {
      return { verifyGmailAccount: async () => { throw new Error('Do not verify when email is already connected via OAuth'); }, sendGmailMail: async () => {} };
    }
    return original.call(this, request, parent, isMain);
  };
  try {
    const routerPath = require.resolve('../routes/smtp-accounts');
    delete require.cache[routerPath];
    require(routerPath);
    const req = { body: { email: 'owner@gmail.com', appPassword: 'abcdefghijklmnop' } };
    const res = { statusCode: 200, status(n) { this.statusCode=n; return this; }, json(body) { this.body=body; return this; } };
    await routes['/'](req, res);
    assert.equal(res.statusCode, 409);
    assert.match(res.body.error, /Google Sign-In/);
    delete require.cache[routerPath];
  } finally { Module._load = original; }
});
