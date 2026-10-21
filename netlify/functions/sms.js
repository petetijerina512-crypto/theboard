'use strict';
// Sends a Telegram alert. Only a logged-in admin can call this from the browser
// (for example to test alerts). Bet alerts are now sent by the server itself when
// a bet is placed. The bot token and chat ids come only from Netlify environment
// variables: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_IDS (comma separated).
const B = require('./board');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: {}, body: '' };
  if (event.httpMethod !== 'POST') return B.reply(405, { error: 'POST only' });
  try {
    const store = await B.getStore(event);
    const { st } = await B.readState(store);
    const me = B.requireUser(st, event);
    if (!B.isAdmin(me)) throw new B.HttpError(403, 'Admin only.');
    const body = B.parseBody(event);
    const msg = String(body.msg || '').slice(0, 500);
    if (!msg) return B.reply(400, { ok: false, error: 'Empty message' });
    const results = await B.sendAlert(msg);
    return B.reply(200, { ok: true, sent: results.filter(r => r.ok).length });
  } catch (e) { return B.fail(e); }
};
