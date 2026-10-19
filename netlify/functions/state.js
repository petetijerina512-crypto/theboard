const { getStore } = require('@netlify/blobs');
exports.handler = async function(event) {
  const store = getStore({ name: 'board', consistency: 'strong' });
  if (event.httpMethod === 'GET') {
    const data = await store.get('state', { type: 'json' });
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) };
  }
  if (event.httpMethod === 'POST') {
    const body = JSON.parse(event.body || '{}');
    const current = (await store.get('state', { type: 'json' })) || {};
    const next = Object.assign({}, current);
    if (body.users) next.users = body.users;
    if (body.bets) {
      next.bets = Object.assign({}, current.bets || {}, body.bets);
    }
    if (body.balances) {
      next.balances = Object.assign({}, current.balances || {});
      next.balanceAt = Object.assign({}, current.balanceAt || {});
      next.balanceLock = Object.assign({}, current.balanceLock || {});
      next.balanceBase = Object.assign({}, current.balanceBase || {});
      next.balanceBaseAt = Object.assign({}, current.balanceBaseAt || {});
      Object.keys(body.balances).forEach(id => {
        const lock = Number((current.balanceLock || {})[id] || 0);
        const at = Number((body.balanceAt || {})[id] || 0);
        const base = (current.balanceBase || {})[id];
        const baseAt = Number((current.balanceBaseAt || {})[id] || 0);
        const incoming = Number(body.balances[id]);
        // if a base is set, only accept 0 or a value that matches base (cleared accounts stay cleared)
        if (base != null && baseAt && incoming !== Number(base)) {
          // reject non-base writes for cleared accounts
          return;
        }
        if (!lock || at >= lock) {
          next.balances[id] = incoming;
          if (at) next.balanceAt[id] = at;
        }
      });
    }
    if (body.balanceUnlock) {
      next.balanceLock = Object.assign({}, current.balanceLock || {});
      Object.keys(body.balanceUnlock).forEach(id => { delete next.balanceLock[id]; });
    }
    if (body.balanceLock) {
      next.balanceLock = Object.assign({}, next.balanceLock || {}, body.balanceLock);
    }
    if (body.balanceBase) next.balanceBase = Object.assign({}, current.balanceBase || {}, body.balanceBase);
    if (body.balanceBaseAt) next.balanceBaseAt = Object.assign({}, current.balanceBaseAt || {}, body.balanceBaseAt);
    if (body.settings) next.settings = Object.assign({}, current.settings || {}, body.settings);
    if (body.results) next.results = Object.assign({}, current.results || {}, body.results);
    if (body.weeks) next.weeks = body.weeks;
    next.updatedAt = Date.now();
    await store.setJSON('state', next);
    return { statusCode: 200, body: JSON.stringify({ ok: true, users: (next.users||[]).length, updatedAt: next.updatedAt }) };
  }
  return { statusCode: 405, body: 'Method not allowed' };
};
