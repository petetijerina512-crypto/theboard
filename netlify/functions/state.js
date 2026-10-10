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

  function mergeWeeks(a, b) {
    const map = {};
    (Array.isArray(a) ? a : []).concat(Array.isArray(b) ? b : []).forEach(w => {
      if (w && w.userId && w.week) map[w.userId + '|' + w.week] = w;
    });
    return Object.keys(map).map(k => map[k]);
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
      Object.keys(usersMap).forEach(id => {
        if (usersMap[id] && Number(usersMap[id].opening) === 1000) usersMap[id].opening = 0;
      });
      Object.keys(usersMap).forEach(id => {
        if (id === 'admin' && usersMap.Pistol) {
          const old = usersMap.admin;
          usersMap.Pistol = Object.assign({}, old, usersMap.Pistol, { id: 'Pistol', role: 'admin' });
          delete usersMap.admin;
        }
      });
      const users = Object.keys(usersMap).map(k => usersMap[k]);
      const balanceAt = Object.assign({}, prev.balanceAt || {}, incoming.balanceAt || {});
      const balances = Object.assign({}, prev.balances || {});
      const locks = Object.assign({}, prev.balanceLock || {});
      Object.keys(incoming.balanceUnlock || {}).forEach(id => { if (incoming.balanceUnlock[id]) delete locks[id]; });
      Object.keys(incoming.balanceLock || {}).forEach(id => {
        const t = Number(incoming.balanceLock[id] || 0);
        if (t) locks[id] = Math.max(Number(locks[id] || 0), t);
      });
      Object.keys(incoming.balances || {}).forEach(id => {
        const incAt = Number((incoming.balanceAt && incoming.balanceAt[id]) || 0);
        const prevAt = Number((prev.balanceAt && prev.balanceAt[id]) || 0);
        const nextVal = Number(incoming.balances[id]);
        const prevVal = balances[id];
        const unlocked = incoming.balanceUnlock && incoming.balanceUnlock[id];
        if (locks[id] && !unlocked && nextVal !== 0) return;
        if (nextVal === 0) {
          if (!unlocked) return;
          balances[id] = 0;
          balanceAt[id] = Math.max(incAt, Date.now());
          locks[id] = Math.max(Number(locks[id] || 0), Date.now());
          return;
        }
        if (Number(prevVal) === 0 && nextVal === 1000) return;
        if (!incAt && prevAt) return;
        if (incAt >= prevAt) {
          balances[id] = nextVal;
          balanceAt[id] = incAt;
        }
      });
      const bets = Object.assign({}, prev.bets || {});
      Object.keys(bets).forEach(id => {
        bets[id] = (bets[id] || []).filter(bt => {
          const when = String((bt && bt.time) || '');
          const lab = String((((bt || {}).selections || [])[0] || {}).label || '').toLowerCase();
          if (lab.indexOf('king green') >= 0 || lab.indexOf('ribovics') >= 0) return false;
          return when.slice(0, 10) >= '2026-10-06';
        });
      });
      Object.keys(bets).forEach(id => {
        bets[id] = (bets[id] || []).map(bt => {
          if (!bt || (bt.status !== 'lost' && bt.status !== 'won')) return bt;
          const start = new Date(((bt.selections || [])[0] || {}).gameDate || 0).getTime();
          const settled = new Date(bt.settledAt || 0).getTime();
          const early = start && settled && (settled - start) < 30 * 60 * 1000;
          const rigoToday = id === 'KingRigo007' && ['b1791660721540','b1791660746878','b1791660773591'].indexOf(bt.id) >= 0;
          if (!early && !rigoToday) return bt;
          const next = Object.assign({}, bt, { status: 'open', paid: false });
          delete next.settledAt;
          (next.selections || []).forEach(s => { if (s) delete s.result; });
          return next;
        });
      });
      Object.keys(incoming.bets || {}).forEach(id => {
        const a = Array.isArray(bets[id]) ? bets[id] : [];
        const b = Array.isArray(incoming.bets[id]) ? incoming.bets[id] : [];
        if (!b.length && a.length) { bets[id] = a; return; }
        const map = {};
        a.concat(b).forEach(bt => {
          if (!bt || !bt.id) return;
          const prev = map[bt.id];
          if (prev && (prev.status === 'won' || prev.status === 'lost' || prev.status === 'push') && bt.status !== prev.status) return;
          map[bt.id] = bt;
        });
        const merged = Object.keys(map).map(k => map[k]);
        bets[id] = merged.length >= a.length ? merged : a;
      });
      const next = {
        users,
        balances,
        balanceAt,
        balanceLock: locks,
        bets,
        settings: incoming.settings || prev.settings || null,
        results: incoming.results || prev.results || {},
        weeks: mergeWeeks(prev.weeks, incoming.weeks),
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
