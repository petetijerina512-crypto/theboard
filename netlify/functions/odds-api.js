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
        try { resolve({ status: res.statusCode, json: JSON.parse(body), headers: res.headers }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function blobStore() {
  try {
    const mod = await import('@netlify/blobs');
    return mod.getStore({
      name: 'board-state',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_AUTH_TOKEN
    });
  } catch (e) { return null; }
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
function fullGameTotals(event, sport) {
  const floor = minTotal(sport);
  let best = null;
  (event.bookmakers || []).forEach(book => {
    (book.markets || []).forEach(m => {
      if (m.key !== 'totals') return;
      const over = (m.outcomes || []).find(o => /^over$/i.test(o.name) && o.point != null);
      if (!over) return;
      const pt = Number(over.point);
      if (isNaN(pt) || pt < floor) return;
      if (!best || pt > best.point) {
        const under = (m.outcomes || []).find(o => /^under$/i.test(o.name));
        best = { point: pt, totO: over.price, totU: under && under.price != null ? under.price : null };
      }
    });
  });
  return best;
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
function normalizeExtras(event) {
  const book = pickBook(event);
  if (!book) return null;
  const mk = marketMap(book);
  const home = event.home_team;
  const away = event.away_team;
  const extras = {
    h1: ouLine(mk.totals_h1),
    ttH: teamLine(mk.team_totals, home),
    ttA: teamLine(mk.team_totals, away),
    h1H: teamLine(mk.team_totals_h1, home),
    h1A: teamLine(mk.team_totals_h1, away)
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
      book: book ? book.key : null
    };
  });
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  const key = process.env.ODDS_API_KEY;
  if (!key) {
    return { statusCode: 200, headers, body: JSON.stringify({ games: [], error: 'ODDS_API_KEY missing' }) };
  }

  const params = event.queryStringParameters || {};
  const sport = String(params.sport || 'mlb').toLowerCase();
  if (String(params.futures || '') === '1') {
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
    return { statusCode: 200, headers, body: JSON.stringify({ futures, sport, at: Date.now() }) };
  }
  const apiSport = SPORT_MAP[sport];
  if (!apiSport) {
    return { statusCode: 200, headers, body: JSON.stringify({ games: [], error: 'unknown sport' }) };
  }

  const eventId = String(params.event || params.eventId || '').trim();
  if (eventId) {
    const extraMkts = String(params.markets || '').replace(/[^a-z0-9_,]/g,'').slice(0, 240);
    const evKey = 'oddsapi:ev:' + sport + ':' + eventId + ':' + extraMkts;
    const evHit = mem[evKey];
    const fresh = String(params.fresh || '') === '1';
    const evTtl = extraMkts.indexOf('team_totals') >= 0 ? 12 * 60 * 1000 : 8000;
    if (!fresh && evHit && Date.now() - evHit.at < evTtl && evHit.json && (evHit.json.extras || (evHit.json.games && evHit.json.games.length))) {
      headers['X-Board-Cache'] = 'mem-event';
      return { statusCode: 200, headers, body: JSON.stringify(evHit.json) };
    }
    const mktQs = extraMkts ? extraMkts : 'h2h,spreads,totals';
    const evUrl = 'https://api.the-odds-api.com/v4/sports/' + apiSport + '/events/' + encodeURIComponent(eventId) + '/odds?regions=us&markets=' + mktQs + '&oddsFormat=american&apiKey=' + encodeURIComponent(key);
    try {
      const { status, json } = await getJson(evUrl);
      const ev = json && json.id ? json : (Array.isArray(json) ? json[0] : null);
      const games = ev ? normalize(sport, [ev]) : [];
      const props = ev && extraMkts ? normalizeProps(ev) : [];
      const extras = ev && extraMkts.indexOf('team_totals') >= 0 ? normalizeExtras(ev) : null;
      const liveAlts = ev && extraMkts.indexOf('alternate_spreads') >= 0 ? normalizeLiveAlts(ev) : null;
      const err = (!ev && json && (json.message || json.error_code || json.error)) ? (json.message || json.error_code || json.error) : (status && status >= 400 ? ('http '+status) : null);
      const payload = { games, props, extras, liveAlts, sport, eventId, at: Date.now(), error: err, source: extraMkts ? 'event-props' : 'event-odds' };
      if (games.length || extras) mem[evKey] = { at: Date.now(), json: payload };
      return { statusCode: 200, headers, body: JSON.stringify(payload) };
    } catch (e) {
      return { statusCode: 200, headers, body: JSON.stringify({ games: [], error: String(e.message || e), source: 'event-odds' }) };
    }
  }

  const ttl = 12 * 60 * 1000;
  const cacheKey = 'oddsapi:' + sport;
  const fresh = String(params.fresh || '') === '1';
  const period = String(params.period || '').toLowerCase();
  if ((period === 'h1' || period === 'q1' || period === 'p1' || period === 'f5') && sport !== 'tennis') {
    const mks = period === 'q1' ? 'spreads_q1,totals_q1' : period === 'p1' ? 'spreads_p1,totals_p1' : period === 'f5' ? 'spreads_1st_5_innings,totals_1st_5_innings' : 'spreads_h1,totals_h1';
    const pKey = 'oddsapi:' + sport + ':' + period;
    const pHit = mem[pKey];
    if (!fresh && pHit && Date.now() - pHit.at < 12 * 60 * 1000 && pHit.json) {
      headers['X-Board-Cache'] = 'mem-period';
      return { statusCode: 200, headers, body: JSON.stringify(pHit.json) };
    }
    try {
      const pUrl = 'https://api.the-odds-api.com/v4/sports/' + apiSport + '/odds?regions=us&markets=' + mks + '&oddsFormat=american&apiKey=' + encodeURIComponent(key);
      const res = await getJson(pUrl);
      let games = normalizePeriod(sport, Array.isArray(res.json) ? res.json : [], period);
      let err = Array.isArray(res.json) ? null : ((res.json && (res.json.message || res.json.error)) || 'no period lines');
      if (!games.length) {
        const evRes = await getJson('https://api.the-odds-api.com/v4/sports/' + apiSport + '/events?apiKey=' + encodeURIComponent(key));
        const events = (Array.isArray(evRes.json) ? evRes.json : []).slice(0, 16);
        const pulled = [];
        for (const ev of events) {
          if (!ev || !ev.id) continue;
          const one = await getJson('https://api.the-odds-api.com/v4/sports/' + apiSport + '/events/' + encodeURIComponent(ev.id) + '/odds?regions=us&markets=' + mks + '&oddsFormat=american&apiKey=' + encodeURIComponent(key));
          const row = normalizePeriod(sport, one.json && one.json.id ? [one.json] : [], period)[0];
          if (row) pulled.push(Object.assign({ commence: ev.commence_time, home: ev.home_team, away: ev.away_team }, row));
        }
        if (pulled.length) { games = pulled; err = null; }
      }
      const payload = { games, sport, period, at: Date.now(), error: games.length ? null : err };
      if (games.length) mem[pKey] = { at: Date.now(), json: payload };
      return { statusCode: 200, headers, body: JSON.stringify(payload) };
    } catch (e) {
      return { statusCode: 200, headers, body: JSON.stringify({ games: [], error: String(e.message || e), period }) };
    }
  }
  const hit = mem[cacheKey];
  if (!fresh && hit && Date.now() - hit.at < ttl && hit.json && Array.isArray(hit.json.games) && hit.json.games.length) {
    headers['X-Board-Cache'] = 'mem';
    return { statusCode: 200, headers, body: JSON.stringify(hit.json) };
  }

  try {
    const store = await blobStore();
    if (store && !fresh) {
      const blob = await store.get(cacheKey, { type: 'json' });
      if (blob && blob.at && Date.now() - blob.at < ttl && blob.json && Array.isArray(blob.json.games) && blob.json.games.length) {
        mem[cacheKey] = blob;
        headers['X-Board-Cache'] = 'blob';
        return { statusCode: 200, headers, body: JSON.stringify(blob.json) };
      }
    }
  } catch (e) {}

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
    if (games.length) mem[cacheKey] = { at: Date.now(), json: payload };
    try {
      const store = await blobStore();
      if (store && games.length) await store.setJSON(cacheKey, { at: Date.now(), json: payload });
    } catch (e) {}
    headers['X-Board-Cache'] = 'miss';
    return { statusCode: status || 200, headers, body: JSON.stringify(payload) };
  } catch (e) {
    if (hit && hit.json) return { statusCode: 200, headers, body: JSON.stringify(hit.json) };
    return { statusCode: 200, headers, body: JSON.stringify({ games: [], error: String(e.message || e) }) };
  }
};
