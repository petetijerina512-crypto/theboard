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
// v1119 (all bets grade automatically where ESPN has the data; see report for the rules):
//  - tennis (ATP + WTA singles) match winner; retired / walkover = void (push)
//  - UFC / PFL draws and no-contests = void, read from ESPN's fight status (never guessed)
//  - soccer that went to extra time / penalties: graded on the 90 minutes (+ stoppage) score
//  - soccer 1st half, team totals, 1st-half totals / team totals
//  - player props from the ESPN box score (did-not-play = void when ESPN says so)
//  - Super Bowl and college football national title futures once ESPN shows the champion
//  - boxing stays manual: ESPN has no boxing results feed
// v1120 (no guessing on names):
//  - a ticket team matches an ESPN team only when the whole name is the same (after accents,
//    punctuation and the alias list): never a shared word or a part of the name. "Western Michigan"
//    is not "Michigan", "Kansas State" is not "Kansas", nicknames alone ("Tigers") never match.
//  - the ESPN game must be on the leg's game day (Central time); more than one qualifying game = wait
//  - props: the player's full name must be identical (no last name + initial), one athlete only;
//    "not in the box score" is a void only when nobody with that last name is listed either
//  - futures: Won only on an exact champion match; Lost only when the names share nothing
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
  ligaarg: 'soccer/arg.1', superlig: 'soccer/tur.1',
  tennis_atp: 'tennis/atp', tennis_wta: 'tennis/wta'
};
// one ticket "sport" that is looked up in more than one ESPN feed
const GROUPS = { tennis: ['tennis_atp', 'tennis_wta'] };
const inGroup = (lg, g) => (GROUPS[lg] ? GROUPS[lg].indexOf(g) >= 0 : g === lg);
const EXTRA = { ncaaf: '&groups=80&limit=400', ncaab: '&groups=50&limit=400', ncaaw: '&limit=400' };
const NOT_AUTO = { boxing: 'Boxing (ESPN has no boxing results feed)' };
// Leagues where a tied game makes a full-game moneyline bet a LOSS (owner decision, Oct 21 2026).
const TIE_LOSES_ML = { nfl: 1, nhl: 1 };
const isSoccer = k => /^soccer\//.test(LEAGUES[k] || '');
const isFight = k => k === 'mma' || k === 'pfl';
const isTennis = k => k === 'tennis' || k === 'tennis_atp' || k === 'tennis_wta';
const SUMMARY_PATH = k => LEAGUES[k];
// label prefixes the phone writes, e.g. "NFL · Bears @ Lions · ..."
const PREFIX = {
  nfl: 'nfl', ncaaf: 'ncaaf', 'ncaa football': 'ncaaf', cfb: 'ncaaf', cfl: 'cfl', nba: 'nba', wnba: 'wnba',
  ncaab: 'ncaab', 'ncaa basketball': 'ncaab', ncaaw: 'ncaaw', 'ncaa wbb': 'ncaaw', nhl: 'nhl', mlb: 'mlb',
  ufc: 'mma', mma: 'mma', 'ufc / mma': 'mma', pfl: 'pfl', ucl: 'ucl', 'champions league': 'ucl', uel: 'uel',
  'europa league': 'uel', epl: 'epl', 'premier league': 'epl', mls: 'mls', 'la liga': 'laliga', laliga: 'laliga',
  'serie a': 'seriea', bundesliga: 'bundesliga', 'ligue 1': 'ligue1', 'liga mx': 'ligamx', tennis: 'tennis', boxing: 'boxing'
};
// Whole-game length guesses, used only to decide when an open ticket counts as "late".
const GAME_HOURS = { nfl: 4, ncaaf: 4.5, cfl: 4, mlb: 4, nhl: 3.5, mma: 7, pfl: 7, boxing: 7, tennis: 5, tennis_atp: 5, tennis_wta: 5 };
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
  [/\bst\.\s/g, 'st '], [/\bpenn st\b/g, 'penn state'], [/\bsam houston state\b/g, 'sam houston'], [/\bole miss\b/g, 'ole miss'], [/\butsa\b/g, 'utsa'],
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
  for (let pass = 0; pass < 2; pass++) ALIAS.forEach(([re, to]) => { x = x.replace(re, to); });   // 2nd pass: PSG -> paris saint germain -> paris st germain
  return x.replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
}
const toks = s => norm(s).split(' ').filter(w => w && !STOP[w]);
// (1120) Does the ticket's team name refer to this ESPN team? Only when the WHOLE name is one of
// ESPN's exact names for it (full name, short name, location + nickname, location, abbreviation).
// Never a subset / shared word: "Western Michigan Broncos" is not "Michigan", "LSU Tigers" is not "Auburn Tigers".
const key = s => toks(s).join(' ');
function teamMatch(name, team) {
  const T = key(name);
  if (!T || !team) return false;
  return (team.keys || team.names.map(key)).indexOf(T) >= 0;
}
// any shared significant word (used only to refuse a "Lost" on a futures ticket whose name is close)
const GENERIC = { state: 1, st: 1, college: 1, tech: 1, and: 1, north: 1, south: 1, east: 1, west: 1, central: 1, northern: 1, southern: 1, eastern: 1, western: 1 };
function sharesWord(name, team) {
  const T = toks(name).filter(w => w.length >= 3 && !GENERIC[w]);
  return !!team && team.names.some(v => toks(v).some(w => T.indexOf(w) >= 0));
}

function lastMatch(name, team) {
  const T = toks(name); if (!T.length || !team) return false;
  const last = T[T.length - 1];
  return last.length >= 3 && team.names.some(v => { const V = toks(v); return V.length && V[V.length - 1] === last; });
}

// ---------- the ticket side ----------
function leagueOf(s) {
  const sp = String(s.sport || '').toLowerCase().trim();
  if (sp) return (LEAGUES[sp] || NOT_AUTO[sp] || GROUPS[sp]) ? sp : (PREFIX[sp] || sp);
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
  const names = [t.displayName, t.shortDisplayName, (t.location && t.name) ? t.location + ' ' + t.name : '', t.location, t.abbreviation && String(t.abbreviation).length >= 2 ? t.abbreviation : '', a.displayName, a.fullName]
    .filter(Boolean);
  const keys = Array.from(new Set(names.map(key).filter(Boolean)));
  return {
    names, keys, label: t.displayName || a.displayName || '',
    score: c.score != null && c.score !== '' ? Number(c.score) : null,
    lines: (c.linescores || []).map(x => Number(x.value != null ? x.value : x.displayValue)),
    winner: c.winner === true
  };
}
function parseBoard(data, league) {
  const out = [];
  (data.events || []).forEach(ev => {
    // tennis: one event per tournament, matches sit in groupings (singles only; doubles are never offered)
    const comps = isTennis(league) ? [].concat.apply([], (ev.groupings || []).filter(gr => /singles/i.test(String((gr.grouping || {}).slug || ''))).map(gr => gr.competitions || []))
      : isFight(league) ? (ev.competitions || []) : (ev.competitions || []).slice(0, 1);
    comps.forEach(c => {
      const st = (c.status && c.status.type) || (ev.status && ev.status.type) || {};
      const cs = c.competitors || [];
      let home = cs.find(x => x.homeAway === 'home'), away = cs.find(x => x.homeAway === 'away');
      if (!home || !away) { home = cs[0]; away = cs[1]; }
      if (!home || !away) return;
      out.push({
        league, id: String(isFight(league) || isTennis(league) ? (c.id || ev.id) : ev.id), eventId: String(ev.id || ''), date: c.date || ev.date || '',
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
  const pool = games.filter(g => (!lg || inGroup(lg, g.league)));
  const cands = [];
  pool.forEach(g => {
    const byId = !!s.gid && String(s.gid) === g.id;
    let flip = null;
    if (teams) {
      if (teamMatch(teams.away, g.away) && teamMatch(teams.home, g.home)) flip = false;
      else if (teamMatch(teams.away, g.home) && teamMatch(teams.home, g.away)) flip = true;
    }
    if (teams && flip === null && (isFight(g.league) || isTennis(g.league))) {
      // fighters / tennis players: last names are enough when BOTH match ("Timothy" vs "Timmy" Cuamba)
      if (lastMatch(teams.away, g.away) && lastMatch(teams.home, g.home)) flip = false;
      else if (lastMatch(teams.away, g.home) && lastMatch(teams.home, g.away)) flip = true;
    }
    if (!byId && flip === null) return;
    const start = Date.parse(g.date) || null;
    if (start && placed && placed > start + 5 * 3600e3) return;          // placed long after this game began
    // date-only values were saved in Chicago, Eastern or UTC terms depending on the phone/version
    if (when && when.dateOnly && start && [chicagoYmd(new Date(start)), easternYmd(new Date(start)), new Date(start).toISOString().slice(0, 10)].indexOf(when.dateOnly) < 0) return;
    if (when && when.t && start && Math.abs(start - when.t) > 36 * 3600e3) return; // a different game of a series
    // (1120) team sports: the ESPN game must be on the leg's game day, Central time (tennis / fights keep the
    // wider window: their start times are estimates, and both player names must match anyway)
    if (!byId && when && when.t && start && !isTennis(g.league) && !isFight(g.league) && chicagoYmd(new Date(start)) !== chicagoYmd(new Date(when.t))) return;
    const ref = (when && when.t) || placed || start;
    cands.push({ g, flip: !!flip, dist: start && ref ? Math.abs(start - ref) : 0, byId });
  });
  cands.sort((a, b) => (b.byId - a.byId) || (a.dist - b.dist));
  if (!cands.length) return null;
  if (cands[0].byId) return cands[0];
  // (1120) more than one ESPN game fits: take the nearest only when it is clearly the one (a doubleheader's
  // other game starts hours away); otherwise wait for the admin instead of guessing
  const others = cands.filter(c => c.g.id !== cands[0].g.id);
  if (others.length) {
    const gap = others[0].dist - cands[0].dist;
    const clear = (when && when.t) ? (cands[0].dist <= 2 * 3600e3 && gap >= 3 * 3600e3)   // leg start time known
      : gap >= 12 * 3600e3;   // no start time on the leg: the next game after the bet, when the other one is a day away
    if (!clear) return null;
  }
  return cands[0];
}
function badStatus(g) { return /CANCEL|POSTPON|SUSPEND|DELAY|ABANDON|FORFEIT/i.test(g.statusName); }

// ---------- player props (ESPN box score) ----------
// market -> [box-score group, stat key(s)]; several keys are added together.
const PROP_STATS = {
  player_pass_yds: [['passing'], ['passingYards']],
  player_pass_tds: [['passing'], ['passingTouchdowns']],
  player_pass_completions: [['passing'], ['completions']],
  player_pass_interceptions: [['passing'], ['interceptions']],
  player_rush_yds: [['rushing'], ['rushingYards']],
  player_receptions: [['receiving'], ['receptions']],
  player_anytime_td: [['rushing', 'receiving', 'kickReturns', 'puntReturns', 'defensive'], ['rushingTouchdowns', 'receivingTouchdowns', 'kickReturnTouchdowns', 'puntReturnTouchdowns', 'defensiveTouchdowns']],
  player_points: [[''], ['points']],
  player_rebounds: [[''], ['rebounds']],
  player_assists: [['', 'forwards', 'defenses', 'skaters'], ['assists']],
  player_goals: [['forwards', 'defenses', 'skaters'], ['goals']],
  player_shots_on_goal: [['forwards', 'defenses', 'skaters'], ['shotsTotal']],
  batter_hits: [['batting'], ['hits']],
  batter_home_runs: [['batting'], ['homeRuns']],
  pitcher_strikeouts: [['pitching'], ['strikeouts']]
};
// Sports where a player missing from ESPN's box score means he did not play (only players who
// appeared are listed). NFL/college football list a player only when he has a stat, so missing
// there is NOT proof he sat: that goes to the admin.
const ABSENT_MEANS_DNP = { nhl: 1, mlb: 1 };
// (1120) the same person only when the full name is identical after dropping accents, dots and
// Jr / Sr / II / III ("D.J. Moore" = "DJ Moore"). Never last name + first initial.
function personToks(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[.’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w && !/^(jr|sr|ii|iii|iv|v)$/.test(w));
}
function samePerson(a, b) {
  const A = personToks(a), Bt = personToks(b);
  return A.length >= 2 && Bt.length >= 2 && A.join(' ') === Bt.join(' ');
}
function sameLastName(a, b) {
  const A = personToks(a), Bt = personToks(b);
  return A.length >= 1 && Bt.length >= 1 && A[A.length - 1] === Bt[Bt.length - 1];
}
function cellValue(keys, stats, key) {
  for (let i = 0; i < keys.length; i++) {
    const parts = String(keys[i]).split(/[\/-]/);
    const k = parts.indexOf(key);
    if (k < 0) continue;
    const cell = String(stats[i] == null ? '' : stats[i]).split(/[\/-]/);
    const v = parts.length > 1 ? cell[k] : stats[i];
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return undefined;   // key not in this group
}
// -> { stat } | { dnp: true } | { missing: 'why' }
function propStat(summary, player, market, league) {
  const spec = PROP_STATS[market];
  if (!spec) return { missing: 'prop market "' + market + '" is not auto-graded' };
  const box = (summary && summary.boxscore && summary.boxscore.players) || [];
  if (!box.length) return { missing: 'ESPN has no box score for this game yet' };
  const rows = []; const lookalikes = new Set();
  box.forEach(team => (team.statistics || []).forEach(grp => (grp.athletes || []).forEach(a => {
    const who = a.athlete && (a.athlete.displayName || a.athlete.fullName);
    const pid = String((a.athlete && a.athlete.id) || who) + '|' + String((team.team && team.team.id) || '');
    if (samePerson(who, player)) rows.push({ who, pid, grp: String(grp.name || grp.type || ''), keys: grp.keys || [], a });
    else if (sameLastName(who, player)) lookalikes.add(who);
  })));
  // (1120) two different athletes with this name (e.g. one on each team) -> the admin decides
  const people = Array.from(new Set(rows.map(r => r.pid)));
  if (people.length > 1) return { missing: 'more than one player matches "' + player + '" (' + Array.from(new Set(rows.map(r => r.who))).join(', ') + ')' };
  if (!rows.length) {
    // "not listed = did not play" only when nobody with that last name is listed (a spelling difference is not a DNP)
    if (lookalikes.size) return { missing: player + ' is not in the ESPN box score by exact name (listed: ' + Array.from(lookalikes).join(', ') + ')' };
    if (ABSENT_MEANS_DNP[league]) return { dnp: true };
    return { missing: player + ' is not in the ESPN box score (did he play?)' };
  }
  if (rows.every(r => r.a.didNotPlay === true)) return { dnp: true };
  let total = null;
  spec[1].forEach(key => rows.forEach(r => {
    if (spec[0].indexOf(r.grp) < 0 && !(spec[0][0] === '' && r.grp === '')) return;
    const v = cellValue(r.keys, r.a.stats || [], key);
    if (v === undefined) return;
    if (v === null) return;
    total = (total || 0) + v;
  }));
  if (total === null) {
    // listed but no number in the needed group: hockey/baseball/basketball -> he played and did not record it
    if (market === 'pitcher_strikeouts' && !rows.some(r => r.grp === 'pitching')) return { dnp: true };   // never pitched
    if (/^(nba|wnba|ncaab|ncaaw|nhl|mlb)$/.test(league)) return { stat: 0 };
    if (market === 'player_anytime_td') return { stat: 0 };   // in the box score, no touchdown
    return { missing: 'no ' + market.replace(/^player_|^batter_|^pitcher_/, '').replace(/_/g, ' ') + ' stat for ' + player + ' in the box score' };
  }
  return { stat: total };
}
function gradeProp(s, g, lg) {
  if (!g.summary) return { r: null, why: 'loading ESPN box score', need: 'summary' };
  if (g.summary.failed) return { r: null, why: 'ESPN box score could not be loaded (will retry)' };
  const market = String(s.propMarket || '');
  const ps = propStat(g.summary, s.propPlayer || '', market, g.league);
  if (ps.missing) return { r: null, why: 'prop: ' + ps.missing };
  if (ps.dnp) return { r: 'push', why: 'prop void: ' + s.propPlayer + ' did not play' };
  const side = String(s.side || '').toLowerCase();
  const line = s.currentTotal != null && s.currentTotal !== '' ? Number(s.currentTotal) : (s.baseTotal != null ? Number(s.baseTotal) : null);
  if (side === 'yes' || (market === 'player_anytime_td' && !Number.isFinite(line))) return { r: ps.stat >= 1 ? 'won' : 'lost', why: 'prop ' + s.propPlayer + ' ' + ps.stat };
  if (!Number.isFinite(line)) return { r: null, why: 'prop line missing on ticket' };
  if (side !== 'o' && side !== 'u') return { r: null, why: 'prop pick has no over/under' };
  if (Math.abs(ps.stat - line) < 1e-9) return { r: 'push', why: 'prop ' + s.propPlayer + ' ' + ps.stat + ' on the line' };
  return { r: (side === 'o' ? ps.stat > line : ps.stat < line) ? 'won' : 'lost', why: 'prop ' + s.propPlayer + ' ' + ps.stat + ' line ' + line };
}

// ---------- futures (champion) ----------
const FUTURES = {
  nfl: { name: 'Super Bowl', url: y => 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=3&week=5&dates=' + y, month: 2, day: 20 },
  ncaaf: { name: 'national title game', url: y => 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?seasontype=3&week=1&groups=80&limit=400&dates=' + y, month: 1, day: 31 }
};
// season a futures ticket belongs to: placed March-December -> that year; January-February -> the year before
function futSeason(bet) { const t = Date.parse(bet.time || '') || 0; const d = new Date(t); return d.getUTCMonth() >= 2 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; }
function futSport(s) { const sp = String(s.sport || '').toLowerCase() || String(s.gid || '').replace(/^futures-/, ''); return FUTURES[sp] ? sp : ''; }
function futPick(s) { return String(s.matchup || s.label || '').split(/\s+to win\s+/i)[0].trim(); }
// when the title game should be over: after this, an ungraded futures ticket is "late"
function futDue(bet, s) { const sp = futSport(s); if (!sp) return null; const y = futSeason(bet) + 1; return Date.UTC(y, FUTURES[sp].month - 1, FUTURES[sp].day); }
function parseChampion(data, sp) {
  let evs = (data && data.events) || [];
  if (sp === 'ncaaf') evs = evs.filter(e => /national championship/i.test(JSON.stringify(((e.competitions || [])[0] || {}).notes || [])));
  if (evs.length !== 1) return null;
  const c = (evs[0].competitions || [])[0] || {};
  const st = (c.status && c.status.type) || {};
  if (st.completed !== true || badStatus({ statusName: String(st.name || '') })) return null;
  const w = (c.competitors || []).find(x => x.winner === true);
  if (!w) return null;
  return { date: c.date || evs[0].date, team: teamInfo(w) };
}
function gradeFutures(bet, s, champs, now) {
  const sp = futSport(s);
  if (!sp) return { r: null, why: 'futures market not auto-graded (only Super Bowl / college football title)' };
  const season = futSeason(bet);
  const ch = champs && champs[sp + ':' + season];
  if (!ch) return { r: null, why: FUTURES[sp].name + ' ' + (season + 1) + ' not decided yet' };
  if (ch.failed) return { r: null, why: 'ESPN champion could not be loaded (will retry)' };
  const pick = futPick(s);
  if (!pick) return { r: null, why: 'futures ticket has no team name' };
  if (teamMatch(pick, ch.team)) return { r: 'won', why: 'champion ' + ch.team.label };
  // (1120) a Lost needs names that share nothing; anything close ("Texas" vs "Texas Tech") goes to the admin
  if (lastMatch(pick, ch.team) || sharesWord(pick, ch.team)) return { r: null, why: 'futures pick "' + pick + '" vs champion ' + ch.team.label + ': names too close to call' };
  return { r: 'lost', why: 'champion ' + ch.team.label };
}

// regulation (two halves) or first-half score for soccer, from the ESPN game summary
function soccerScore(g, tHome, halves) {
  const comp = g.summary && g.summary.header && (g.summary.header.competitions || [])[0];
  const cs = (comp && comp.competitors) || [];
  const pick = t => cs.find(c => c.team && teamMatch(t.label, { names: [c.team.displayName, c.team.shortDisplayName, c.team.name, c.team.location].filter(Boolean) }));
  const H = pick(tHome);
  const A = cs.find(c => c !== H);
  if (!H || !A) return null;
  const sum = c => { const l = (c.linescores || []).map(x => Number(x.displayValue != null ? x.displayValue : x.value)); return l.length >= halves && l.slice(0, halves).every(Number.isFinite) ? l.slice(0, halves).reduce((a, b) => a + b, 0) : null; };
  const hs = sum(H), as = sum(A);
  return hs == null || as == null ? null : { hs, as };
}

function gradeLeg(bet, s, games, now) {
  const mkt = String(s.mkt || 'ml').toLowerCase();
  const lg = leagueOf(s);
  if (s.result) return { r: s.result, why: 'already graded' };
  const per0 = periodOf(s);
  if (per0 === 'futures' || /^futures-/.test(String(s.gid || ''))) return gradeFutures(bet, s, games.champions, now);
  const isProp = mkt === 'prop' || !!s.propPlayer;
  if (NOT_AUTO[lg]) return { r: null, why: NOT_AUTO[lg] + ': grade from the admin screen' };
  if (lg && !LEAGUES[lg] && !GROUPS[lg]) return { r: null, why: 'league "' + lg + '" is not auto-graded: grade from the admin screen' };
  if (!isProp && ['ml', 'sp', 'tot', 'tt', 'h1tot', 'h1tt'].indexOf(mkt) < 0) return { r: null, why: 'market "' + mkt + '" is not auto-graded' };
  // 1st-half game total / team total markets are 1st-half bets whatever the label says
  const per = (mkt === 'h1tot' || mkt === 'h1tt') ? 'h1' : per0;
  const teams = teamsOf(s);
  if (!teams && !(s.gid && /^\d+$/.test(String(s.gid)))) return { r: null, why: 'ticket has no team names' };
  const hit = findGame(bet, s, lg, teams, games);
  if (!hit) {
    const a = anchorOf(bet, s);
    const start = (a.when && a.when.t) || null;
    if (start && now < start) return { r: null, why: 'game has not started' };
    const failed = games.failedLeagues && (lg ? (GROUPS[lg] || [lg]).some(x => games.failedLeagues.has(x)) : games.failedLeagues.size);
    if (failed) return { r: null, why: 'ESPN scores could not be loaded this run (will retry)' };
    return { r: null, why: 'no ESPN game found for "' + (teams ? teams.away + ' @ ' + teams.home : s.gid) + '"' + (lg ? ' (' + lg + ')' : '') };
  }
  const g = hit.g;
  if (badStatus(g)) return { r: null, why: 'game ' + g.statusName.replace('STATUS_', '').toLowerCase() + ': grade or cancel from the admin screen' };
  if (!g.completed) return { r: null, why: g.state === 'in' ? 'game in progress' : 'game not final yet' };
  // the ticket's home/away, mapped onto ESPN's (neutral sites can be listed the other way round)
  const tHome = hit.flip ? g.away : g.home, tAway = hit.flip ? g.home : g.away;
  const side = String(s.side || '').toLowerCase();
  if (isProp) return gradeProp(s, g, lg);
  if (isTennis(g.league)) {
    // Book rule: a match that is not completed (retirement, walkover) voids the match-winner bet.
    if (mkt !== 'ml') return { r: null, why: 'tennis market "' + mkt + '" is not auto-graded' };
    const pick = side === 'h' ? tHome : side === 'a' ? tAway : null;
    if (!pick) return { r: null, why: 'tennis pick has no side' };
    if (/RETIRED|WALKOVER|DEFAULT/i.test(g.statusName)) return { r: 'push', why: 'tennis void: match not completed (' + g.statusName.replace('STATUS_', '').toLowerCase() + ')' };
    if (!/STATUS_FINAL$/.test(g.statusName)) return { r: null, why: 'tennis status ' + g.statusName + ': grade from the admin screen' };
    if (!tHome.winner && !tAway.winner) return { r: null, why: 'tennis match final but ESPN shows no winner' };
    return { r: pick.winner ? 'won' : 'lost', why: 'match result' };
  }
  if (isFight(g.league)) {
    if (mkt !== 'ml') return { r: null, why: 'fight market "' + mkt + '" is not auto-graded' };
    const pick = side === 'h' ? tHome : side === 'a' ? tAway : null;
    if (!pick) return { r: null, why: 'fight pick has no side' };
    if (tHome.winner || tAway.winner) return { r: pick.winner ? 'won' : 'lost', why: 'fight result' };
    // no winner: only a draw or no contest that ESPN states in the fight's own status is voided
    if (!g.fightStatus) return { r: null, why: 'checking ESPN fight result (draw / no contest?)', need: 'fight' };
    const res = String(g.fightStatus.name || g.fightStatus.displayName || '');
    if (/draw|no.?contest|^nc$/i.test(res)) return { r: 'push', why: 'fight void: ' + res };
    return { r: null, why: 'fight has no winner' + (res ? ' (ESPN result "' + res + '")' : '') + ': grade from the admin screen' };
  }
  let hs = tHome.score, as = tAway.score;
  const soccer = isSoccer(g.league);
  const extra = soccer && /AET|PEN|EXTRA|SHOOTOUT/i.test(g.statusName);
  if (soccer && (extra || per)) {
    // Book rule: soccer bets are settled on 90 minutes plus stoppage time (no extra time, no penalties).
    if (per && per !== 'h1') return { r: null, why: 'soccer ' + per + ' bet: grade from the admin screen' };
    if (!g.summary) return { r: null, why: 'loading ESPN regulation score', need: 'summary' };
    const sc = soccerScore(g, tHome, per === 'h1' ? 1 : 2);
    if (!sc) return { r: null, why: 'ESPN has no ' + (per === 'h1' ? '1st-half' : 'regulation') + ' score for this soccer game' };
    hs = sc.hs; as = sc.as;
  } else if (per) {
    const n = per === 'f5' ? 5 : per === 'h1' ? (/college-basketball/.test(LEAGUES[g.league]) ? 1 : 2) : 1;
    if (per === 'h1' && /hockey|baseball/.test(LEAGUES[g.league])) return { r: null, why: '"1st half" bet in hockey/baseball is ambiguous: grade from the admin screen' };
    if (per === 'f5' && !/baseball/.test(LEAGUES[g.league])) return { r: null, why: 'first-5 bet outside baseball: grade from the admin screen' };
    if (per === 'p1' && !/hockey/.test(LEAGUES[g.league])) return { r: null, why: '1st-period bet outside hockey: grade from the admin screen' };
    if (tHome.lines.length < n || tAway.lines.length < n) return { r: null, why: 'no period scores yet for ' + per };
    hs = tHome.lines.slice(0, n).reduce((x, y) => x + y, 0);
    as = tAway.lines.slice(0, n).reduce((x, y) => x + y, 0);
  }
  if (!Number.isFinite(hs) || !Number.isFinite(as)) return { r: null, why: 'ESPN has no score' };
  if (mkt === 'ml') {
    if (side === 'd' || /\bdraw\b/i.test(String(s.label || '').split('·').pop())) return { r: hs === as ? 'won' : 'lost', why: 'draw pick' };
    if (side !== 'h' && side !== 'a') return { r: null, why: 'moneyline pick has no side' };
    if (hs === as) {
      if (soccer) return { r: 'lost', why: 'soccer draw' + (extra ? ' after 90 minutes' : '') + ' (house rule: team moneyline loses on a draw)' };
      // OWNER RULE (Oct 21): an NFL or NHL game that ends tied makes a moneyline on EITHER team a loss.
      // Full-game moneylines only (also when the leg is part of a parlay). Spreads/totals on the number stay a push.
      if (!per && TIE_LOSES_ML[g.league]) return { r: 'lost', why: 'tie: house rule, ' + g.league.toUpperCase() + ' moneyline loses on a tie' };
      return { r: 'push', why: 'tie' };
    }
    return { r: (side === 'h' ? hs > as : as > hs) ? 'won' : 'lost', why: 'final ' + as + '-' + hs + (extra ? ' after 90 minutes' : '') };
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
  let tot = hs + as;
  if (mkt === 'tt' || mkt === 'h1tt') {
    const t = String(s.team || '').toLowerCase();
    if (t !== 'h' && t !== 'a') return { r: null, why: 'team total has no team' };
    tot = t === 'h' ? hs : as;
  }
  return { r: Math.abs(tot - L.line) < 1e-9 ? 'push' : ((ou === 'o' ? tot > L.line : tot < L.line) ? 'won' : 'lost'), why: (mkt === 'tt' || mkt === 'h1tt' ? 'team ' : '') + 'total ' + tot + ' line ' + L.line };
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
      if (periodOf(s) === 'futures' || /^futures-/.test(String(s.gid || ''))) return;   // champions are loaded separately
      const a = anchorOf(bet, s);
      let t = a.when && a.when.t;
      if (!t && a.when && a.when.dateOnly) t = Date.parse(a.when.dateOnly + 'T18:00:00Z');
      if (!t) t = a.placed;
      if (!t || t > now + 2 * 3600e3 || t < now - 21 * 864e5) return;   // not started yet, or very old
      let lg = leagueOf(s);
      const lgs = GROUPS[lg] ? GROUPS[lg] : LEAGUES[lg] ? [lg] : (lg ? [] : ['nfl', 'ncaaf', 'nba', 'nhl', 'mlb']);
      lgs.forEach(l => [-1, 0, 1].forEach(k => { const x = t + k * 864e5; if (x <= now + 864e5) add(l, x); }));
    });
  }));
  Object.keys(needs).forEach(k => { needs[k] = Array.from(needs[k]).sort(); });
  return needs;
}

// Futures champions the open futures tickets need (only once the title game is due).
function futuresNeeds(st, now) {
  const out = new Set();
  Object.keys(st.bets || {}).forEach(id => (st.bets[id] || []).forEach(bet => {
    if (!bet || bet.status !== 'open') return;
    (bet.selections || []).forEach(s => {
      if (s.result || !(periodOf(s) === 'futures' || /^futures-/.test(String(s.gid || '')))) return;
      const sp = futSport(s); if (!sp) return;
      const season = futSeason(bet);
      // from January of the next year (title games are in Jan/Feb) until it is graded
      if (now >= Date.UTC(season + 1, 0, 5)) out.add(sp + ':' + season);
    });
  }));
  return Array.from(out);
}
async function loadChampions(keys, fetchImpl, deadline) {
  const champs = {}; const errors = [];
  for (const k of keys) {
    const [sp, y] = k.split(':');
    if (Date.now() > deadline) { errors.push('futures ' + k + ': out of time'); continue; }
    try { const c = parseChampion(await fetchJson(FUTURES[sp].url(y), fetchImpl, Math.max(1000, Math.min(FETCH_TIMEOUT_MS, deadline - Date.now()))), sp); if (c) champs[k] = c; }
    catch (e) { champs[k] = { failed: true }; errors.push('futures ' + k + ': ' + String(e && e.message || e).slice(0, 80)); }
  }
  return { champs, errors, calls: keys.length };
}
// Box scores / soccer summaries / fight results that some legs need (second, smaller round of ESPN calls).
async function loadDetails(st, games, now, fetchImpl, deadline) {
  const want = new Map();
  Object.keys(st.bets || {}).forEach(id => (st.bets[id] || []).forEach(bet => {
    if (!bet || bet.status !== 'open' || !Array.isArray(bet.selections)) return;
    bet.selections.forEach(s => {
      const x = gradeLeg(bet, s, games, now);
      if (!x.need) return;
      const hit = findGame(bet, s, leagueOf(s), teamsOf(s), games);
      if (hit) want.set(x.need + ':' + hit.g.league + ':' + hit.g.id, { kind: x.need, g: hit.g });
    });
  }));
  const jobs = Array.from(want.values()).slice(0, 30);
  const errors = [];
  let i = 0;
  async function worker() {
    while (i < jobs.length) {
      const { kind, g } = jobs[i++];
      if (Date.now() > deadline) { errors.push(kind + ' ' + g.id + ': out of time'); continue; }
      const ms = Math.max(1000, Math.min(FETCH_TIMEOUT_MS, deadline - Date.now()));
      try {
        if (kind === 'summary') g.summary = await fetchJson('https://site.api.espn.com/apis/site/v2/sports/' + SUMMARY_PATH(g.league) + '/summary?event=' + g.eventId, fetchImpl, ms);
        else if (kind === 'fight') {
          const lgPath = LEAGUES[g.league].split('/')[1];
          const d = await fetchJson('https://sports.core.api.espn.com/v2/sports/mma/leagues/' + lgPath + '/events/' + g.eventId + '/competitions/' + g.id + '/status', fetchImpl, ms);
          g.fightStatus = (d && d.result) || { name: '' };
        }
      } catch (e) {
        if (kind === 'summary') g.summary = { failed: true };
        errors.push(kind + ' ' + g.id + ': ' + String(e && e.message || e).slice(0, 80));
      }
    }
  }
  await Promise.all([1, 2, 3, 4].map(worker));
  return { errors, calls: jobs.length };
}

// The whole run. dryRun = report only, write nothing.
async function runGrade(store, opts) {
  opts = opts || {};
  const t0 = Date.now();
  const now = opts.now || Date.now();
  const first = (await B.readState(store)).st;
  const needs = needsFor(first, now);
  const deadline = t0 + (opts.budgetMs || BUDGET_MS);
  const { games, errors, calls } = await loadBoards(needs, opts.fetchImpl, deadline);
  const fut = await loadChampions(futuresNeeds(first, now), opts.fetchImpl, deadline);
  games.champions = fut.champs;
  const det = await loadDetails(first, games, now, opts.fetchImpl, deadline);
  const allErrors = errors.concat(fut.errors, det.errors);
  const report = { at: new Date(now).toISOString(), calls: calls + fut.calls + det.calls, games: games.length, finals: games.filter(g => g.completed).length, errors: allErrors.slice(0, 20), graded: 0, changes: [], waiting: [] };
  const apply = st => {
    report.graded = 0; report.changes = []; report.waiting = [];
    Object.keys(st.bets || {}).forEach(id => (st.bets[id] || []).forEach(bet => {
      const d = decide(bet, games, now);
      if (!d) return;
      if (d.changed) {
        report.changes.push({ user: id, bet: bet.id, status: d.status || 'open', legs: d.legs.map(x => x.r || '-').join(','), why: d.legs.map(x => x.why).join(' | ') });
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
        const late = bet.selections.some((s, i) => {
          if ((d.legs[i] && d.legs[i].r) || s.result) return false;   // (1124) a graded leg is not what the ticket is waiting on
          const a = anchorOf(bet, s); const lg = leagueOf(s);
          if (periodOf(s) === 'futures' || /^futures-/.test(String(s.gid || ''))) { const due = futDue(bet, s); return due ? now > due : false; }
          const t = (a.when && a.when.t) || (a.when && a.when.dateOnly ? Date.parse(a.when.dateOnly + 'T23:59:00Z') : null) || (a.placed ? a.placed + 3 * 3600e3 : null);
          return t ? now > t + (GAME_HOURS[lg] || 3) * 3600e3 : false;
        });
        if (opts.dryRun) report.open = (report.open || []).concat([{ user: id, bet: bet.id, legs: d.legs.map(x => x.why) }]);
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
exports._test = { decide, gradeLeg, findGame, teamMatch, norm, spreadLine, totalLine, teamsOf, leagueOf, periodOf, parseWhen, needsFor, loadBoards, parseBoard, LEAGUES, propStat, parseChampion, gradeFutures, futuresNeeds, loadDetails, loadChampions, samePerson };
