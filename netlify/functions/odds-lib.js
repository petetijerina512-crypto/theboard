const https = require('https');

const HEADER = {
  nfl: 'football/nfl',
  nba: 'basketball/nba',
  mlb: 'baseball/mlb',
  nhl: 'hockey/nhl',
  ncaaf: 'football/college-football',
  wnba: 'basketball/wnba',
  mma: 'mma/ufc',
  epl: 'soccer/eng.1',
  laliga: 'soccer/esp.1',
  bundesliga: 'soccer/ger.1',
  seriea: 'soccer/ita.1',
  mls: 'soccer/usa.1',
  ucl: 'soccer/uefa.champions'
};

const KALSHI = {
  mlb: 'KXMLBGAME',
  nfl: 'KXNFLGAME',
  ncaaf: 'KXNCAAFGAME',
  nba: 'KXNBAGAME',
  nhl: 'KXNHLGAME'
};

function getJson(url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/json,text/plain,*/*',
        Referer: 'https://www.espn.com/'
      }
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
  });
}

function num(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace('+', '').replace('o', '').replace('u', ''));
  return isNaN(n) ? null : n;
}

function parseHeaderEvent(ev, sport) {
  const comps = ev.competitors || [];
  const home = comps.find(c => c.homeAway === 'home') || comps[0] || {};
  const away = comps.find(c => c.homeAway === 'away') || comps[1] || {};
  const st = (ev.fullStatus && ev.fullStatus.type) || ev.status || {};
  const type = st.type || st;
  const state = type.state || '';
  const odds = ev.odds || {};
  const ps = odds.pointSpread || {};
  const ml = odds.moneyline || {};
  const homeML = num(odds.home && odds.home.moneyLine) ?? num(odds.homeTeamOdds && odds.homeTeamOdds.moneyLine) ?? num(ml.home && ((ml.home.current && ml.home.current.odds) || (ml.home.close && ml.home.close.odds)));
  const awayML = num(odds.away && odds.away.moneyLine) ?? num(odds.awayTeamOdds && odds.awayTeamOdds.moneyLine) ?? num(ml.away && ((ml.away.current && ml.away.current.odds) || (ml.away.close && ml.away.close.odds)));
  const homeSpr = num(ps.home && ((ps.home.current && ps.home.current.line) || (ps.home.close && ps.home.close.line))) ?? num(odds.spread);
  const spH = num(ps.home && ((ps.home.current && ps.home.current.odds) || (ps.home.close && ps.home.close.odds))) ?? num(odds.homeTeamOdds && odds.homeTeamOdds.spreadOdds);
  const spA = num(ps.away && ((ps.away.current && ps.away.current.odds) || (ps.away.close && ps.away.close.odds))) ?? num(odds.awayTeamOdds && odds.awayTeamOdds.spreadOdds);
  const tot = odds.total || {};
  const total = num(tot.over && ((tot.over.current && tot.over.current.line) || (tot.over.close && tot.over.close.line))) ?? num(odds.overUnder);
  return {
    id: String(ev.competitionId || ev.id),
    sport,
    date: ev.date || '',
    status: type.description || '',
    detail: type.detail || type.shortDetail || ev.summary || ev.shortName || '',
    state,
    isLive: state === 'in',
    isFinal: state === 'post' || !!type.completed,
    home: {
      name: home.displayName || home.name || 'Home',
      abbrev: home.abbreviation || '',
      logo: home.logo || '',
      score: home.score ?? ''
    },
    away: {
      name: away.displayName || away.name || 'Away',
      abbrev: away.abbreviation || '',
      logo: away.logo || '',
      score: away.score ?? ''
    },
    odds: { mlH: homeML, mlA: awayML, spread: homeSpr, spH, spA, total }
  };
}

async function fetchSport(key) {
  const pair = HEADER[key];
  if (!pair) return [];
  const [sport, league] = pair.split('/');
  const url = 'https://site.web.api.espn.com/apis/v2/scoreboard/header?sport=' + encodeURIComponent(sport) + '&league=' + encodeURIComponent(league);
  const data = await getJson(url);
  const pack = ((((data || {}).sports || [])[0] || {}).leagues || [])[0] || {};
  return (pack.events || []).map(ev => parseHeaderEvent(ev, key));
}

function yesProb(m) {
  const bid = Number(m.yes_bid_dollars != null ? m.yes_bid_dollars : m.yes_bid);
  const ask = Number(m.yes_ask_dollars != null ? m.yes_ask_dollars : m.yes_ask);
  const last = Number(m.last_price_dollars != null ? m.last_price_dollars : m.last_price);
  let p = last;
  if (bid && ask) p = (bid + ask) / 2;
  if (p > 1) p = p / 100;
  return p;
}
function toAmer(p) {
  if (!p || p <= 0 || p >= 1) return null;
  if (p >= 0.5) return Math.round(-100 * p / (1 - p));
  return Math.round(100 * (1 - p) / p);
}

async function fetchKalshi(series) {
  const url = 'https://external-api.kalshi.com/trade-api/v2/markets?series_ticker=' + series + '&status=open&limit=200';
  const json = await getJson(url);
  return (json && json.markets) || [];
}

function attachKalshi(games, markets, sport) {
  markets.forEach(m => {
    const title = String(m.title || m.subtitle || m.ticker || '').toLowerCase();
    const amer = toAmer(yesProb(m));
    if (amer == null) return;
    games.forEach(g => {
      if (g.sport !== sport) return;
      const hn = String(g.home.name || '').toLowerCase();
      const an = String(g.away.name || '').toLowerCase();
      if (hn && title.indexOf(hn.split(' ').pop()) >= 0) { g.odds.mlH = amer; g.oddsSrc = 'Kalshi'; }
      if (an && title.indexOf(an.split(' ').pop()) >= 0) { g.odds.mlA = amer; g.oddsSrc = 'Kalshi'; }
    });
  });
}

async function buildOdds() {
  const keys = Object.keys(HEADER);
  const lists = await Promise.all(keys.map(k => fetchSport(k)));
  const games = [];
  lists.forEach(list => list.forEach(g => games.push(g)));
  await Promise.all(Object.keys(KALSHI).map(async sp => {
    attachKalshi(games, await fetchKalshi(KALSHI[sp]), sp);
  }));
  return { games, updatedAt: Date.now(), count: games.length };
}

module.exports = { buildOdds };
