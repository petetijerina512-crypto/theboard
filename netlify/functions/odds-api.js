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
  tennis: 'tennis_atp_singles'
};

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

function normalize(sport, events) {
  return (events || []).map(ev => {
    const book = pickBook(ev);
    const mk = book ? marketMap(book) : {};
    const h2h = mk.h2h || [];
    const spr = mk.spreads || [];
    const tot = mk.totals || [];
    const home = ev.home_team;
    const away = ev.away_team;
    const over = (tot || []).find(o => /^over$/i.test(o.name));
    const under = (tot || []).find(o => /^under$/i.test(o.name));
    return {
      sport,
      id: ev.id,
      home,
      away,
      commence: ev.commence_time,
      mlH: priceFor(h2h, home),
      mlA: priceFor(h2h, away),
      spread: lineFor(spr, home),
      spH: priceFor(spr, home),
      spA: priceFor(spr, away),
      total: over && over.point != null ? Number(over.point) : (under && under.point != null ? Number(under.point) : null),
      totO: over && over.price != null ? Number(over.price) : null,
      totU: under && under.price != null ? Number(under.price) : null,
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
  const apiSport = SPORT_MAP[sport];
  if (!apiSport) {
    return { statusCode: 200, headers, body: JSON.stringify({ games: [], error: 'unknown sport' }) };
  }

  const ttl = 12 * 60 * 1000;
  const cacheKey = 'oddsapi:' + sport;
  const hit = mem[cacheKey];
  if (hit && Date.now() - hit.at < ttl) {
    headers['X-Board-Cache'] = 'mem';
    return { statusCode: 200, headers, body: JSON.stringify(hit.json) };
  }

  try {
    const store = await blobStore();
    if (store) {
      const blob = await store.get(cacheKey, { type: 'json' });
      if (blob && blob.at && Date.now() - blob.at < ttl && blob.json) {
        mem[cacheKey] = blob;
        headers['X-Board-Cache'] = 'blob';
        return { statusCode: 200, headers, body: JSON.stringify(blob.json) };
      }
    }
  } catch (e) {}

  const url = 'https://api.the-odds-api.com/v4/sports/' + apiSport + '/odds?regions=us&markets=h2h,spreads,totals&oddsFormat=american&apiKey=' + encodeURIComponent(key);
  try {
    const { status, json } = await getJson(url);
    const games = normalize(sport, Array.isArray(json) ? json : []);
    const payload = { games, sport, at: Date.now(), remaining: null };
    mem[cacheKey] = { at: Date.now(), json: payload };
    try {
      const store = await blobStore();
      if (store) await store.setJSON(cacheKey, { at: Date.now(), json: payload });
    } catch (e) {}
    headers['X-Board-Cache'] = 'miss';
    return { statusCode: status || 200, headers, body: JSON.stringify(payload) };
  } catch (e) {
    if (hit && hit.json) return { statusCode: 200, headers, body: JSON.stringify(hit.json) };
    return { statusCode: 200, headers, body: JSON.stringify({ games: [], error: String(e.message || e) }) };
  }
};
