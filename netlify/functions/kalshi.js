const https = require('https');

const mem = global.__boardKalshiMem || (global.__boardKalshiMem = {});

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'TheBoard/1.0' } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(body) }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function blobStore() {
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
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  const params = event.queryStringParameters || {};
  const series = (params.series || 'KXMLBGAME').replace(/[^A-Z0-9]/g, '');
  const cursor = params.cursor || '';
  const live = params.live === '1' || params.live === 'true';
  const ttl = live ? 3000 : 60 * 1000;
  const cacheKey = series + '|' + cursor + (live ? '|live' : '|pre');

  const hit = mem[cacheKey];
  if (hit && Date.now() - hit.at < ttl && hit.json) {
    headers['X-Board-Cache'] = 'mem';
    headers['Cache-Control'] = live ? 'public, max-age=1' : 'public, max-age=30';
    return { statusCode: 200, headers, body: JSON.stringify(hit.json) };
  }

  if (!live && !cursor) {
    try {
      const store = await blobStore();
      if (store) {
        const blob = await store.get('kalshi:' + series, { type: 'json' });
        if (blob && blob.at && Date.now() - blob.at < ttl && blob.json) {
          mem[cacheKey] = { at: blob.at, json: blob.json };
          headers['X-Board-Cache'] = 'blob';
          headers['Cache-Control'] = 'public, max-age=30';
          return { statusCode: 200, headers, body: JSON.stringify(blob.json) };
        }
      }
    } catch (e) {}
  }

  const url = 'https://external-api.kalshi.com/trade-api/v2/markets?series_ticker=' + series + '&status=open&limit=200' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');

  try {
    const { status, json } = await getJson(url);
    const payload = json || { markets: [] };
    mem[cacheKey] = { at: Date.now(), json: payload };
    if (!live && !cursor) {
      try {
        const store = await blobStore();
        if (store) await store.setJSON('kalshi:' + series, { at: Date.now(), json: payload });
      } catch (e) {}
    }
    headers['X-Board-Cache'] = 'miss';
    headers['Cache-Control'] = live ? 'public, max-age=1' : 'public, max-age=30';
    return { statusCode: status || 200, headers, body: JSON.stringify(payload) };
  } catch (e) {
    if (hit && hit.json) {
      headers['X-Board-Cache'] = 'stale';
      return { statusCode: 200, headers, body: JSON.stringify(hit.json) };
    }
    return { statusCode: 502, headers, body: JSON.stringify({ markets: [], error: String(e.message || e) }) };
  }
};
