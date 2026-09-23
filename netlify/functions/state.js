exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const empty = { users: [], bets: {}, balances: {}, settings: null, updatedAt: 0 };

  try {
    const mod = await import('@netlify/blobs');
   const store = mod.getStore({
  name: 'board-state',
  siteID: process.env.NETLIFY_SITE_ID,
  token: process.env.NETLIFY_AUTH_TOKEN
});

    if (event.httpMethod === 'GET') {
      const raw = await store.get('state', { type: 'json' });
      return { statusCode: 200, headers, body: JSON.stringify(raw || empty) };
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      body.updatedAt = Date.now();
      await store.setJSON('state', body);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, updatedAt: body.updatedAt }) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'method' }) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify(Object.assign({}, empty, { error: String(e.message || e) })) };
  }
};
