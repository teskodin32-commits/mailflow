const cron = require('node-cron');
const db = require('./db');
const { google } = require('googleapis');

const MAX_RETRIES = 3;
const lastSentTime = {};
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://mailflow-ndex.onrender.com';

async function getAuthForAccount(account) {
  const accountClient = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  accountClient.setCredentials({
    access_token: account.access_token,
    refresh_token: account.refresh_token,
    expiry_date: account.token_expiry
  });

  if (Date.now() > account.token_expiry) {
    try {
      const { credentials } = await accountClient.refreshAccessToken();
      await db.run(
        'UPDATE accounts SET access_token = $1, token_expiry = $2 WHERE id = $3',
        [credentials.access_token, credentials.expiry_date, account.id]
      );
      accountClient.setCredentials(credentials);
    } catch (refreshErr) {
      console.error(`Token refresh failed for ${account.email || account.id}:`, refreshErr.message);
      await db.run("UPDATE accounts SET status = 'error' WHERE id = $1", [account.id]);
      throw refreshErr;
    }
  }

  return accountClient;
}

function trackingPixel(queueId) {
  return `<img src="${RENDER_URL}/api/track/open?id=${queueId}" width="1" height="1" alt="" />`;
}

function plainTextToHtml(text, queueId) {
  if (!text) return trackingPixel(queueId);
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
  return `<p>${escaped}</p>\n${trackingPixel(queueId)}`;
}

function injectTracking(html, queueId) {
  if (!html) return trackingPixel(queueId);
  const trackedHtml = html.replace(
    /href="(https?:\/\/[^"]+)"/g,
    (match, url) => {
      if (url.includes('/track/') || url.includes('unsubscribe')) return match;
      const encodedUrl = encodeURIComponent(url);
      return `href="${RENDER_URL}/api/track/click?id=${queueId}&url=${encodedUrl}"`;
    }
  );
  return `${trackedHtml}\n${trackingPixel(queueId)}`;
}

function makeEmail(to, fromName, fromEmail, subject, bodyHtml, bodyPlain, queueId) {
  const boundary = 'mailflow_boundary';
  const fromField = fromName ? `${fromName} <${fromEmail}>` : fromEmail;

  const hasHtml = bodyHtml && bodyHtml.trim();
  const hasPlain = bodyPlain && bodyPlain.trim();

  let finalHtml;
  let finalPlain;

  if (hasHtml) {
    finalHtml = injectTracking(bodyHtml, queueId);
    finalPlain = bodyPlain || '';
  } else if (hasPlain) {
    finalHtml = plainTextToHtml(bodyPlain, queueId);
    finalPlain = bodyPlain;
  } else {
    finalHtml = trackingPixel(queueId);
    finalPlain = '';
  }

  const finalSubject = subject && subject.trim() ? subject : '(no subject)';

  const headers = [
    `To: ${to}`,
    `From: ${fromField}`,
    `Subject: ${finalSubject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`
  ];

  const message = [
    ...headers,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    finalPlain,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    '',
    finalHtml,
    '',
    `--${boundary}--`
  ].join('\n');

  return Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function pickRandomContent(campaign) {
  try {
    if (campaign.content_variations) {
      const variations = JSON.parse(campaign.content_variations);
      if (Array.isArray(variations) && variations.length > 1) {
        const pick = variations[Math.floor(Math.random() * variations.length)];
        console.log(`Picked variation: ${pick.subject || '(no subject)'}`);
        return { subject: pick.subject || '', body_html: pick.body_html || '', body_plain: pick.body_plain || '' };
      }
      if (Array.isArray(variations) && variations.length === 1) {
        return { subject: variations[0].subject || '', body_html: variations[0].body_html || '', body_plain: variations[0].body_plain || '' };
      }
    }
  } catch (e) {
    console.error('Error parsing content variations:', e.message);
  }
  return { subject: campaign.subject || '', body_html: campaign.body_html || '', body_plain: campaign.body_plain || '' };
}

async function pickDifferentAccount(currentAccountId) {
  const accounts = await db.all(
    "SELECT * FROM accounts WHERE status = 'active' AND id != $1",
    [currentAccountId]
  );
  if (accounts.length === 0) {
    return await db.get("SELECT * FROM accounts WHERE status = 'active' LIMIT 1");
  }
  return accounts[Math.floor(Math.random() * accounts.length)];
}

function isWithinWindow(startTime, endTime) {
  const now = new Date();
  const current = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  return current >= (sh * 60 + sm) && current <= (eh * 60 + em);
}

async function processCampaign(campaign) {
  if (campaign.schedule_type === 'window') {
    if (!isWithinWindow(campaign.start_time, campaign.end_time)) return;
  }

  const now = Date.now();
  const last = lastSentTime[campaign.id] || 0;
  const delayMs = campaign.delay_seconds * 1000;
  if (now - last < delayMs) return;

  const queueItem = await db.get(`
    SELECT q.*,
      a.email as account_email,
      a.display_name as account_display_name,
      a.access_token, a.refresh_token, a.token_expiry,
      a.id as acc_id
    FROM queue q
    JOIN accounts a ON q.account_id = a.id
    WHERE q.campaign_id = $1 AND q.status = 'pending' AND a.status = 'active'
    ORDER BY q.id ASC LIMIT 1
  `, [campaign.id]);

  if (!queueItem) {
    const anyPending = await db.get(
      "SELECT COUNT(*) as count FROM queue WHERE campaign_id = $1 AND status = 'pending'",
      [campaign.id]
    );
    if (parseInt(anyPending.count) === 0) {
      await db.run("UPDATE campaigns SET status = 'completed' WHERE id = $1", [campaign.id]);
      console.log(`Campaign "${campaign.name}" completed!`);
    }
    return;
  }

  lastSentTime[campaign.id] = now;
  const content = pickRandomContent(campaign);

  try {
    console.log(`[${new Date().toISOString()}] Sending to ${queueItem.recipient_email} via ${queueItem.account_email}`);

    const auth = await getAuthForAccount({
      id: queueItem.acc_id,
      access_token: queueItem.access_token,
      refresh_token: queueItem.refresh_token,
      token_expiry: queueItem.token_expiry
    });

    const gmail = google.gmail({ version: 'v1', auth });
    const raw = makeEmail(
      queueItem.recipient_email,
      queueItem.account_display_name,
      queueItem.account_email,
      content.subject,
      content.body_html,
      content.body_plain,
      queueItem.id
    );

    const response = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });

    const messageId = response.data.id;
    const threadId = response.data.threadId;

    await db.run(
      "UPDATE queue SET status = 'sent', sent_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), message_id = $1, thread_id = $2 WHERE id = $3",
      [messageId, threadId, queueItem.id]
    );
    await db.run('UPDATE campaigns SET sent_count = sent_count + 1 WHERE id = $1', [campaign.id]);
    await db.run('UPDATE accounts SET daily_sent = daily_sent + 1 WHERE id = $1', [queueItem.acc_id]);
    await db.run(
      "INSERT INTO logs (campaign_id, account_id, recipient_email, status, message, retry_count) VALUES ($1, $2, $3, 'sent', $4, $5)",
      [campaign.id, queueItem.acc_id, queueItem.recipient_email, `Sent: ${content.subject || '(no subject)'}`, queueItem.retry_count || 0]
    );

    try {
      const followups = await db.all(
        "SELECT * FROM followups WHERE campaign_id = $1 AND status = 'active'",
        [campaign.id]
      );

      for (const followup of followups) {
        const excluded = await db.get(
          'SELECT id FROM exclusions WHERE email = $1 AND (campaign_id = $2 OR campaign_id IS NULL)',
          [queueItem.recipient_email, campaign.id]
        );

        if (!excluded) {
          const sentAt = new Date();
          const scheduledAt = new Date(sentAt.getTime() + (followup.delay_days * 24 * 60 * 60 * 1000) + (followup.delay_hours * 60 * 60 * 1000));

          await db.run(`
            INSERT INTO followup_queue
            (followup_id, campaign_id, recipient_email, account_id, original_queue_id, message_id, thread_id, status, scheduled_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
          `, [followup.id, campaign.id, queueItem.recipient_email, queueItem.acc_id, queueItem.id, messageId, threadId, scheduledAt.toISOString()]);
        }
      }
    } catch (followupErr) {
      console.error('Followup queue build error:', followupErr.message);
    }

    console.log(`✓ Sent to ${queueItem.recipient_email}`);

  } catch (err) {
    console.error(`✗ Failed: ${queueItem.recipient_email}: ${err.message}`);
    const retryCount = (queueItem.retry_count || 0) + 1;

    if (retryCount < MAX_RETRIES) {
      const newAccount = await pickDifferentAccount(queueItem.acc_id);
      const newAccountId = newAccount ? newAccount.id : queueItem.acc_id;
      await db.run(
        "UPDATE queue SET retry_count = $1, last_error = $2, account_id = $3, status = 'pending' WHERE id = $4",
        [retryCount, err.message, newAccountId, queueItem.id]
      );
      await db.run(
        "INSERT INTO logs (campaign_id, account_id, recipient_email, status, message, retry_count) VALUES ($
