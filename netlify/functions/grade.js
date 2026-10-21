'use strict';
// Scheduled every 5 minutes (netlify.toml). Grades open tickets from ESPN final scores.
// v1113 changes (see report):
//  - looks up each open ticket's own game dates (not only today/yesterday Chicago time)
//  - only fetches leagues/dates that open tickets need, in parallel, with timeouts
//  - more leagues: WNBA, CFL, NCAA basketball (M/W), soccer leagues, UFC/PFL fights
//  - spread fix: the home side was graded with the line's sign flipped
//  - the line comes from the ticket label (what the player saw), like the phone grader
//  - 1st half / 1st quarter / 1st period / first-5 bets are graded from period scores
//    (and are never graded as full-game bets)
//  - name matching ignores accents and knows common aliases (UMass, Montréal, ...)
//  - cancelled / postponed / suspended games are never auto-graded
//  - every open ticket that is past its game and still open gets a plain reason in
//    st.grader.waiting, shown to admins, so nothing is silently stuck
const B = require('./board');

const LEAGUES = {
  nfl: 'football/nfl', ncaaf: 'football/college-football', cfl: 'football/cfl',
  nba: 'basketball/nba', wnba: 'basketball/wnba', ncaab: 'basketball/mens-college-basketball',
  ncaaw: 'basketball/womens-college-basketball', nhl: 'hockey/nhl', mlb: 'baseball/mlb',
  mma: 'mma/ufc', pfl: 'mma/pfl',
  epl: 'soccer/eng.1', laliga: 'soccer/esp.1', bundesliga: 'soccer/ger.1', seriea: 'soccer/ita.1',
  ligue1: 'soccer/fra.1', mls: 'soccer/usa.1', ucl: 'soccer/uefa.champions', ligamx: 'soccer/mex.1',
  uel: 'soccer/uefa.europa', facup: 'soccer/eng.fa', efl: 'soccer/eng.2', ere: 'soccer/ned.1',
  liga_pt: 'soccer/por.1', brazil: 'soccer/bra.1', libertadores: 'soccer/conmebol.libertadores',
  ligaarg: 'soccer/arg.1', superlig: 'soccer/tur.1'
};
const EXTRA = { ncaaf: '&groups=80&limit=400', ncaab: '&groups=50&limit=400', ncaaw: '&limit=400' };
const NOT_AUTO = { tennis: 'Tennis', boxing: 'Boxing' };
// Leagues where a tied game makes a full-game moneyline bet a LOSS (owner decision, Oct 21 2026).
const TIE_LOSES_ML = { nfl: 1, nhl: 1 };
const isSoccer = k => /^soccer\//.test(LEAGUES[k] || '');
const isFight = k => k === 'mma' || k === 'pfl';
// label prefixes the phone writes, e.g. "NFL · Bears @ Lions · ..."
const PREFIX = {
  nfl: 'nfl', ncaaf: 'ncaaf', 'ncaa football': 'ncaaf', cfb: 'ncaaf', cfl: 'cfl', nba: 'nba', wnba: 'wnba',
  ncaab: 'ncaab', 'ncaa basketball': 'ncaab', ncaaw: 'ncaaw', 'ncaa wbb': 'ncaaw', nhl: 'nhl', mlb: 'mlb',
  ufc: 'mma', mma: 'mma', 'ufc / mma': 'mma', pfl: 'pfl', ucl: 'ucl', 'champions league': 'ucl', uel: 'uel',
  'europa league': 'uel', epl: 'epl', 'premier league': 'epl', mls: 'mls', 'la liga': 'laliga', laliga: 'laliga',
  'serie a': 'seriea', bundesliga: 'bundesliga', 'ligue 1': 'ligue1', 'liga mx': 'ligamx', tennis: 'tennis', boxing: 'boxing'
};
// Whole-game length guesses, used only to decide when an open ticket counts as "late".
const GAME_HOURS = { nfl: 4, ncaaf: 4.5, cfl: 4, mlb: 4, nhl: 3.5, mma: 7, pfl: 7, boxing: 7, tennis: 5 };
const FETCH_TIMEOUT_MS = 7000;
const BUDGET_MS = 20000;   // scheduled run: stays inside Netlify's 30 s limit for scheduled functions
const NOW_BUDGET_MS = 6000; // 'Grade now' runs inside state.js, which has Netlify's 10 s limit

// ---------- dates ----------
const tz = zone => d => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const chicagoYmd = tz('America/Chicago');
const easternYmd = tz('America/New_York');
// Phones sometimes saved "2026-10-18T17:00:00" with no zone; those values are UTC.
function parseWhen(v) {
  if (v == null || v === '') return null;
  let s = String(v).trim();
  if (/^\d{4}-\d\d-\d\d$/.test(s)) return { dateOnly: s, t: null };
  if (/T\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(s)) s += 'Z';
  const t = Date.parse(s);
  return isNaN(t) ? null : { dateOnly: null, t };
}

// ---------- names ----------
const ALIAS = [
  [/\bumass\b/g, 'massachusetts'], [/\buconn\b/g, 'connecticut'], [/\bfiu\b/g, 'florida international'],
  [/\bflorida intl\b/g, 'florida international'], [/\bapp state\b/g, 'appalachian state'],
  [/\bul monroe\b/g, 'louisiana monroe'], [/\bulm\b/g, 'louisiana monroe'], [/\bla tech\b/g, 'louisiana tech'],
  [/\bsouthern miss\b/g, 'southern mississippi'], [/\bmiami fl\b/g, 'miami'], [/\bsaint\b/g, 'st'],
  [/\bst\.\s/g, 'st '], [/\bpenn st\b/g, 'penn state'], [/\bole miss\b/g, 'ole miss'], [/\butsa\b/g, 'utsa'],
  [/\bla clippers\b/g, 'los angeles clippers'], [/\bla lakers\b/g, 'los angeles lakers'],
  [/\boakland athletics\b/g, 'athletics'], [/\bsacramento athletics\b/g, 'athletics'],
  [/\bmanchester utd\b/g, 'manchester united'], [/\bman utd\b/g, 'manchester united'], [/\bman city\b/g, 'manchester city'],
  [/\bpsg\b/g, 'paris saint germain'], [/\bparis sg\b/g, 'paris saint germain'], [/\binter milan\b/g, 'internazionale'],
  [/\brc lens\b/g, 'lens'], [/\bafc ajax\b/g, 'ajax']
];
const STOP = { the: 1, of: 1, university: 1, fc: 1, cf: 1, sc: 1, ac: 1, afc: 1, club: 1 };
function norm(s) {
  let x = String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  x = x.replace(/[’'`]/g, '').replace(/&/g, ' and ').replace(/\(([a-z]{2})\)/g, ' $1 ');
  x = ' ' + x.replace(/[^a-z0-9.\s]/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
  ALIAS.forEach(([re, to]) => { x = x.replace(re, to); });
  return x.replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
}
const toks = s => norm(s).split(' ').filter(w => w && !STOP[w]);
const subset = (a, b) => a.length > 0 && a.every(w => b.indexOf(w) >= 0);
// Does the ticket's team name refer to this ESPN team?
function teamMatch(name, team) {
  const T = toks(name);
  if (!T.length || !team) return false;
  for (const v of team.names) {
    const V = toks(v);
    if (!V.length) continue;
    if (subset(V, T) || (T.length >= 2 && subset(T, V))) return true;
  }
  return false;
}

function lastMatch(name, team) {
  const T = toks(name); if (!T.length || !team) return false;
  const last = T[T.length - 1];
  return last.length >= 3 && team.names.some(v => { const V = toks(v); return V.length && V[V.length - 1] === last; });
}

// ---------- the ticket side ----------
function leagueOf(s) {
  const sp = String(s.sport || '').toLowerCase().trim();
  if (sp) return (LEAGUES[sp] || NOT_AUTO[sp]) ? sp : (PREFIX[sp] || sp);
  const lab = String(s.label || '');
  const m = /^\s*([A-Za-z0-9 /]+?)\s*·/.exec(lab);
  if (m && PREFIX[m[1].toLowerCase()]) return PREFIX[m[1].toLowerCase()];
  return '';
}
// "Away @ Home" from the fields the phone saved.
function teamsOf(s) {
  if (s.home && s.away) return { away: String(s.away), home: String(s.home) };
  const src = [s.matchup, s.verifiedTeams].concat(String(s.label || '').split('·')).filter(Boolean);
  for (const part of src) {
    const m = /^\s*(.+?)\s+(?:@|at|vs\.?)\s+(.+?)\s*$/i.exec(String(part));
    if (m) return { away: m[1].replace(/\s+(ML|1H|1Q|1P|F5)$/i, '').trim(), home: m[2].replace(/\s+(ML|1H|1Q|1P|F5)\b.*$/i, '').trim() };
  }
  return null;
}
function periodOf(s) {
  const p = String(s.period || '').toLowerCase();
  if (p === 'futures' || p === 'sb') return 'futures';
  if (p) return p;
  const lab = String(s.label || '');
  if (/\b1H\b|1st half/i.test(lab)) return 'h1';
  if (/\b1Q\b|1st quarter/i.test(lab)) return 'q1';
  if (/\b1P\b|1st period/i.test(lab)) return 'p1';
  if (/\bF5\b|first 5|1st 5 innings/i.test(lab)) return 'f5';
  return '';
}
function num(str) {
  if (str == null) return null;
  const s = String(str).replace('½', '.5').replace(/^([+-]?)\./, '$10.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
// The line printed on the ticket wins (it is what the player saw); the saved number is the fallback.
function spreadLine(s) {
  const lab = String(s.label || '');
  let m = /line\s*([+-]?\d+(?:\.\d+)?½?)/i.exec(lab);
  if (m) return { line: num(m[1]), from: 'label' };
  const all = (lab.match(/(?:^|\s)([+-]\d+(?:\.\d+)?½?|[+-]½)(?=$|[\s·])/g) || []).map(x => num(x.trim())).filter(n => n != null && Math.abs(n) < 60);
  if (all.length) return { line: all[all.length - 1], from: 'label' };
  if (/\b(pk|pick'?em|pick)\b/i.test(lab)) return { line: 0, from: 'label' };
  if (s.currentSpread != null && s.currentSpread !== '') return { line: Number(s.currentSpread), from: 'saved' };
  return null;
}
function totalLine(s) {
  if (s.currentTotal != null && s.currentTotal !== '' && Number.isFinite(Number(s.currentTotal))) return { line: Number(s.currentTotal), from: 'saved' };
  const lab = String(s.label || '');
  let m = /line\s*(\d+(?:\.\d+)?½?)/i.exec(lab);
  if (m) return { line: num(m[1]), from: 'label' };
  const all = lab.match(/(?:\b|^)(?:o|u|over|under)\s?(\d+(?:\.\d+)?½?)/gi);
  if (all && all.length) return { line: num(all[all.length - 1].replace(/^(?:o|u|over|under)\s?/i, '')), from: 'label' };
  return null;
}
function overUnder(s) {
  const side = String(s.side || '').toLowerCase();
  if (side === 'o' || side === 'over') return 'o';
  if (side === 'u' || side === 'under') return 'u';
  const lab = String(s.label || '');
  if (/\bover\b|\so\d/i.test(lab)) return 'o';
  if (/\bunder\b|\su\d/i.test(lab)) return 'u';
  return null;
}

// ---------- ESPN ----------
async function fetchJson(url, fetchImpl, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || FETCH_TIMEOUT_MS);
  try {
    const res = await (fetchImpl || fetch)(url, { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(t); }
}
function teamInfo(c) {
  const t = c.team || {};
  const a = c.athlete || {};
  const names = [t.displayName, t.shortDisplayName, (t.location && t.name) ? t.location + ' ' + t.name : '', t.name && t.name.length > 4 ? t.name : '', t.location && t.location.length > 5 ? t.location : '', a.displayName, a.fullName, a.shortName]
    .filter(Boolean);
  return {
    names, label: t.displayName || a.displayName || '',
    score: c.score != null && c.score !== '' ? Number(c.score) : null,
    lines: (c.linescores || []).map(x => Number(x.value != null ? x.value : x.displayValue)),
    winner: c.winner === true
  };
}
function parseBoard(data, league) {
  const out = [];
  (data.events || []).forEach(ev => {
    const comps = isFight(league) ? (ev.competitions || []) : (ev.competitions || []).slice(0, 1);
    comps.forEach(c => {
      const st = (c.status && c.status.type) || (ev.status && ev.status.type) || {};
      const cs = c.competitors || [];
      let home = cs.find(x => x.homeAway === 'home'), away = cs.find(x => x.homeAway === 'away');
      if (!home || !away) { home = cs[0]; away = cs[1]; }
      if (!home || !away) return;
      out.push({
        league, id: String(isFight(league) ? (c.id || ev.id) : ev.id), date: c.date || ev.date || '',
        state: st.state || '', completed: st.completed === true, statusName: String(st.name || ''),
        home: teamInfo(home), away: teamInfo(away)
      });
    });
  });
  return out;
}
async function loadBoards(needs, fetchImpl, deadline) {
  const jobs = [];
  Object.keys(needs).forEach(lg => needs[lg].forEach(d => jobs.push([lg, d])));
  const games = []; const errors = []; const failed = new Set();
  games.failedLeagues = failed;
  let i = 0;
  async function worker() {
    while (i < jobs.length) {
      const [lg, d] = jobs[i++];
      if (Date.now() > deadline) { errors.push(lg + ' ' + d + ': out of time'); continue; }
      const url = 'https://site.api.espn.com/apis/site/v2/sports/' + LEAGUES[lg] + '/scoreboard?dates=' + d + (EXTRA[lg] || '');
      try { parseBoard(await fetchJson(url, fetchImpl, Math.max(1000, Math.min(FETCH_TIMEOUT_MS, deadline - Date.now()))), lg).forEach(g => games.push(g)); }
      catch (e) { errors.push(lg + ' ' + d + ': ' + String(e && e.message || e).slice(0, 80)); failed.add(lg); }
    }
  }
  await Promise.all([1, 2, 3, 4, 5, 6].map(worker));
  return { games, errors, calls: jobs.length };
}

// ---------- grading one leg ----------
// Returns { r: 'won'|'lost'|'push'|null, why: '...' }
function anchorOf(bet, s) {
  const w = parseWhen(s.commence) || parseWhen(s.gameDate);
  return { when: w, placed: Date.parse(bet.time || '') || null };
}
function findGame(bet, s, lg, teams, games) {
  const { when, placed } = anchorOf(bet, s);
  const pool = games.filter(g => (!lg || g.league === lg));
  const cands = [];
  pool.forEach(g => {
    const byId = !!s.gid && String(s.gid) === g.id;
    let flip = null;
    if (teams) {
      if (teamMatch(teams.away, g.away) && teamMatch(teams.home, g.home)) flip = false;
      else if (teamMatch(teams.away, g.home) && teamMatch(teams.home, g.away)) flip = true;
    }
    if (teams && flip === null && isFight(g.league)) {
      // fighters: last names are enough when BOTH fighters match ("Timothy" vs "Timmy" Cuamba)
      if (lastMatch(teams.away, g.away) && lastMatch(teams.home, g.home)) flip = false;
      else if (lastMatch(teams.away, g.home) && lastMatch(teams.home, g.away)) flip = true;
    }
    if (!byId && flip === null) return;
    const start = Date.parse(g.date) || null;
    if (start && placed && placed > start + 5 * 3600e3) return;          // placed long after this game began
    // date-only values were saved in Chicago, Eastern or UTC terms depending on the phone/version
    if (when && when.dateOnly && start && [chicagoYmd(new Date(start)), easternYmd(new Date(start)), new Date(start).toISOString().slice(0, 10)].indexOf(when.dateOnly) < 0) return;
    if (when && when.t && start && Math.abs(start - when.t) > 36 * 3600e3) return; // a different game of a series
    const ref = (when && when.t) || placed || start;
    cands.push({ g, flip: !!flip, dist: start && ref ? Math.abs(start - ref) : 0, byId });
  });
  cands.sort((a, b) => (b.byId - a.byId) || (a.dist - b.dist));
  return cands[0] || null;
}
function badStatus(g) { return /CANCEL|POSTPON|SUSPEND|DELAY|ABANDON|FORFEIT/i.test(g.statusName); }
function gradeLeg(bet, s, games, now) {
  const mkt = String(s.mkt || 'ml').toLowerCase();
  const lg = leagueOf(s);
  if (s.result) return { r: s.result, why: 'already graded' };
  const per = periodOf(s);
  if (per === 'futures') return { r: null, why: 'futures bet: grade from the admin screen' };
  if (mkt === 'prop' || s.propPlayer) return { r: null, why: 'player prop: grade from the admin screen' };
  if (NOT_AUTO[lg]) return { r: null, why: NOT_AUTO[lg] + ' is not auto-graded: grade from the admin screen' };
  if (lg && !LEAGUES[lg]) return { r: null, why: 'league "' + lg + '" is not auto-graded: grade from the admin screen' };
  if (['ml', 'sp', 'tot'].indexOf(mkt) < 0) return { r: null, why: 'market "' + mkt + '" is not auto-graded' };
  const teams = teamsOf(s);
  if (!teams && !(s.gid && /^\d+$/.test(String(s.gid)))) return { r: null, why: 'ticket has no team names' };
  const hit = findGame(bet, s, lg, teams, games);
  if (!hit) {
    const a = anchorOf(bet, s);
    const start = (a.when && a.when.t) || null;
    if (start && now < start) return { r: null, why: 'game has not started' };
    if (games.failedLeagues && (lg ? games.failedLeagues.has(lg) : games.failedLeagues.size)) return { r: null, why: 'ESPN scores could not be loaded this run (will retry)' };
    return { r: null, why: 'no ESPN game found for "' + (teams ? teams.away + ' @ ' + teams.home : s.gid) + '"' + (lg ? ' (' + lg + ')' : '') };
  }
  const g = hit.g;
  if (badStatus(g)) return { r: null, why: 'game ' + g.statusName.replace('STATUS_', '').toLowerCase() + ': grade or cancel from the admin screen' };
  if (!g.completed) return { r: null, why: g.state === 'in' ? 'game in progress' : 'game not final yet' };
  if (isSoccer(g.league) && /AET|PEN|EXTRA|SHOOTOUT/i.test(g.statusName)) return { r: null, why: 'soccer game went to extra time/penalties: grade from the admin screen' };
  // the ticket's home/away, mapped onto ESPN's (neutral sites can be listed the other way round)
  const tHome = hit.flip ? g.away : g.home, tAway = hit.flip ? g.home : g.away;
  if (isFight(g.league)) {
    if (mkt !== 'ml') return { r: null, why: 'fight market "' + mkt + '" is not auto-graded' };
    const side = String(s.side || '').toLowerCase();
    const pick = side === 'h' ? tHome : side === 'a' ? tAway : null;
    if (!pick) return { r: null, why: 'fight pick has no side' };
    if (!tHome.winner && !tAway.winner) return { r: null, why: 'fight has no winner (draw / no contest): grade from the admin screen' };
    return { r: pick.winner ? 'won' : 'lost', why: 'fight result' };
  }
  let hs = tHome.score, as = tAway.score;
  if (per) {
    const n = per === 'f5' ? 5 : per === 'h1' ? (/college-basketball/.test(LEAGUES[g.league]) ? 1 : 2) : 1;
    if (per === 'h1' && /hockey|soccer|baseball/.test(LEAGUES[g.league])) return { r: null, why: '1st-half bet in this sport: grade from the admin screen' };
    if (tHome.lines.length < n || tAway.lines.length < n) return { r: null, why: 'no period scores yet for ' + per };
    hs = tHome.lines.slice(0, n).reduce((x, y) => x + y, 0);
    as = tAway.lines.slice(0, n).reduce((x, y) => x + y, 0);
  }
  if (!Number.isFinite(hs) || !Number.isFinite(as)) return { r: null, why: 'ESPN has no score' };
  const side = String(s.side || '').toLowerCase();
  if (mkt === 'ml') {
    if (side === 'd' || /\bdraw\b/i.test(String(s.label || '').split('·').pop())) return { r: hs === as ? 'won' : 'lost', why: 'draw pick' };
    if (side !== 'h' && side !== 'a') return { r: null, why: 'moneyline pick has no side' };
    if (hs === as) {
      if (isSoccer(g.league)) return { r: 'lost', why: 'soccer draw (3-way moneyline)' };
      // OWNER RULE (Oct 21): an NFL or NHL game that ends tied makes a moneyline on EITHER team a loss.
      // Full-game moneylines only (also when the leg is part of a parlay). Spreads/totals on the number stay a push.
      if (!per && TIE_LOSES_ML[g.league]) return { r: 'lost', why: 'tie: house rule, ' + g.league.toUpperCase() + ' moneyline loses on a tie' };
      return { r: 'push', why: 'tie' };
    }
    return { r: (side === 'h' ? hs > as : as > hs) ? 'won' : 'lost', why: 'final ' + as + '-' + hs };
  }
  if (mkt === 'sp') {
    if (side !== 'h' && side !== 'a') return { r: null, why: 'spread pick has no side' };
    const L = spreadLine(s);
    if (!L || !Number.isFinite(L.line)) return { r: null, why: 'spread line missing on ticket' };
    const adj = (side === 'h' ? hs - as : as - hs) + L.line;   // pick's own line, e.g. -3.5 for a favourite
    return { r: Math.abs(adj) < 1e-9 ? 'push' : adj > 0 ? 'won' : 'lost', why: 'final ' + as + '-' + hs + ' line ' + L.line + ' (' + L.from + ')' };
  }
  const L = totalLine(s);
  const ou = overUnder(s);
  if (!L || !Number.isFinite(L.line)) return { r: null, why: 'total line missing on ticket' };
  if (!ou) return { r: null, why: 'total pick has no over/under' };
  const tot = hs + as;
  return { r: tot === L.line ? 'push' : ((ou === 'o' ? tot > L.line : tot < L.line) ? 'won' : 'lost'), why: 'total ' + tot + ' line ' + L.line };
}
function decide(bet, games, now) {
  // ONLY open tickets are ever looked at. Won / lost / push / cancelled tickets, including ones an
  // admin forced or overrode, are returned untouched (null) and never re-graded.
  if (!bet || bet.status !== 'open' || !Array.isArray(bet.selections) || !bet.selections.length) return null;
  const legs = bet.selections.map(s => gradeLeg(bet, s, games, now || Date.now()));
  const results = legs.map(x => x.r);
  let status = null;
  if (results.indexOf('lost') >= 0) status = 'lost';
  else if (results.every(Boolean)) status = results.indexOf('won') >= 0 ? 'won' : 'push';
  const legChanges = results.some((r, i) => r && r !== bet.selections[i].result);
  return { status, results, legs, changed: !!status || legChanges };
}

// Which (league, ESPN date) pairs the open tickets need.
function needsFor(st, now) {
  const needs = {};
  const add = (lg, t) => { const d = easternYmd(new Date(t)).replace(/-/g, ''); (needs[lg] = needs[lg] || new Set()).add(d); };
  Object.keys(st.bets || {}).forEach(id => (st.bets[id] || []).forEach(bet => {
    if (!bet || bet.status !== 'open') return;
    (bet.selections || []).forEach(s => {
      if (s.result) return;
      const a = anchorOf(bet, s);
      let t = a.when && a.when.t;
      if (!t && a.when && a.when.dateOnly) t = Date.parse(a.when.dateOnly + 'T18:00:00Z');
      if (!t) t = a.placed;
      if (!t || t > now + 2 * 3600e3 || t < now - 21 * 864e5) return;   // not started yet, or very old
      let lg = leagueOf(s);
      const lgs = LEAGUES[lg] ? [lg] : (lg ? [] : ['nfl', 'ncaaf', 'nba', 'nhl', 'mlb']);
      lgs.forEach(l => [-1, 0, 1].forEach(k => { const x = t + k * 864e5; if (x <= now + 864e5) add(l, x); }));
    });
  }));
  Object.keys(needs).forEach(k => { needs[k] = Array.from(needs[k]).sort(); });
  return needs;
}

// The whole run. dryRun = report only, write nothing.
async function runGrade(store, opts) {
  opts = opts || {};
  const t0 = Date.now();
  const now = opts.now || Date.now();
  const first = (await B.readState(store)).st;
  const needs = needsFor(first, now);
  const { games, errors, calls } = await loadBoards(needs, opts.fetchImpl, t0 + (opts.budgetMs || BUDGET_MS));
  const report = { at: new Date(now).toISOString(), calls, games: games.length, finals: games.filter(g => g.completed).length, errors: errors.slice(0, 20), graded: 0, changes: [], waiting: [] };
  const apply = st => {
    report.graded = 0; report.changes = []; report.waiting = [];
    Object.keys(st.bets || {}).forEach(id => (st.bets[id] || []).forEach(bet => {
      const d = decide(bet, games, now);
      if (!d) return;
      if (d.changed) {
        report.changes.push({ user: id, bet: bet.id, status: d.status || 'open', legs: d.legs.map(x => x.r || '-').join(',') });
        if (!opts.dryRun) {
          d.results.forEach((r, i) => { if (r) bet.selections[i].result = r; });
          if (d.status) {
            bet.status = d.status;
            bet.settledAt = new Date(now).toISOString();
            st.balanceLog = (st.balanceLog || []).concat([{ at: bet.settledAt, user: id, bet: bet.id, status: bet.status, amount: Math.round(B.ticketNet(bet) * 100) / 100, by: opts.by || 'grader' }]).slice(-200);
          }
          bet.rev = Number(bet.rev || 1) + 1; bet.updatedBy = opts.by || 'grader';
        }
        if (d.status) report.graded++;
      }
      if (!d.status) {
        // still open: explain why, once the game should be over
        const late = bet.selections.some(s => {
          const a = anchorOf(bet, s); const lg = leagueOf(s);
          const t = (a.when && a.when.t) || (a.when && a.when.dateOnly ? Date.parse(a.when.dateOnly + 'T23:59:00Z') : null) || (a.placed ? a.placed + 3 * 3600e3 : null);
          return t ? now > t + (GAME_HOURS[lg] || 3) * 3600e3 : false;
        });
        if (late) report.waiting.push({ user: id, bet: bet.id, reasons: d.legs.map((x, i) => (x.r ? null : (teamsOf(bet.selections[i]) ? teamsOf(bet.selections[i]).away + ' @ ' + teamsOf(bet.selections[i]).home : 'leg ' + (i + 1)) + ': ' + x.why)).filter(Boolean) });
      }
    }));
    report.waiting = report.waiting.slice(0, 60);
    report.ms = Date.now() - t0;
    if (opts.dryRun) return { noWrite: true };
    st.grader = { at: report.at, graded: report.graded, finals: report.finals, calls: report.calls, errors: report.errors.length, waiting: report.waiting, ms: report.ms, by: opts.by || 'grader' };
    return {};
  };
  if (opts.dryRun) apply(first);
  else await B.mutate(store, apply);   // decided again on the freshest copy of every ticket
  return report;
}

exports.handler = async (event) => {
  try {
    const store = await B.getStore(event);
    const r = await runGrade(store, {});
    console.log('grade', JSON.stringify({ graded: r.graded, finals: r.finals, calls: r.calls, ms: r.ms, waiting: r.waiting.length, errors: r.errors }));
    return B.reply(200, { ok: true, graded: r.graded, finals: r.finals, calls: r.calls, ms: r.ms });
  } catch (e) {
    console.log('grade error', String(e && e.stack || e));
    return B.reply(500, { error: 'grade failed' });
  }
};
exports.runGrade = runGrade;
exports.NOW_BUDGET_MS = NOW_BUDGET_MS;
exports._test = { decide, gradeLeg, findGame, teamMatch, norm, spreadLine, totalLine, teamsOf, leagueOf, periodOf, parseWhen, needsFor, loadBoards, parseBoard, LEAGUES };
