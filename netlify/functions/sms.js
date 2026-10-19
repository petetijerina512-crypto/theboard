exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: '{}' };
  const token = process.env.TG_TOKEN || '8895293046:AAGfEtjw36XkRv03-l-7BV_uMqZVVj3xjao';
  const chats = String(process.env.TG_CHATS || '6361748488').split(',').map(s => s.trim()).filter(Boolean);
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) {}
  const msg = String(body.msg || '').slice(0, 300);
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
      results.push({ chat, ok: j.ok });
      console.log('tg', chat, j.ok);
    } catch (e) { results.push({ chat, ok: false }); }
  }
  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, results }) };
};
