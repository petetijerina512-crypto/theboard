exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: '{}' };
  const key = process.env.RESEND_KEY;
  const targets = String(process.env.ALERT_EMAILS || '5129230217@txt.att.net,5127848085@tmomail.net').split(',').map(s => s.trim()).filter(Boolean);
  console.log('sms called', !!key, targets);
  if (!key) { console.log('no key'); return { statusCode: 200, headers, body: JSON.stringify({ ok: false, reason: 'no key' }) }; }
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) {}
  const msg = String(body.msg || '').slice(0, 300);
  if (!msg) return { statusCode: 200, headers, body: JSON.stringify({ ok: false }) };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'The Board <alerts@theboard.my>', to: targets, subject: 'Bet', text: msg })
    });
    const txt = await res.text();
    console.log('resend', res.status, txt);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: res.ok, status: res.status, detail: txt }) };
  } catch (e) {
    console.log('sms error', String(e));
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false }) };
  }
};
