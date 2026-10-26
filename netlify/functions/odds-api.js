const https = require('https');

const mem = global.__boardOddsApiMem || (global.__boardOddsApiMem = {});

const SPORT_MAP = {
  mlb: 'baseball_mlb',
  nfl: 'americanfootball_nfl',
  ncaaf: 'americanfootball_ncaaf',
  ncaab: 'basketball_ncaab',
  nba: 'basketball_nba',
  nhl: 'icehockey_nhl',
  wnba: 'basketball_wnba',
  cfl: 'americanfootball_cfl',
  mls: 'soccer_usa_mls',
  epl: 'soccer_epl',
  laliga: 'soccer_spain_la_liga',
  bundesliga: 'soccer_germany_bundesliga',
  seriea: 'soccer_italy_serie_a',
  ligue1: 'soccer_france_ligue_one',
  ucl: 'soccer_uefa_champs_league',
  uel: 'soccer_uefa_europa_league',
  ligamx: 'soccer_mexico_ligamx',
  facup: 'soccer_fa_cup',
  efl: 'soccer_efl_champ',
  ere: 'soccer_netherlands_eredivisie',
  liga_pt: 'soccer_portugal_primeira_liga',
  brazil: 'soccer_brazil_campeonato',
  ligaarg: 'soccer_argentina_primera_division',
  superlig: 'soccer_turkey_super_league',
  mma: 'mma_mixed_martial_arts',
  pfl: 'mma_mixed_martial_arts',
  boxing: 'boxing_boxing',
  tennis: 'tennis'
};


function tennisLabel(key) {
  return String(key || '')
    .replace(/^tennis_/, '')
    .replace(/_/g, ' ')
    .replace(/\batp\b/ig, 'ATP')
    .replace(/\bwta\b/ig, 'WTA')
    .replace(/\b\w/g, function (c) { return c.toUpperCase(); })
    .replace(/\bAtp\b/g, 'ATP')
    .replace(/\bWta\b/g, 'WTA');
}

async function activeTennisKeys(key) {
  const hit = mem['oddsapi:sports'];
  if (hit && hit.keys && Date.now() - hit.at < 30 * 60 * 1000) return hit.keys;
  const fallback = [
    'tennis_atp_china_open', 'tennis_wta_china_open',
    'tennis_atp_japan_open', 'tennis_wta_wuhan_open',
    'tennis_atp_shanghai_masters', 'tennis_wta_ningbo_open'
  ];
  try {
    const { json } = await getJson('https://api.the-odds-api.com/v4/sports?apiKey=' + encodeURIComponent(key));
    const keys = (Array.isArray(json) ? json : [])
      .map(s => s && s.key)
      .filter(k => /^tennis_(atp|wta)_/i.test(String(k || '')));
    const out = keys.length ? keys : fallback;
    mem['oddsapi:sports'] = { at: Date.now(), keys: out };
    return out;
  } catch (e) {
    return (hit && hit.keys) || fallback;
  }
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'TheBoard/1.0' } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { recordUsage(res.headers); resolve({ status: res.statusCode, json: JSON.parse(body), headers: res.headers }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}


function pickBook(event) {
  const books = event.bookmakers || [];
  const prefer = ['draftkings', 'fanduel', 'betmgm', 'caesars', 'bovada'];
  for (let i = 0; i < prefer.length; i++) {
    const hit = books.find(b => b.key === prefer[i]);
    if (hit) return hit;
  }
  return books[0] || null;
}

// (1128) when the book last updated one market (ms), falling back to the book's own last_update
function marketUpd(book, key) {
  if (!book) return null;
  const m = (book.markets || []).find(x => x.key === key);
  const t = Date.parse((m && m.last_update) || book.last_update || '');
  return isNaN(t) ? null : t;
}
function marketMap(book) {
  const out = {};
  (book.markets || []).forEach(m => {
    out[m.key] = m.outcomes || [];
  });
  return out;
}

function priceFor(outcomes, name) {
  const n = String(name || '').toLowerCase();
  const hit = (outcomes || []).find(o => String(o.name || '').toLowerCase() === n);
  return hit && hit.price != null ? Number(hit.price) : null;
}

function lineFor(outcomes, name) {
  const n = String(name || '').toLowerCase();
  const hit = (outcomes || []).find(o => String(o.name || '').toLowerCase() === n);
  return hit && hit.point != null ? Number(hit.point) : null;
}

function minTotal(sport) {
  if (sport === 'ncaaf' || sport === 'nfl' || sport === 'cfl') return 28;
  if (sport === 'nba' || sport === 'ncaab' || sport === 'wnba') return 90;
  if (sport === 'mlb') return 6.5;
  if (sport === 'nhl') return 4.5;
  if (sport === 'mls' || sport === 'epl' || sport === 'laliga' || sport === 'bundesliga' || sport === 'seriea' || sport === 'ligue1' || sport === 'ucl' || sport === 'uel' || sport === 'ligamx') return 1.75;
  return 0;
}
// (1128) The full-game total comes from ONE book, in the same order as spreads and moneylines
// (DraftKings, FanDuel, BetMGM, Caesars, Bovada, then any other): the first book with a real
// full-game total (at or above the sport's floor, so a mislabeled team / half total is skipped).
// It used to take the highest total from any book, so the number and its price could come from
// different books than the rest of the game.
const BOOK_ORDER = ['draftkings', 'fanduel', 'betmgm', 'caesars', 'bovada'];
function booksInOrder(event) {
  const books = (event.bookmakers || []).slice();
  const rank = b => { const i = BOOK_ORDER.indexOf(b.key); return i < 0 ? BOOK_ORDER.length : i; };
  return books.map((b, i) => [b, i]).sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1]).map(x => x[0]);
}
function fullGameTotals(event, sport) {
  const floor = minTotal(sport);
  for (const book of booksInOrder(event)) {
    const m = (book.markets || []).find(x => x.key === 'totals');
    if (!m) continue;
    const over = (m.outcomes || []).find(o => /^over$/i.test(o.name) && o.point != null);
    if (!over) continue;
    const pt = Number(over.point);
    if (isNaN(pt) || pt < floor) continue;
    const under = (m.outcomes || []).find(o => /^under$/i.test(o.name) && Number(o.point) === pt);
    return { point: pt, totO: over.price, totU: under && under.price != null ? under.price : null, book: book.key };
  }
  return null;
}


function ouLine(outcomes) {
  const over = (outcomes || []).find(o => /^over$/i.test(o.name));
  const under = (outcomes || []).find(o => /^under$/i.test(o.name));
  if (!over || over.point == null) return null;
  return { line: Number(over.point), over: over.price != null ? Number(over.price) : null, under: under && under.price != null ? Number(under.price) : null };
}
function teamLine(outcomes, team) {
  const want = String(team || '').toLowerCase();
  const mine = (outcomes || []).filter(o => String(o.description || '').toLowerCase() === want);
  return ouLine(mine);
}
function stamp(pack, upd) { if (pack) pack.upd = upd; return pack; }
function normalizeExtras(event) {
  const book = pickBook(event);
  if (!book) return null;
  const mk = marketMap(book);
  const home = event.home_team;
  const away = event.away_team;
  const extras = {
    h1: stamp(ouLine(mk.totals_h1), marketUpd(book, 'totals_h1')),
    ttH: stamp(teamLine(mk.team_totals, home), marketUpd(book, 'team_totals')),
    ttA: stamp(teamLine(mk.team_totals, away), marketUpd(book, 'team_totals')),
    h1H: stamp(teamLine(mk.team_totals_h1, home), marketUpd(book, 'team_totals_h1')),
    h1A: stamp(teamLine(mk.team_totals_h1, away), marketUpd(book, 'team_totals_h1'))
  };
  if (!extras.h1 && !extras.ttH && !extras.ttA && !extras.h1H && !extras.h1A) return null;
  return extras;
}

function normalizeProps(event) {
  const book = pickBook(event);
  if (!book) return [];
  const labels = {
    player_pass_yds: 'Pass Yds', player_rush_yds: 'Rush Yds', player_receptions: 'Receptions',
    player_anytime_td: 'Anytime TD', player_pass_tds: 'Pass TDs',
    player_points: 'Points', player_rebounds: 'Rebounds', player_assists: 'Assists',
    player_goals: 'Goals', player_shots_on_goal: 'Shots',
    batter_hits: 'Hits', batter_home_runs: 'Home Runs', pitcher_strikeouts: 'Strikeouts'
  };
  const out = [];
  (book.markets || []).forEach(m => {
    if (!m || !m.key || m.key.indexOf('alternate') >= 0) return;
    if (!labels[m.key]) return;
    const byPlayer = {};
    (m.outcomes || []).forEach(o => {
      const player = String(o.description || '').trim();
      if (!player) return;
      if (!byPlayer[player]) byPlayer[player] = { player: player, market: m.key, label: labels[m.key], line: o.point != null ? Number(o.point) : null, over: null, under: null, yes: null };
      const rec = byPlayer[player];
      if (o.point != null) rec.line = Number(o.point);
      if (/^over$/i.test(o.name)) rec.over = o.price != null ? Number(o.price) : null;
      else if (/^under$/i.test(o.name)) rec.under = o.price != null ? Number(o.price) : null;
      else rec.yes = o.price != null ? Number(o.price) : null;
    });
    Object.keys(byPlayer).forEach(k => out.push(byPlayer[k]));
  });
  return out;
}


function normalizePeriod(sport, events, period) {
  const keys = {
    h1: ['spreads_h1', 'totals_h1'],
    q1: ['spreads_q1', 'totals_q1'],
    p1: ['spreads_p1', 'totals_p1'],
    f5: ['spreads_1st_5_innings', 'totals_1st_5_innings']
  }[period] || ['spreads_h1', 'totals_h1'];
  const sprKey = keys[0];
  const totKey = keys[1];
  return (events || []).map(ev => {
    const book = pickBook(ev);
    const mk = book ? marketMap(book) : {};
    const spr = mk[sprKey] || [];
    const tot = mk[totKey] || [];
    const over = tot.find(o => /^over$/i.test(o.name));
    const under = tot.find(o => /^under$/i.test(o.name));
    return {
      sport,
      id: ev.id,
      home: ev.home_team,
      away: ev.away_team,
      commence: ev.commence_time,
      period,
      spread: lineFor(spr, ev.home_team),
      spH: priceFor(spr, ev.home_team),
      spA: priceFor(spr, ev.away_team),
      total: over && over.point != null ? Number(over.point) : null,
      totO: over && over.price != null ? Number(over.price) : null,
      totU: under && under.price != null ? Number(under.price) : null,
      spUpd: marketUpd(book, sprKey),
      totUpd: marketUpd(book, totKey),
      book: book ? book.key : null
    };
  }).filter(g => g.spread != null || g.total != null);
}


function normalizeLiveAlts(ev) {
  const book = pickBook(ev);
  const mk = book ? marketMap(book) : {};
  const home = ev.home_team;
  const away = ev.away_team;
  const spr = (mk.alternate_spreads || []).concat(mk.spreads || []);
  const tot = (mk.alternate_totals || []).concat(mk.totals || []);
  const spreads = [];
  const seen = {};
  spr.forEach(o => {
    if (!o || o.point == null || o.price == null) return;
    const key = String(o.point);
    if (!seen[key]) seen[key] = { point: Number(o.point), home: null, away: null };
    if (String(o.name) === home) seen[key].home = Number(o.price);
    if (String(o.name) === away) seen[key].away = Number(o.price);
  });
  Object.keys(seen).forEach(k => spreads.push(seen[k]));
  spreads.sort((a, b) => a.point - b.point);
  const totals = [];
  const tseen = {};
  tot.forEach(o => {
    if (!o || o.point == null || o.price == null) return;
    const key = String(o.point);
    if (!tseen[key]) tseen[key] = { point: Number(o.point), over: null, under: null };
    if (/^over$/i.test(o.name)) tseen[key].over = Number(o.price);
    if (/^under$/i.test(o.name)) tseen[key].under = Number(o.price);
  });
  Object.keys(tseen).forEach(k => totals.push(tseen[k]));
  totals.sort((a, b) => a.point - b.point);
  const h2h = mk.h2h || [];
  return { spreads, totals, mlH: priceFor(h2h, home), mlA: priceFor(h2h, away) };
}

// (1128) Buy points: the book's real alternate lines. Each side keeps its own line, e.g. away +4.5,
// so a bought line is looked up exactly as the bettor holds it. Only the book the main board uses.
const BUY_MKTS = 'alternate_spreads,alternate_totals';
const BUY_SPORTS = { nfl: 1, ncaaf: 1, cfl: 1, nba: 1, ncaab: 1, wnba: 1 };
const BUY_MAX = 2;                       // points, either way
const BUY_MIN_PRICE = -200, BUY_MAX_PRICE = 150;   // same limit the board uses for spreads / totals
function normalizeBuyAlts(ev) {
  const book = pickBook(ev);
  if (!book) return null;
  const mk = marketMap(book);
  const out = { book: book.key, sp: { h: [], a: [] }, tot: { o: [], u: [] }, spUpd: marketUpd(book, 'alternate_spreads'), totUpd: marketUpd(book, 'alternate_totals') };
  (mk.alternate_spreads || []).forEach(o => {
    if (!o || o.point == null || o.price == null) return;
    const side = String(o.name) === ev.home_team ? 'h' : String(o.name) === ev.away_team ? 'a' : null;
    if (side) out.sp[side].push([Number(o.point), Number(o.price)]);
  });
  (mk.alternate_totals || []).forEach(o => {
    if (!o || o.point == null || o.price == null) return;
    const side = /^over$/i.test(o.name) ? 'o' : /^under$/i.test(o.name) ? 'u' : null;
    if (side) out.tot[side].push([Number(o.point), Number(o.price)]);
  });
  ['h', 'a'].forEach(k => out.sp[k].sort((x, y) => x[0] - y[0]));
  ['o', 'u'].forEach(k => out.tot[k].sort((x, y) => x[0] - y[0]));
  return out;
}
function altPrice(ba, mkt, side, line) {
  const list = ba && (mkt === 'sp' ? ba.sp : ba.tot);
  const rows = list && list[side];
  const hit = (rows || []).find(r => Math.abs(r[0] - line) < 0.001);
  return hit ? hit[1] : null;
}

function normalize(sport, events) {
  return (events || []).map(ev => {
    const book = pickBook(ev);
    const mk = book ? marketMap(book) : {};
    const h2h = mk.h2h || [];
    const spr = mk.spreads || [];
    const totPick = fullGameTotals(ev, sport);
    const home = ev.home_team;
    const away = ev.away_team;
    const over = totPick;
    const under = totPick;
    return {
      sport,
      id: ev.id,
      home,
      away,
      tournament: ev.tournament || '',
      commence: ev.commence_time,
      mlH: priceFor(h2h, home),
      mlA: priceFor(h2h, away),
      spread: lineFor(spr, home),
      spH: priceFor(spr, home),
      spA: priceFor(spr, away),
      total: totPick ? totPick.point : null,
      totO: totPick && totPick.totO != null ? Number(totPick.totO) : null,
      totU: totPick && totPick.totU != null ? Number(totPick.totU) : null,
      totBook: totPick ? totPick.book : null,
      book: book ? book.key : null
    };
  });
}


// ---------------------------------------------------------------------------
// (1115) Shared odds cache.
// Every phone used to call the paid Odds API on its own. Now one cached copy is
// kept in Netlify Blobs (store "odds-cache") and shared by everyone, so credits
// depend on how long games run, not on how many phones are open.
// - Each kind of data has its own freshness (see TTL below).
// - When an entry goes stale, only one request refreshes it (a short lock in the
//   store); everyone else keeps getting the last copy for those few seconds.
// - "fresh=1" (bet-time price check) means "no older than 10 seconds".
// - If the store is down or slow, the function fetches directly like before,
//   so odds never go blank because of the cache.
// ---------------------------------------------------------------------------
const CACHE_STORE = 'odds-cache';
const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN;
const TTL = {
  live: 20 * SEC,        // main lines for a sport with a game in progress
  today: 4 * MIN,        // main lines, next game within 16 hours
  later: 30 * MIN,       // main lines, nothing for 16+ hours
  empty: 60 * SEC,       // no games listed right now
  altLive: 25 * SEC,     // live card alternate lines
  altBuy: 60 * SEC,      // (1128) buy-points ladder (pregame alternate lines), fetched only when someone taps +/-
  props: 10 * MIN,
  teamTotals: 30 * MIN,
  period: 10 * MIN,
  futures: 6 * HOUR,
  priceCheck: 10 * SEC,  // fresh=1 / bet-time check: never older than this
  eventMain: 10 * SEC
};
const PERIOD_PAGE = 16, PERIOD_MAX_PAGES = 10;
const LIVE_STALE_MS = 2 * MIN;   // (1128) a live period / team-total price the book hasn't updated for this long is refused
const LOCK_MS = 15 * SEC;      // a refresh in progress blocks other refreshers for at most this long
const BLOB_TIMEOUT = 1000;     // slow store = treat as down and go direct
const BLOB_DOWN_MS = 60 * SEC;  // after a store failure, skip the store for a minute in this instance

let testStore;                 // tests only: a mock store, or null for "store down"
function _setTestStore(s) { testStore = s; }

function withTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('blob timeout')), ms); })])
    .finally(() => clearTimeout(t));
}
// Same initialization as board.js getStore(), with its own store name.
async function cacheStore(event) {
  if (testStore !== undefined) return testStore;
  const mod = require('@netlify/blobs');
  if (process.env.NETLIFY_SITE_ID && process.env.NETLIFY_AUTH_TOKEN) {
    return mod.getStore({ name: CACHE_STORE, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_AUTH_TOKEN });
  }
  if (event && event.blobs && mod.connectLambda) { try { mod.connectLambda(event); } catch (e) {} }
  return mod.getStore({ name: CACHE_STORE, consistency: 'strong' });
}
function makeCtx(event) {
  let p = null;
  return { store() {
    if (mem.__blobDownUntil && Date.now() < mem.__blobDownUntil) return Promise.resolve(null);
    if (!p) p = cacheStore(event).catch(() => null);
    return p;
  } };
}
async function blobGet(store, key) {
  try {
    let r;
    try { r = await withTimeout(store.getWithMetadata(key, { type: 'json', consistency: 'strong' }), BLOB_TIMEOUT); }
    catch (e) {
      if (String(e && e.message || '').indexOf('consistency') >= 0) r = await withTimeout(store.getWithMetadata(key, { type: 'json' }), BLOB_TIMEOUT);
      else throw e;
    }
    return r ? { data: r.data, etag: r.etag } : null;
  } catch (e) { mem.__blobDownUntil = Date.now() + BLOB_DOWN_MS; return { failed: true }; }
}
async function blobSet(store, key, val, opts) {
  try { const w = await withTimeout(store.setJSON(key, val, opts || {}), BLOB_TIMEOUT); return !(w && w.modified === false); }
  catch (e) { mem.__blobDownUntil = Date.now() + BLOB_DOWN_MS; return false; }
}
// One refresher at a time across all function instances.
async function takeLock(store, key) {
  const lk = 'lock:' + key;
  const cur = await blobGet(store, lk);
  if (!cur || cur.failed) {
    if (cur && cur.failed) return true;          // store trouble: just refresh
    return blobSet(store, lk, { at: Date.now() }, { onlyIfNew: true });
  }
  if (cur.data && Date.now() - Number(cur.data.at || 0) < LOCK_MS) return false;
  return blobSet(store, lk, { at: Date.now() }, cur.etag ? { onlyIfMatch: cur.etag } : {});
}
function pruneMem() {
  const keys = Object.keys(mem).filter(k => k.indexOf('c:') === 0);
  if (keys.length <= 400) return;
  keys.sort((a, b) => (mem[a].at || 0) - (mem[b].at || 0)).slice(0, keys.length - 300).forEach(k => { delete mem[k]; });
}
const inflight = {};
// Returns { json, status, src }. produce() returns { json, status, cacheable, failed }.
async function cached(ctx, key, ttlOf, maxAge, produce) {
  const mk = 'c:' + key;
  const age = e => Date.now() - Number(e.at || 0);
  const limit = e => Math.min(ttlOf(e.json), maxAge || Infinity);
  let e = mem[mk];
  if (e && age(e) < limit(e)) return { json: e.json, status: 200, src: 'mem' };
  const store = await ctx.store();
  if (store) {
    const b = await blobGet(store, mk);
    if (b && b.data && b.data.at && (!e || b.data.at > e.at)) { e = b.data; mem[mk] = e; }
    if (e && age(e) < limit(e)) return { json: e.json, status: 200, src: 'blob' };
    // Stale copy and someone else is already refreshing it: hand out the stale copy.
    // Never for price checks (maxAge set): those always get a copy <= 20s old.
    if (e && !maxAge && age(e) < limit(e) * 4 + 2 * MIN) {
      const mine = await takeLock(store, mk);
      if (!mine) return { json: e.json, status: 200, src: 'stale' };
    }
  }
  if (!inflight[mk]) inflight[mk] = Promise.resolve().then(produce).finally(() => { delete inflight[mk]; });
  let r;
  try { r = await inflight[mk]; }
  catch (err) { r = { failed: true, thrown: true, json: { games: [], error: String(err && err.message || err) }, status: 200 }; }
  if (r.cacheable) {
    const entry = { at: Date.now(), json: r.json };
    mem[mk] = entry; pruneMem();
    if (store && !(mem.__blobDownUntil && Date.now() < mem.__blobDownUntil)) await blobSet(store, mk, entry);
    return { json: r.json, status: r.status || 200, src: 'miss' };
  }
  // Odds API unreachable (network error): keep showing the last good odds instead of going blank,
  // like the old in-memory fallback did. Never for price checks (fresh=1): those must see the real answer.
  if (r.thrown && !maxAge && e && e.json) return { json: e.json, status: 200, src: 'stale-error' };
  return { json: r.json, status: r.status || 200, src: 'miss' };
}

// ---- credit usage (from the Odds API response headers) ----
function recordUsage(h) {
  if (!h) return;
  const rem = h['x-requests-remaining'], used = h['x-requests-used'], last = h['x-requests-last'];
  if (rem == null && used == null) return;
  const u = mem.__usage || (mem.__usage = {});
  if (rem != null) u.remaining = Number(rem);
  if (used != null) u.used = Number(used);
  if (last != null) u.last = Number(last);
  u.at = Date.now();
  u.dirty = true;
}
const LOW_CREDITS = 250000;
async function flushUsage(ctx) {
  const u = mem.__usage;
  if (!u || !u.dirty || (u.savedAt && Date.now() - u.savedAt < 30 * SEC)) return;
  const store = await ctx.store();
  if (!store) return;
  u.dirty = false; u.savedAt = Date.now();
  await blobSet(store, 'usage', { remaining: u.remaining, used: u.used, last: u.last, at: u.at });
  // Low-credit alert, at most once a day, through the existing Telegram alert.
  if (u.remaining != null && u.remaining < LOW_CREDITS) {
    const day = new Date().toISOString().slice(0, 10);
    if (mem.__lowAlertDay === day) return;
    const cur = await blobGet(store, 'alert-low');
    if (cur && !cur.failed && cur.data && cur.data.day === day) { mem.__lowAlertDay = day; return; }
    mem.__lowAlertDay = day;
    await blobSet(store, 'alert-low', { day });
    try { await require('./board').sendAlert('The Board: Odds API credits are low (' + u.remaining + ' left this month).'); } catch (e) {}
  }
}
async function usageReply(event, headers) {
  try {
    const B = require('./board');
    const st0 = await B.getStore(event);
    const { st } = await B.readState(st0);
    const me = B.requireUser(st, event);
    if (!B.isAdmin(me)) return { statusCode: 403, headers, body: JSON.stringify({ error: 'Admin only.' }) };
    const store = await makeCtx(event).store();
    let u = null;
    if (store) { const r = await blobGet(store, 'usage'); if (r && r.data) u = r.data; }
    const m = mem.__usage;
    if (m && m.at && (!u || m.at > u.at)) u = { remaining: m.remaining, used: m.used, last: m.last, at: m.at };
    return { statusCode: 200, headers, body: JSON.stringify({ usage: u }) };
  } catch (e) {
    const code = e && e.status ? e.status : 500;
    return { statusCode: code, headers, body: JSON.stringify({ error: code === 500 ? 'Server error' : e.message }) };
  }
}

function mainTtl(json) {
  const g = (json && json.games) || [];
  if (!g.length) return TTL.empty;
  const t = Date.now();
  let live = false, soon = false;
  g.forEach(x => {
    const c = Date.parse(x && x.commence);
    if (isNaN(c)) return;
    if (c <= t) live = true; else if (c - t < 16 * HOUR) soon = true;
  });
  return live ? TTL.live : soon ? TTL.today : TTL.later;
}
function periodOfMkts(mkts) {
  const m = /(?:^|,)spreads_(h1|q1|p1|1st_5_innings)(?:,|$)/.exec(String(mkts || ''));
  return m ? (m[1] === '1st_5_innings' ? 'f5' : m[1]) : null;
}
function eventTtl(mkts) {
  if (mkts === BUY_MKTS) return TTL.altBuy;
  if (mkts.indexOf('team_totals') >= 0) return TTL.teamTotals;
  if (periodOfMkts(mkts)) return TTL.period;
  if (mkts.indexOf('alternate_') >= 0) return TTL.altLive;
  if (/player_|batter_|pitcher_/.test(mkts)) return TTL.props;
  return TTL.eventMain;
}

// (1116) One place that answers every odds question, used by the page (handler) and by state.js placeBet.
async function runQuery(ctx, key, params, maxAge) {
  const sport = String(params.sport || 'mlb').toLowerCase();
  if (String(params.futures || '') === '1') {
    return (await cached(ctx, 'fut:' + sport, () => TTL.futures, maxAge, async () => {
      const keys = sport === 'ncaaf'
        ? ['americanfootball_ncaaf_championship_winner']
        : ['americanfootball_nfl_super_bowl_winner'];
      const futures = [];
      for (const k of keys) {
        try {
          const res = await getJson('https://api.the-odds-api.com/v4/sports/' + k + '/odds?regions=us&markets=outrights&oddsFormat=american&apiKey=' + encodeURIComponent(key));
          const events = Array.isArray(res.json) ? res.json : [];
          events.forEach(ev => {
            const book = (ev.bookmakers || [])[0];
            const m = book && (book.markets || []).find(x => x.key === 'outrights');
            (m && m.outcomes || []).forEach(o => {
              if (o && o.name && o.price != null) futures.push({ name: o.name, price: Number(o.price), title: ev.sport_title || k, id: k + ':' + o.name });
            });
          });
        } catch (e) {}
      }
      futures.sort((a, b) => Number(a.price) - Number(b.price));
      return { json: { futures, sport, at: Date.now() }, cacheable: futures.length > 0 };
    }));
  }
  const apiSport = SPORT_MAP[sport];
  if (!apiSport) return { json: { games: [], error: 'unknown sport' }, status: 200, src: 'none' };

  const eventId = String(params.event || params.eventId || '').trim();
  if (eventId) {
    const extraMkts = String(params.markets || '').replace(/[^a-z0-9_,]/g,'').slice(0, 240);
    const evKey = 'ev:' + sport + ':' + eventId + ':' + extraMkts;
    return (await cached(ctx, evKey, () => eventTtl(extraMkts), maxAge, async () => {
      const mktQs = extraMkts ? extraMkts : 'h2h,spreads,totals';
      const evUrl = 'https://api.the-odds-api.com/v4/sports/' + apiSport + '/events/' + encodeURIComponent(eventId) + '/odds?regions=us&markets=' + mktQs + '&oddsFormat=american&apiKey=' + encodeURIComponent(key);
      try {
        const { status, json } = await getJson(evUrl);
        const ev = json && json.id ? json : (Array.isArray(json) ? json[0] : null);
        const games = ev ? normalize(sport, [ev]) : [];
        const props = ev && extraMkts ? normalizeProps(ev) : [];
        const extras = ev && extraMkts.indexOf('team_totals') >= 0 ? normalizeExtras(ev) : null;
        const liveAlts = ev && extraMkts.indexOf('alternate_spreads') >= 0 && extraMkts !== BUY_MKTS ? normalizeLiveAlts(ev) : null;
        const buyAlts = ev && extraMkts === BUY_MKTS ? normalizeBuyAlts(ev) : null;
        const perKey = ev ? periodOfMkts(extraMkts) : null;
        const periodRow = perKey ? (normalizePeriod(sport, [ev], perKey)[0] || null) : null;
        const err = (!ev && json && (json.message || json.error_code || json.error)) ? (json.message || json.error_code || json.error) : (status && status >= 400 ? ('http '+status) : null);
        const payload = { games, props, extras, liveAlts, sport, eventId, at: Date.now(), error: err, source: extraMkts ? 'event-props' : 'event-odds' };
        if (perKey) payload.period = periodRow;
        if (buyAlts) payload.buyAlts = buyAlts;
        return { json: payload, cacheable: !!(games.length || extras), failed: !!err };
      } catch (e) {
        return { json: { games: [], error: String(e.message || e), source: 'event-odds' }, failed: true, thrown: true };
      }
    }));
  }

  const period = String(params.period || '').toLowerCase();
  if ((period === 'h1' || period === 'q1' || period === 'p1' || period === 'f5') && sport !== 'tennis') {
    const mks = period === 'q1' ? 'spreads_q1,totals_q1' : period === 'p1' ? 'spreads_p1,totals_p1' : period === 'f5' ? 'spreads_1st_5_innings,totals_1st_5_innings' : 'spreads_h1,totals_h1';
    // (1128) Period lines only come per game (2 credits a game). The board used to stop at the first 16
    // games; now it shows them 16 at a time, soonest first, and "More games" loads the next 16
    // (each page is cached and shared for 10 minutes, so a page costs credits only when someone opens it).
    const page = Math.max(0, Math.min(PERIOD_MAX_PAGES - 1, parseInt(params.page, 10) || 0));
    return (await cached(ctx, 'per:' + sport + ':' + period + (page ? ':p' + page : ''), () => TTL.period, maxAge, async () => {
      try {
        // (1128) period markets only exist per game: the free /events list, then one call per game
        // (the bulk /odds call for period markets was always refused by the API and is gone)
        let games = [], err = 'no period lines', more = 0, total = 0;
        {
          const evRes = await getJson('https://api.the-odds-api.com/v4/sports/' + apiSport + '/events?apiKey=' + encodeURIComponent(key));
          const t = Date.now();
          const all = (Array.isArray(evRes.json) ? evRes.json : [])
            .filter(ev => ev && ev.id && !(Date.parse(ev.commence_time) < t - 5 * HOUR))
            .sort((a, b) => (Date.parse(a.commence_time) || 0) - (Date.parse(b.commence_time) || 0));
          total = all.length;
          const events = all.slice(page * PERIOD_PAGE, (page + 1) * PERIOD_PAGE);
          more = Math.max(0, total - (page + 1) * PERIOD_PAGE);
          const rows = await Promise.all(events.map(async ev => {
            try {
              const one = await getJson('https://api.the-odds-api.com/v4/sports/' + apiSport + '/events/' + encodeURIComponent(ev.id) + '/odds?regions=us&markets=' + mks + '&oddsFormat=american&apiKey=' + encodeURIComponent(key));
              const row = normalizePeriod(sport, one.json && one.json.id ? [one.json] : [], period)[0];
              return row ? Object.assign({ commence: ev.commence_time, home: ev.home_team, away: ev.away_team }, row) : null;
            } catch (e) { return null; }
          }));
          const pulled = rows.filter(Boolean);
          games = pulled; err = pulled.length ? null : (page ? 'No more lines posted.' : 'No 1st half or quarter lines up yet.');
        }
        const payload = { games, sport, period, page, more, total, at: Date.now(), error: games.length ? null : err };
        return { json: payload, cacheable: games.length > 0 || page > 0 };
      } catch (e) {
        return { json: { games: [], error: String(e.message || e), period }, failed: true, thrown: true };
      }
    }));
  }

  return (await cached(ctx, 'main:' + sport, mainTtl, maxAge, async () => {
    const markets = sport === 'tennis' ? 'h2h' : 'h2h,spreads,totals';
    const keys = sport === 'tennis' ? await activeTennisKeys(key) : [apiSport];
    const url = 'https://api.the-odds-api.com/v4/sports/' + apiSport + '/odds?regions=us&markets=' + markets + '&oddsFormat=american&apiKey=' + encodeURIComponent(key);
    try {
      let status = 200;
      let json = [];
      let err = null;
      if (sport === 'tennis') {
        const chunks = await Promise.all(keys.slice(0, 8).map(async (k) => {
          try {
            const res = await getJson('https://api.the-odds-api.com/v4/sports/' + k + '/odds?regions=us&markets=h2h&oddsFormat=american&apiKey=' + encodeURIComponent(key));
            const rows = Array.isArray(res.json) ? res.json : [];
            rows.forEach(ev => { ev.tournament = tennisLabel(k); });
            return rows;
          } catch (e) { return []; }
        }));
        json = chunks.reduce((a, b) => a.concat(b), []);
        if (!json.length) err = 'no active tennis tournaments';
      } else {
        const res = await getJson(url);
        status = res.status;
        json = res.json;
        err = (!Array.isArray(json) && json && (json.message || json.error_code || json.error)) ? (json.message || json.error_code || json.error) : null;
      }
      const games = normalize(sport, Array.isArray(json) ? json : []);
      const payload = { games, sport, at: Date.now(), remaining: null, error: err || (status && status >= 400 ? ('http '+status) : null) };
      const bad = !!payload.error;
      // Cache real boards, and also "no games right now" (for a minute) so idle sports cost nothing.
      return { json: payload, status: status || 200, cacheable: games.length > 0 || (!bad && sport !== 'tennis'), failed: bad && !games.length };
    } catch (e) {
      return { json: { games: [], error: String(e.message || e) }, failed: true, thrown: true };
    }
  }));
}

exports._setTestStore = _setTestStore;
exports._mem = mem;
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  const params = event.queryStringParameters || {};
  if (String(params.usage || '') === '1') return usageReply(event, headers);

  const key = process.env.ODDS_API_KEY;
  if (!key) {
    return { statusCode: 200, headers, body: JSON.stringify({ games: [], error: 'ODDS_API_KEY missing' }) };
  }
  const ctx = makeCtx(event);
  const fresh = String(params.fresh || '') === '1';
  const res = await runQuery(ctx, key, params, fresh ? TTL.priceCheck : 0);
  if (res.src !== 'none') headers['X-Board-Cache'] = res.src;
  try { await flushUsage(ctx); } catch (e) {}
  return { statusCode: res.status || 200, headers, body: JSON.stringify(res.json) };
};

// ---------------------------------------------------------------------------
// (1116) Server-side price check for placeBet (state.js). Authoritative: the
// phone's price is only accepted if it matches the shared odds cache exactly.
// Live legs and props: data no older than 10s. Pregame: no older than 60s.
// All legs are looked up in parallel; legs sharing a feed share one lookup.
// ---------------------------------------------------------------------------
const VERIFY_LIVE_MS = 10 * SEC;
const VERIFY_PRE_MS = 60 * SEC;
// Same market lists the page asks for, so checks reuse the page's cache entries.
const PROP_MARKETS = {
  nfl: 'player_pass_yds,player_pass_tds,player_pass_completions,player_pass_interceptions,player_rush_yds,player_receptions,player_anytime_td',
  ncaaf: 'player_pass_yds,player_pass_tds,player_pass_completions,player_rush_yds,player_receptions,player_anytime_td',
  nba: 'player_points,player_rebounds,player_assists',
  mlb: 'batter_hits,pitcher_strikeouts,batter_home_runs',
  nhl: 'player_points,player_goals,player_shots_on_goal'
};
const LIVE_CARD_MKTS = 'h2h,spreads,totals,alternate_spreads,alternate_totals';
const EXTRA_MKTS = 'team_totals,totals_h1,team_totals_h1';
const PERIOD_MKTS = { h1: 'spreads_h1,totals_h1', q1: 'spreads_q1,totals_q1', p1: 'spreads_p1,totals_p1', f5: 'spreads_1st_5_innings,totals_1st_5_innings' };
const STOP = { the: 1, fc: 1, cf: 1, sc: 1, afc: 1, club: 1, de: 1, state: 1, university: 1 };

function toks(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length > 1 && !STOP[w]);
}
function overlap(a, b) {
  const tb = toks(b);
  return toks(a).filter(w => tb.indexOf(w) >= 0).length;
}
function legTeams(leg) {
  let home = String(leg.home || ''), away = String(leg.away || '');
  if ((!home || !away) && leg.matchup) {
    const m = String(leg.matchup).replace(/^[A-Z0-9]+\s+·\s+/, '').split(/\s+@\s+/);
    if (m.length === 2) { away = away || m[0]; home = home || m[1]; }
  }
  return { home, away };
}
// How the leg's home/away line up with the feed's home/away (the page flips the same way).
function orient(leg, rec) {
  const t = legTeams(leg);
  if (!t.home || !t.away || !rec) return { known: false, flipped: false, score: 0 };
  const straight = overlap(t.home, rec.home) + overlap(t.away, rec.away);
  const crossed = overlap(t.home, rec.away) + overlap(t.away, rec.home);
  const both = (overlap(t.home, rec.home) > 0 && overlap(t.away, rec.away) > 0) || (overlap(t.home, rec.away) > 0 && overlap(t.away, rec.home) > 0);
  return { known: true, flipped: crossed > straight, score: Math.max(straight, crossed), both };
}
function same(a, b) { return a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.001; }
function num(v) { return v == null || v === '' || isNaN(Number(v)) ? null : Number(v); }
function feedErr(json) {
  if (!json) return 'unavailable';
  const e = String(json.error || '');
  if (!e) return null;
  if (/not.?found|EVENT_NOT_FOUND|http 404/i.test(e)) return 'gone';
  return 'unavailable';
}
function legKind(leg) {
  const mkt = String(leg.mkt || '');
  if (String(leg.period || '') === 'futures' || /^futures-/.test(String(leg.gid || ''))) return 'futures';
  if (mkt === 'prop') return 'prop';
  if (mkt === 'tt' || mkt === 'h1tot' || mkt === 'h1tt') return 'extra';
  if ((mkt === 'sp' || mkt === 'tot') && PERIOD_MKTS[String(leg.period || '')]) return 'period';
  if (mkt === 'ml' || mkt === 'sp' || mkt === 'tot') return PERIOD_MKTS[String(leg.period || '')] ? 'uncovered' : 'main';
  return 'uncovered';
}

// legs: selections as the phone sent them. Returns { ok, at, ms, legs: [...] } where each leg is
// { i, status: 'ok' | 'changed' | 'blocked' | 'uncovered', odds, line, baseOdds, baseLine, msg, src, live }.
async function verifyLegs(event, legs, opts) {
  const t0 = Date.now();
  const key = process.env.ODDS_API_KEY;
  const ctx = makeCtx(event);
  const memo = {};
  const ask = (params, maxAge) => {
    const k = JSON.stringify([params, maxAge]);
    if (!memo[k]) {
      memo[k] = key ? runQuery(ctx, key, params, maxAge).then(r => r.json).catch(e => ({ games: [], error: String(e && e.message || e) }))
        : Promise.resolve({ games: [], error: 'ODDS_API_KEY missing' });
    }
    return memo[k];
  };
  const out = await Promise.all((legs || []).map((leg, i) => checkLeg(leg || {}, i, ask, opts).catch(e => ({ i, status: 'blocked', unavailable: true, msg: 'Could not verify the price. Bet not placed.' }))));
  try { await flushUsage(ctx); } catch (e) {}
  return { ok: out.every(x => x.status === 'ok' || x.status === 'uncovered'), at: new Date().toISOString(), ms: Date.now() - t0, legs: out };
}

function buyAdj(leg) {
  const v = Number(leg.mkt === 'sp' ? leg.spreadAdj : leg.mkt === 'tot' ? leg.totalAdj : (Number(leg.spreadAdj) || Number(leg.totalAdj))) || 0;
  return Math.abs(v) < 1e-9 ? 0 : v;
}
async function checkLeg(leg, i, ask, opts) {
  opts = opts || {};
  const kind = legKind(leg);
  const sport = String(leg.sport || '').toLowerCase();
  const res = { i, kind, status: 'ok' };
  const blocked = (msg, extra) => Object.assign(res, { status: 'blocked', msg }, extra || {});
  const odds = num(leg.lockedOdds != null ? leg.lockedOdds : leg.odds);
  const label = String(leg.label || leg.matchup || 'a selection').slice(0, 120);

  // (1128) Buy points: football and basketball full-game spreads and totals only (never a moneyline,
  // a 1st half / quarter / period / first-5 line, team total, prop, NHL, MLB or soccer).
  const adj = buyAdj(leg);
  if (adj && !(kind === 'main' && (leg.mkt === 'sp' || leg.mkt === 'tot') && BUY_SPORTS[sport])) {
    return blocked('Buying points is only offered on football and basketball full-game spreads and totals: ' + label, { buy: true });
  }
  if (kind === 'uncovered') return Object.assign(res, { status: 'uncovered' });
  if (kind === 'futures') {
    const fsport = sport || String(leg.gid || '').replace(/^futures-/, '');
    if (fsport !== 'nfl' && fsport !== 'ncaaf') return Object.assign(res, { status: 'uncovered' });
    const json = await ask({ sport: fsport, futures: '1' }, VERIFY_PRE_MS);
    const list = (json && json.futures) || [];
    if (!list.length) return blocked('Could not verify the futures price right now. Bet not placed.', { unavailable: true });
    const name = String(leg.matchup || leg.label || '').split(/\s+to win\s+/i)[0].trim().toLowerCase();
    const hit = list.find(f => String(f.name || '').toLowerCase() === name);
    if (!hit) return blocked('That futures price is no longer offered: ' + label);
    res.src = 'futures';
    return price(res, odds, num(hit.price));
  }
  if (!SPORT_MAP[sport]) return Object.assign(res, { status: 'uncovered' });

  // Which feed event is this? The page sends oddsApiId; period boards use the feed id as gid.
  // When the id is known, the leg's own feed lookup starts at the same time as the board lookup
  // (one round trip instead of two); the phone's live/pregame flag is only a hint for that.
  const hintId = String(leg.oddsApiId || (kind === 'period' ? leg.gid : '') || '');
  if (hintId) {
    const hintLive = legLiveGuess(leg);
    const pre = kind === 'prop' ? (PROP_MARKETS[sport] ? ask({ sport, event: hintId, markets: PROP_MARKETS[sport] }, VERIFY_LIVE_MS) : null)
      : kind === 'extra' ? ask({ sport, event: hintId, markets: EXTRA_MKTS }, hintLive ? VERIFY_LIVE_MS : VERIFY_PRE_MS)
      : kind === 'period' ? ask({ sport, event: hintId, markets: PERIOD_MKTS[String(leg.period)] }, hintLive ? VERIFY_LIVE_MS : VERIFY_PRE_MS)
      : (kind === 'main' && hintLive) ? ask({ sport, event: hintId, markets: LIVE_CARD_MKTS }, VERIFY_LIVE_MS) : null;
    if (pre) pre.catch(() => {});
  }
  const main = await ask({ sport }, VERIFY_PRE_MS);
  const mainErr = feedErr(main);
  const games = (main && main.games) || [];
  let evId = String(leg.oddsApiId || (kind === 'period' ? leg.gid : '') || '');
  let rec = evId ? games.find(g => String(g.id) === evId) : null;
  if (!evId) {
    const cands = games.filter(g => { const o = orient(leg, g); return o.known && o.both; });
    if (cands.length === 1) { rec = cands[0]; evId = String(rec.id); }
  }
  if (!evId) {
    if (mainErr === 'unavailable' && !games.length) {
      return blocked(legLiveGuess(leg) ? 'Could not verify the live price. Bet not placed.' : 'Could not verify the price right now. Bet not placed.', { unavailable: true });
    }
    return Object.assign(res, { status: 'uncovered' });
  }
  if (rec) {
    const o = orient(leg, rec);
    if (o.known && o.score === 0) return blocked('That bet does not match the odds feed. Refresh the board: ' + label);
  }
  // Start time decides live vs pregame (not the phone).
  let commence = rec ? Date.parse(rec.commence) : NaN;
  let live = !isNaN(commence) && commence <= Date.now();
  if (!rec) {
    // Not on the sport's board (pulled, or the board is down). Ask the event directly.
    const ev = await ask({ sport, event: evId }, VERIFY_LIVE_MS);
    const err = feedErr(ev);
    if (err === 'gone') return blocked('This game is no longer on the board: ' + label, { gone: true });
    if (err || !(ev.games && ev.games[0])) return blocked(legLiveGuess(leg) ? 'Could not verify the live price. Bet not placed.' : 'Could not verify the price right now. Bet not placed.', { unavailable: true });
    rec = ev.games[0];
    commence = Date.parse(rec.commence);
    live = !isNaN(commence) && commence <= Date.now();
    const o = orient(leg, rec);
    if (o.known && o.score === 0) return blocked('That bet does not match the odds feed. Refresh the board: ' + label);
  }
  res.live = live;
  const unavailable = () => blocked(live ? 'Could not verify the live price. Bet not placed.' : 'Could not verify the price right now. Bet not placed.', { unavailable: true });
  if (live && leg.liveAtAdd === false) return blocked('This game has started, so the pregame price is closed. Add it again from the live board: ' + label, { started: true });
  if (live && adj) return blocked('This game has started. Bought points are pregame only: ' + label, { started: true, buy: true });
  // (1128) Past-posting guard: a game in progress, a 1st half / quarter / period / first-5 line or a team
  // total. ESPN must show that part of the game still to be decided, or the bet is refused.
  const gatePer = kind === 'period' ? String(leg.period) : kind === 'extra' ? (leg.mkt === 'tt' ? 'game' : 'h1') : null;
  if (live && gatePer) {
    let gate;
    try { gate = await (opts.gate || require('./grade').periodGate)(sport, gatePer, leg, rec); } catch (e) { gate = { unknown: 'error' }; }
    const name = { h1: '1st half', q1: '1st quarter', p1: '1st period', f5: 'first 5 innings', game: 'game' }[gatePer] || 'period';
    if (gate && gate.over) return blocked('The ' + name + ' is over, so this line is closed: ' + label, { started: true, periodOver: true });
    if (!gate || gate.over !== false) return blocked('Could not confirm the game clock for this ' + name + ' line. Bet not placed.', { unavailable: true });
  }
  const staleLive = upd => live && (upd == null || Date.now() - upd > LIVE_STALE_MS);
  const fl = orient(leg, rec).flipped;
  const sideFor = s => (fl ? (s === 'h' ? 'a' : s === 'a' ? 'h' : s) : s);

  if (kind === 'prop') {
    if (live) return blocked('Props are pregame only. Bet not placed.', { started: true });
    const mk = PROP_MARKETS[sport];
    if (!mk) return Object.assign(res, { status: 'uncovered' });
    const ev = await ask({ sport, event: evId, markets: mk }, VERIFY_LIVE_MS);
    const err = feedErr(ev);
    if (err === 'gone') return blocked('This game is no longer on the board: ' + label, { gone: true });
    if (err) return unavailable();
    const player = String(leg.propPlayer || '').toLowerCase();
    const hit = (ev.props || []).find(p => String(p.player || '').toLowerCase() === player && (!leg.propMarket || p.market === leg.propMarket));
    if (!hit) return blocked('That prop is off the board right now: ' + label, { gone: true });
    const p = leg.side === 'o' ? hit.over : leg.side === 'u' ? hit.under : hit.yes;
    if (p == null) return blocked('That prop side is off the board right now: ' + label, { gone: true });
    res.src = 'prop';
    return lineAndPrice(res, odds, num(p), num(leg.currentTotal), num(hit.line));
  }
  if (kind === 'extra') {
    const ev = await ask({ sport, event: evId, markets: EXTRA_MKTS }, live ? VERIFY_LIVE_MS : VERIFY_PRE_MS);
    const err = feedErr(ev);
    if (err === 'gone') return blocked('This game is no longer on the board: ' + label, { gone: true });
    if (err) return unavailable();
    const x = ev.extras || {};
    const team = sideFor(String(leg.team || ''));
    const pack = leg.mkt === 'h1tot' ? x.h1 : leg.mkt === 'tt' ? (team === 'h' ? x.ttH : team === 'a' ? x.ttA : null) : (team === 'h' ? x.h1H : team === 'a' ? x.h1A : null);
    const p = pack && (leg.side === 'o' ? pack.over : leg.side === 'u' ? pack.under : null);
    if (!pack || p == null) return blocked('That line is off the board right now: ' + label, { gone: true });
    if (staleLive(pack.upd)) return blocked('That live line has not updated in over 2 minutes (the feed is behind). Bet not placed: ' + label, { unavailable: true, stale: true });
    res.src = 'extras';
    return lineAndPrice(res, odds, num(p), num(leg.currentTotal), num(pack.line));
  }
  if (kind === 'period') {
    const per = String(leg.period);
    const ev = await ask({ sport, event: evId, markets: PERIOD_MKTS[per] }, live ? VERIFY_LIVE_MS : VERIFY_PRE_MS);
    const err = feedErr(ev);
    if (err === 'gone') return blocked('This game is no longer on the board: ' + label, { gone: true });
    if (err) return unavailable();
    const row = ev.period;
    if (!row) return blocked('That line is off the board right now: ' + label, { gone: true });
    if (staleLive(leg.mkt === 'sp' ? row.spUpd : row.totUpd)) return blocked('That live line has not updated in over 2 minutes (the feed is behind). Bet not placed: ' + label, { unavailable: true, stale: true });
    res.src = 'period:' + per;
    return mainMarket(res, leg, odds, row, [], sideFor, false);
  }
  // Full game moneyline / spread / total.
  if (adj) return boughtLine(res, leg, odds, rec, sideFor, adj, ask, sport, evId);
  let row = rec, alts = [];
  if (live) {
    const ev = await ask({ sport, event: evId, markets: LIVE_CARD_MKTS }, VERIFY_LIVE_MS);
    const err = feedErr(ev);
    if (err === 'gone') return blocked('This game is no longer on the board: ' + label, { gone: true });
    if (err || !(ev.games && ev.games[0])) return unavailable();
    row = ev.games[0];
    alts = ev.liveAlts || null;
    res.src = 'event:' + (row.book || '');
  } else {
    res.src = 'board:' + (row.book || '');
  }
  return mainMarket(res, leg, odds, row, alts, sideFor, !live);
}
function legLiveGuess(leg) { return leg.liveAtAdd === true || leg.live === true; }

function price(res, sent, cur) {
  res.odds = cur;
  if (cur == null) return Object.assign(res, { status: 'blocked', msg: 'That price is off the board right now.', gone: true });
  if (!same(sent, cur)) res.status = 'changed';
  return res;
}
function lineAndPrice(res, sent, cur, sentLine, curLine) {
  res.odds = cur; res.line = curLine;
  if (cur == null) return Object.assign(res, { status: 'blocked', msg: 'That price is off the board right now.', gone: true });
  if (!same(sent, cur)) res.status = 'changed';
  if ((sentLine != null || curLine != null) && !same(sentLine, curLine)) res.status = 'changed';
  return res;
}
// ml / sp / tot against one feed row (+ live alternate lines). Bought points are checked in boughtLine().
function mainMarket(res, leg, sent, row, alts, sideFor, allowBuy) {
  const side = sideFor(String(leg.side || ''));
  const label = String(leg.label || leg.matchup || 'a selection').slice(0, 120);
  const off = what => Object.assign(res, { status: 'blocked', msg: what + ' is off the board right now: ' + label, gone: true });
  if (leg.mkt === 'ml') {
    const p = side === 'h' ? row.mlH : side === 'a' ? row.mlA : null;
    if (p == null) return off('The moneyline');
    return price(res, sent, num(p));
  }
  // Lines as the bettor holds them, e.g. away +3.5. Main line first, then live alternates.
  const opts = [];
  if (leg.mkt === 'sp') {
    if (row.spread != null) {
      const ln = side === 'h' ? Number(row.spread) : -Number(row.spread);
      const p = side === 'h' ? row.spH : row.spA;
      if (p != null) opts.push({ line: ln, price: Number(p) });
    }
    ((alts && alts.spreads) || []).forEach(s => {
      const p = side === 'h' ? s.home : s.away;
      if (p != null) opts.push({ line: Number(s.point), price: Number(p) });
    });
  } else if (leg.mkt === 'tot') {
    if (row.total != null) {
      const p = leg.side === 'o' ? row.totO : leg.side === 'u' ? row.totU : null;
      if (p != null) opts.push({ line: Number(row.total), price: Number(p) });
    }
    ((alts && alts.totals) || []).forEach(s => {
      const p = leg.side === 'o' ? s.over : leg.side === 'u' ? s.under : null;
      if (p != null) opts.push({ line: Number(s.point), price: Number(p) });
    });
  } else return Object.assign(res, { status: 'uncovered' });
  if (!opts.length) return off(leg.mkt === 'sp' ? 'The spread' : 'The total');
  const mainOpt = opts[0];
  // The line as the phone sent it (the bettor's own line, e.g. +3.5).
  const fromLeg = v => (v == null ? null : Number(v));
  const sentLine = leg.mkt === 'sp' ? fromLeg(leg.currentSpread != null ? leg.currentSpread : leg.baseSpread) : fromLeg(leg.currentTotal != null ? leg.currentTotal : leg.baseTotal);
  const hit = sentLine == null ? null : opts.find(o => same(o.line, sentLine));
  if (hit) { res.line = hit.line; res.odds = hit.price; res.main = hit === mainOpt; if (!same(sent, hit.price)) res.status = 'changed'; return res; }
  // That line is no longer offered: move to the current main line.
  Object.assign(res, { status: 'changed', line: mainOpt.line, odds: mainOpt.price, main: true });
  return res;
}

// (1128) A bought line (pregame, football / basketball, full game): priced from the book's REAL alternate
// line for that exact number, never a formula. Same book and the same freshness as the main board check.
// Line not offered (or priced past the board's -200 / +150 limit) -> the slip goes back to the main line.
async function boughtLine(res, leg, sent, rec, sideFor, adj, ask, sport, evId) {
  const label = String(leg.label || leg.matchup || 'a selection').slice(0, 120);
  if (Math.abs(adj) > BUY_MAX + 1e-9 || Math.abs(adj * 2 - Math.round(adj * 2)) > 0.001) return Object.assign(res, { status: 'blocked', msg: 'Bad bought line on ' + label + ' (max ' + BUY_MAX + ' points).', buy: true });
  const side = leg.mkt === 'sp' ? sideFor(String(leg.side || '')) : String(leg.side || '');
  let main = null;
  if (leg.mkt === 'sp' && rec.spread != null) {
    const p = side === 'h' ? rec.spH : side === 'a' ? rec.spA : null;
    if (p != null) main = { line: side === 'h' ? Number(rec.spread) : -Number(rec.spread), price: Number(p) };
  } else if (leg.mkt === 'tot' && rec.total != null) {
    const p = side === 'o' ? rec.totO : side === 'u' ? rec.totU : null;
    if (p != null) main = { line: Number(rec.total), price: Number(p) };
  }
  if (!main) return Object.assign(res, { status: 'blocked', msg: (leg.mkt === 'sp' ? 'The spread' : 'The total') + ' is off the board right now: ' + label, gone: true });
  const ev = await ask({ sport, event: evId, markets: BUY_MKTS }, VERIFY_PRE_MS);
  const err = feedErr(ev);
  if (err === 'gone') return Object.assign(res, { status: 'blocked', msg: 'This game is no longer on the board: ' + label, gone: true });
  if (err) return Object.assign(res, { status: 'blocked', msg: 'Could not verify the bought line right now. Bet not placed.', unavailable: true });
  const ba = ev && ev.buyAlts;
  const wantLine = Math.round((main.line + adj) * 10) / 10;
  const p = ba && ba.book === rec.book ? altPrice(ba, leg.mkt, side, wantLine) : null;
  res.src = 'alt:' + ((ba && ba.book) || '');
  if (p == null || p < BUY_MIN_PRICE || p > BUY_MAX_PRICE) {
    // that exact line isn't offered: back to the main line at its price
    return Object.assign(res, { status: 'changed', line: main.line, odds: main.price, main: true, buyGone: true });
  }
  Object.assign(res, { odds: p, line: wantLine, baseOdds: main.price, baseLine: main.line, bought: adj, main: true });
  const sentLine = num(leg.mkt === 'sp' ? leg.currentSpread : leg.currentTotal);
  const baseSent = num(leg.mkt === 'sp' ? leg.baseSpread : leg.baseTotal);
  if (!same(sent, p) || !same(sentLine, wantLine) || !same(baseSent, main.line) || !same(leg.baseOdds, main.price)) res.status = 'changed';
  return res;
}

exports.verifyLegs = verifyLegs;
exports._verify = { orient, legKind, PROP_MARKETS, normalizeBuyAlts, altPrice, BUY_MKTS, BUY_SPORTS, BUY_MAX, normalizePeriod, normalizeExtras, LIVE_STALE_MS };
