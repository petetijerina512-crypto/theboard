exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: '{}' };
  const token = process.env.TG_TOKEN || '8895293046:AAGk0g8xSHeeXYZonIcsZoVIxTj3Fqjr--E';
  const chats = String(process.env.TG_CHATS || '6361748488,1866313543').split(',').map(s => s.trim()).filter(Boolean);
  const resendKey = process.env.RESEND_KEY;
  const emailTo = process.env.ALERT_EMAIL || 'pete_tijerina@icloud.com';
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) {}
  const msg = String(body.msg || '').slice(0, 500);
  if (!msg) return { statusCode: 200, headers, body: JSON.stringify({ ok: false }) };
  const results = [];
  for (const chat of chats) {
    try {
      const res = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text: msg })
      });
      const j = await res.json();
      results.push({ tg: chat, ok: j.ok });
    } catch (e) { results.push({ tg: chat, ok: false }); }
  }
  if (resendKey && emailTo) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'The Board <alerts@theboard.my>', to: [emailTo], subject: 'Bet', text: msg })
      });
      const j = await res.json();
      results.push({ email: emailTo, ok: res.ok, id: j.id });
      console.log('email', res.status, JSON.stringify(j));
    } catch (e) { results.push({ email: emailTo, ok: false }); }
  }
  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, results }) };
};
