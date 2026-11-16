'use strict';
const crypto = require('node:crypto');

module.exports = function requirePin(req, res, next) {
  const pin = req.headers['x-app-pin'];
  const correctPin = process.env.APP_PIN;
  // Never allow an unset/default PIN to unlock server-side SMTP access.
  if (typeof pin !== 'string' || typeof correctPin !== 'string' || !correctPin) {
    return res.status(401).json({ error: 'Unlock MailFlow with your configured PIN first.' });
  }
  const entered = Buffer.from(pin, 'utf8');
  const expected = Buffer.from(correctPin, 'utf8');
  if (entered.length !== expected.length || !crypto.timingSafeEqual(entered, expected)) {
    return res.status(401).json({ error: 'Invalid PIN.' });
  }
  next();
};
