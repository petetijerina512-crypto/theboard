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
    mlb: 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard',
    mma: 'https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard'
  };
  async function board(key) {
    const res = await fetch(ESPN[key], { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
    if (!res.ok) { console.log('espn fail', key, res.status); return []; }
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
  const SKIP = { state:1, the:1, university:1, college:1 };
  function keys(name) {
    return String(name || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !SKIP[w]);
  }
  function teamIn(blob, name) {
    const b = String(blob || '').toLowerCase();
    const words = keys(name);
    if (!words.length) return false;
    return words.every(w => b.indexOf(w) >= 0);
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
          const blob = (s.label || '') + ' ' + (s.matchup || '') + ' ' + (s.home || '') + ' ' + (s.away || '');
          const g = finals.find(x => teamIn(blob, x.home) && teamIn(blob, x.away));
          if (!g) { allDone = false; return; }
          const mkt = String(s.mkt || 'ml').toLowerCase();
          const side = String(s.side || '').toLowerCase();
          let result = null;
          if (mkt === 'ml') {
            const homePick = side === 'h';
            result = (homePick ? g.hs > g.as : g.as > g.hs) ? 'won' : 'lost';
            if (g.hs === g.as) result = 'push';
          } else if (mkt === 'sp') {
            const line = Number(s.currentSpread != null ? s.currentSpread : 0);
            const homePick = side === 'h';
            const margin = homePick ? (g.hs - g.as) : (g.as - g.hs);
            result = margin + (homePick ? -line : line) > 0 ? 'won' : (margin + (homePick ? -line : line) === 0 ? 'push' : 'lost');
          } else if (mkt === 'tot') {
            const line = Number(s.currentTotal != null ? s.currentTotal : 0);
            const tot = g.hs + g.as;
            const over = side === 'o' || /over/i.test(s.label || '');
            result = tot === line ? 'push' : ((over ? tot > line : tot < line) ? 'won' : 'lost');
          }
          if (result) { s.result = result; if (result === 'lost') anyLost = true; if (result === 'won') anyWon = true; }
          else allDone = false;
        });
        if (anyLost || (allDone && anyWon && bet.selections.every(s => s.result))) {
          bet.status = anyLost ? 'lost' : 'won';
          bet.settledAt = new Date().toISOString();
          graded++;
          const stake = Number(bet.stake || 0);
          const amt = bet.status === 'lost' ? -stake : stake;
          state.balanceLog = state.balanceLog || [];
          state.balanceLog.push({ at: bet.settledAt, user: id, bet: bet.id, status: bet.status, amount: amt });
          if (state.balanceLog.length > 200) state.balanceLog = state.balanceLog.slice(-200);
        }
      });
    });
    console.log('graded', graded);
    state.grader = { at: new Date().toISOString(), graded: graded, finals: finals.length };
    state.updatedAt = Date.now();
    await store.setJSON('state', state);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, graded, finals: finals.length }) };
  } catch (e) {
    console.log('grade error', String(e));
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(e.message || e) }) };
  }
};
