exports.handler = async () => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  let store;
  try {
    const mod = await import('@netlify/blobs');
    store = mod.getStore({ name: 'board-state', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_AUTH_TOKEN });
  } catch (e) {
    try { const { getStore } = require('@netlify/blobs'); store = getStore('theboard'); }
    catch (e2) { return { statusCode: 500, headers, body: JSON.stringify({ error: 'blobs' }) }; }
  }
  const ESPN = {
    nfl: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard',
    ncaaf: 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard',
    nhl: 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard',
    nba: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard',
    mlb: 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard'
  };
  function stamp(offset) {
    const d = new Date(); d.setDate(d.getDate() + (offset || 0));
    return d.getFullYear() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0');
  }
  async function board(key) {
    const url = ESPN[key] + '?dates=' + stamp(-1) + '-' + stamp(0) + '&limit=200';
    const res = await fetch(url); if (!res.ok) return [];
    const data = await res.json();
    return (data.events || []).map(ev => {
      const c = ev.competitions && ev.competitions[0]; if (!c) return null;
      const st = (c.status && c.status.type) || {};
      const home = (c.competitors || []).find(x => x.homeAway === 'home') || {};
      const away = (c.competitors || []).find(x => x.homeAway === 'away') || {};
      return {
        sport: key, final: st.completed || st.state === 'post',
        home: (home.team && (home.team.displayName || home.team.name)) || '',
        away: (away.team && (away.team.displayName || away.team.name)) || '',
        hs: Number(home.score || 0), as: Number(away.score || 0)
      };
    }).filter(Boolean);
  }
  function hit(blob, name) {
    const n = String(name || '').toLowerCase(); if (n.length < 4) return false;
    return String(blob || '').toLowerCase().indexOf(n) >= 0 || String(blob || '').toLowerCase().indexOf(n.split(' ').pop()) >= 0;
  }
  function ticketNet(bt) {
    if (!bt || (bt.status !== 'won' && bt.status !== 'lost')) return 0;
    const stake = Number(bt.stake || 0);
    if (bt.status === 'lost') return -stake;
    const sels = bt.selections || []; if (sels.length !== 1) return 0;
    const o = Number(sels[0].lockedOdds != null ? sels[0].lockedOdds : sels[0].odds || 0);
    if (!o) return 0;
    return o > 0 ? stake * (o / 100) : stake * (100 / Math.abs(o));
  }
  try {
    const state = (await store.get('state', { type: 'json' })) || { bets: {}, balances: {} };
    const sports = {};
    Object.keys(state.bets || {}).forEach(id => (state.bets[id] || []).forEach(b => {
      if (b && b.status === 'open') (b.selections || []).forEach(s => { if (s && s.sport && ESPN[String(s.sport).toLowerCase()]) sports[String(s.sport).toLowerCase()] = 1; });
    }));
    if (!Object.keys(sports).length) sports.nhl = 1;
    const games = [];
    for (const k of Object.keys(sports)) { try { (await board(k)).forEach(g => games.push(g)); } catch (e) {} }
    let graded = 0;
    Object.keys(state.bets || {}).forEach(id => {
      (state.bets[id] || []).forEach(bet => {
        if (!bet || bet.status !== 'open' || !bet.selections) return;
        bet.selections.forEach(s => {
          const blob = (s.label || '') + ' ' + (s.matchup || '');
          const g = games.find(x => x.final && hit(blob, x.home) && hit(blob, x.away));
          if (!g) return;
          const mkt = String(s.mkt || '').toLowerCase();
          let result = null;
          if (mkt === 'ml') {
            const pick = String(s.label || '').toLowerCase();
            const home = pick.indexOf(String(g.home).toLowerCase().split(' ').pop()) >= 0;
            result = (home ? g.hs > g.as : g.as > g.hs) ? 'won' : 'lost';
            if (g.hs === g.as) result = 'push';
          } else if (mkt === 'tot') {
            const line = Number(String(s.label || '').match(/([0-9]+(?:\.[0-9]+)?)/)?.[1] || 0);
            const tot = g.hs + g.as;
            if (!line) return;
            if (tot === line) result = 'push';
            else result = (String(s.side) === 'o' ? tot > line : tot < line) ? 'won' : 'lost';
          } else if (mkt === 'sp') {
            const line = Number(String(s.label || '').match(/([+-]?[0-9]+(?:\.[0-9]+)?)/)?.[1] || 0);
            const pick = String(s.label || '').toLowerCase();
            const home = pick.indexOf(String(g.home).toLowerCase().split(' ').pop()) >= 0;
            const adj = home ? (g.hs + line) - g.as : (g.as + line) - g.hs;
            if (Math.abs(adj) < 0.01) result = 'push';
            else result = adj > 0 ? 'won' : 'lost';
          }
          if (result) s.result = result;
        });
        const results = bet.selections.map(s => s.result || null);
        if (results.some(r => r === 'lost')) { bet.status = 'lost'; bet.settledAt = new Date().toISOString(); graded++; }
        else if (results.length && results.every(r => r === 'won' || r === 'push') && results.some(r => r === 'won')) { bet.status = 'won'; bet.settledAt = new Date().toISOString(); graded++; }
      });
    });
    const bases = state.balanceBase || {};
    const baseAt = state.balanceBaseAt || {};
    const balances = Object.assign({}, state.balances || {});
    Object.keys(state.bets || {}).forEach(id => {
      const start = Number(baseAt[id] || 0);
      let net = 0;
      (state.bets[id] || []).forEach(bt => {
        if (!bt || (bt.status !== 'won' && bt.status !== 'lost')) return;
        const when = new Date(bt.settledAt || bt.time || 0).getTime();
        if (start && when && when <= start) return;
        net += ticketNet(bt);
      });
      balances[id] = Math.round(((Number(bases[id] || 0)) + net) * 100) / 100;
    });
    state.balances = balances;
    state.updatedAt = Date.now();
    await store.setJSON('state', state);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, graded }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(e.message || e) }) };
  }
};
