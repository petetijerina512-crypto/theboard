'use strict';
// Scheduled every 5 minutes (netlify.toml). Grades open moneyline / spread / total
// tickets from ESPN finals. Changes are merged ticket by ticket into the latest
// saved board (conditional write), so bets placed while it runs are never lost.
const B = require('../lib/board');

const ESPN = {
  nfl: 'football/nfl', ncaaf: 'football/college-football', nhl: 'hockey/nhl',
  nba: 'basketball/nba', mlb: 'baseball/mlb', mma: 'mma/ufc'
};
const SKIP = { state: 1, the: 1, university: 1, college: 1 };

function chicagoYmd(d) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return p; // YYYY-MM-DD
}
async function board(key, ymd) {
  const url = 'https://site.api.espn.com/apis/site/v2/sports/' + ESPN[key] + '/scoreboard' + (ymd ? '?dates=' + ymd.replace(/-/g, '') : '');
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
  if (!res.ok) { console.log('espn fail', key, res.status); return []; }
  const data = await res.json();
  return (data.events || []).map(ev => {
    const c = ev.competitions && ev.competitions[0]; if (!c) return null;
    const st = (c.status && c.status.type) || {};
    const home = (c.competitors || []).find(x => x.homeAway === 'home') || {};
    const away = (c.competitors || []).find(x => x.homeAway === 'away') || {};
    return {
      id: String(ev.id || ''), date: ev.date || c.date || '',
      final: !!(st.completed || st.state === 'post'),
      home: (home.team && (home.team.displayName || home.team.name)) || '',
      away: (away.team && (away.team.displayName || away.team.name)) || '',
      hs: Number(home.score || 0), as: Number(away.score || 0)
    };
  }).filter(Boolean);
}
const keys = name => String(name || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !SKIP[w]);
function teamIn(blob, name) {
  const b = String(blob || '').toLowerCase();
  const words = keys(name);
  return !!words.length && words.every(w => b.indexOf(w) >= 0);
}
// Safety checks restored from the Oct 17 version: the ticket must have been placed
// before the game started, and if the ticket stores a game date it must match.
function sameGame(bet, s, g) {
  const start = new Date(g.date).getTime();
  const placed = new Date(bet.time || 0).getTime();
  if (start && placed && placed > start + 5 * 3600e3) return false;
  const gd = s.gameDate || s.commence;
  if (gd && start) {
    const want = /T\d\d:/.test(String(gd)) ? chicagoYmd(new Date(gd)) : String(gd).slice(0, 10);
    if (want && want !== chicagoYmd(new Date(start))) return false;
  }
  return true;
}
function gradeSel(s, g) {
  const mkt = String(s.mkt || 'ml').toLowerCase();
  const side = String(s.side || '').toLowerCase();
  if (mkt === 'ml') {
    if (g.hs === g.as) return 'push';
    return (side === 'h' ? g.hs > g.as : g.as > g.hs) ? 'won' : 'lost';
  }
  if (mkt === 'sp') {
    const line = Number(s.currentSpread != null ? s.currentSpread : 0);
    const homePick = side === 'h';
    const v = (homePick ? g.hs - g.as : g.as - g.hs) + (homePick ? -line : line);
    return v > 0 ? 'won' : v === 0 ? 'push' : 'lost';
  }
  if (mkt === 'tot') {
    const line = Number(s.currentTotal != null ? s.currentTotal : 0);
    const tot = g.hs + g.as;
    const over = side === 'o' || /over/i.test(s.label || '');
    return tot === line ? 'push' : ((over ? tot > line : tot < line) ? 'won' : 'lost');
  }
  return null; // props and other markets are graded by the admin screen
}
// Works out what should change on one ticket. Returns null if nothing.
function decide(bet, finals) {
  if (!bet || bet.status !== 'open' || !Array.isArray(bet.selections) || !bet.selections.length) return null;
  const results = bet.selections.map(s => {
    if (s.result) return s.result;
    const blob = [s.label, s.matchup, s.home, s.away].join(' ');
    const g = finals.find(x => (s.gid && x.id === String(s.gid)) || (teamIn(blob, x.home) && teamIn(blob, x.away)));
    if (!g || !sameGame(bet, s, g)) return null;
    return gradeSel(s, g);
  });
  const anyLost = results.indexOf('lost') >= 0;
  const allDone = results.every(Boolean);
  let status = null;
  if (anyLost) status = 'lost';
  else if (allDone && results.indexOf('won') >= 0) status = 'won';
  else if (allDone) status = 'push';
  const legChanges = results.some((r, i) => r && r !== bet.selections[i].result);
  if (!status && !legChanges) return null;
  return { status, results };
}

exports.handler = async (event) => {
  try {
    const store = await B.getStore(event);
    const now = new Date();
    const days = [chicagoYmd(now), chicagoYmd(new Date(now.getTime() - 864e5))];
    const games = [];
    for (const k of Object.keys(ESPN)) {
      for (const d of days) {
        try { (await board(k, d)).forEach(g => games.push(g)); } catch (e) { console.log('err', k, String(e)); }
      }
    }
    const finals = games.filter(g => g.final);
    const out = await B.mutate(store, st => {
      let graded = 0;
      Object.keys(st.bets).forEach(id => {
        (st.bets[id] || []).forEach(bet => {
          const d = decide(bet, finals);   // decided on the freshest copy of each ticket
          if (!d) return;
          d.results.forEach((r, i) => { if (r) bet.selections[i].result = r; });
          if (d.status) {
            bet.status = d.status;
            bet.settledAt = new Date().toISOString();
            graded++;
            st.balanceLog = (st.balanceLog || []).concat([{ at: bet.settledAt, user: id, bet: bet.id, status: bet.status, amount: Math.round(B.ticketNet(bet) * 100) / 100 }]).slice(-200);
          }
          bet.rev = Number(bet.rev || 1) + 1; bet.updatedBy = 'grader';
        });
      });
      st.grader = { at: new Date().toISOString(), graded, finals: finals.length };
      return { graded, finals: finals.length };
    });
    console.log('graded', out.graded, 'finals', out.finals);
    return B.reply(200, { ok: true, graded: out.graded, finals: out.finals });
  } catch (e) {
    console.log('grade error', String(e && e.stack || e));
    return B.reply(500, { error: 'grade failed' });
  }
};
exports._test = { decide, gradeSel, sameGame, teamIn };
