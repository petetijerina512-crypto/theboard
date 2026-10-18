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
    const url = ESPN[key] + '?limit=300';
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }); if (!res.ok) { console.log('espn fail', key, res.status); return []; }
    const data = await res.json();
    return (data.events || []).map(ev => {
      const c = ev.competitions && ev.competitions[0]; if (!c) return null;
      const st = (c.status && c.status.type) || {};
      const home = (c.competitors || []).find(x => x.homeAway === 'home') || {};
      const away = (c.competitors || []).find(x => x.homeAway === 'away') || {};
      return {
        final: !!(st.completed || st.state === 'post'),
        home: (home.team && (home.team.displayName || home.team.name)) || '',
        away: (away.team && (away.team.displayName || away.team.name)) || '',
        hs: Number(home.score || 0), as: Number(away.score || 0)
      };
    }).filter(Boolean);
  }
  function has(blob, name) {
    const n = String(name || '').toLowerCase();
    const b = String(blob || '').toLowerCase();
    if (n.length < 4) return false;
    return b.indexOf(n) >= 0;
  }
  try {
    const state = (await store.get('state', { type: 'json' })) || { bets: {}, balances: {} };
    const games = [];
    for (const k of Object.keys(ESPN)) { try { (await board(k)).forEach(g => games.push(g)); } catch (e) { console.log('err', k, String(e)); } }
    const finals = games.filter(g => g.final);
    console.log('finals', finals.length);
    let graded = 0;
    Object.keys(state.bets || {}).forEach(id => {
      (state.bets[id] || []).forEach(bet => {
        if (!bet || bet.status !== 'open' || !bet.selections) return;
        let anyLost = false, allDone = true, anyWon = false;
        bet.selections.forEach(s => {
          const blob = (s.label || '') + ' ' + (s.matchup || '');
          const g = finals.find(x => has(blob, x.home) && has(blob, x.away));
          if (!g) { allDone = false; return; }
          const mkt = String(s.mkt || 'ml').toLowerCase();
          let result = null;
          if (mkt === 'ml') {
            const homePick = has(s.label || '', g.home);
            result = (homePick ? g.hs > g.as : g.as > g.hs) ? 'won' : 'lost';
            if (g.hs === g.as) result = 'push';
          }
          if (result) { s.result = result; if (result === 'lost') anyLost = true; if (result === 'won') anyWon = true; }
          else allDone = false;
        });
        if (anyLost) { bet.status = 'lost'; bet.settledAt = new Date().toISOString(); graded++; }
        else if (allDone && anyWon) { bet.status = 'won'; bet.settledAt = new Date().toISOString(); graded++; }
      });
    });
    console.log('graded', graded);
    state.updatedAt = Date.now();
    await store.setJSON('state', state);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, graded, finals: finals.length }) };
  } catch (e) {
    console.log('grade error', String(e));
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(e.message || e) }) };
  }
};
