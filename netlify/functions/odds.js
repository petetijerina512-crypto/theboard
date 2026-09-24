const { buildOdds } = require('./odds-lib');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'public, max-age=20'
};

async function getStoreSafe() {
  try {
    const mod = await import('@netlify/blobs');
    return mod.getStore({
      name: 'board-state',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_AUTH_TOKEN
    });
  } catch (e) {
    return null;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  const store = await getStoreSafe();
  const force = ((event.queryStringParameters || {}).refresh === '1');
  try {
    if (!force && store) {
      const cached = await store.get('odds', { type: 'json' });
      if (cached && cached.games && cached.updatedAt && Date.now() - cached.updatedAt < 120000) {
        return { statusCode: 200, headers, body: JSON.stringify(cached) };
      }
    }
    const payload = await buildOdds();
    if (store) {
      try { await store.setJSON('odds', payload); } catch (e) {}
    }
    return { statusCode: 200, headers, body: JSON.stringify(payload) };
  } catch (e) {
    if (store) {
      try {
        const cached = await store.get('odds', { type: 'json' });
        if (cached) return { statusCode: 200, headers, body: JSON.stringify(cached) };
      } catch (e2) {}
    }
    return { statusCode: 200, headers, body: JSON.stringify({ games: [], updatedAt: 0, error: String(e.message || e) }) };
  }
};
