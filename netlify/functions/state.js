exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  let store;
  try {
    const mod = await import('@netlify/blobs');
    store = mod.getStore({
      name: 'board-state',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_AUTH_TOKEN
    });
  } catch (e) {
    try {
      const { getStore } = require('@netlify/blobs');
      store = getStore('theboard');
    } catch (e2) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'blobs unavailable' }) };
    }
  }

  try {
    if (event.httpMethod === 'GET') {
      const raw = await store.get('state', { type: 'json' });
      return { statusCode: 200, headers, body: JSON.stringify(raw || { users: [], bets: {}, balances: {}, settings: null, updatedAt: 0 }) };
    }
    if (event.httpMethod === 'POST') {
      const incoming = JSON.parse(event.body || '{}');
      const prev = (await store.get('state', { type: 'json' })) || { users: [], bets: {}, balances: {}, settings: null };
      const usersMap = {};
      (prev.users || []).forEach(u => { if (u && u.id) usersMap[u.id] = u; });
      (incoming.users || []).forEach(u => { if (u && u.id) usersMap[u.id] = Object.assign({}, usersMap[u.id] || {}, u); });
      const users = Object.keys(usersMap).map(k => usersMap[k]);
      const balances = Object.assign({}, prev.balances || {}, incoming.balances || {});
      const bets = Object.assign({}, prev.bets || {});
      Object.keys(incoming.bets || {}).forEach(id => {
        const a = Array.isArray(bets[id]) ? bets[id] : [];
        const b = Array.isArray(incoming.bets[id]) ? incoming.bets[id] : [];
        if (!b.length && a.length) { bets[id] = a; return; }
        const map = {};
        a.concat(b).forEach(bt => { if (bt && bt.id) map[bt.id] = bt; });
        const merged = Object.keys(map).map(k => map[k]);
        bets[id] = merged.length >= a.length ? merged : a;
      });
      const next = {
        users,
        balances,
        bets,
        settings: incoming.settings || prev.settings || null,
        results: incoming.results || prev.results || {},
        updatedAt: Date.now()
      };
      await store.setJSON('state', next);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, users: next.users.length, updatedAt: next.updatedAt }) };
    }
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'method' }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(e.message || e) }) };
  }
};
