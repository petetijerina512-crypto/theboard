const https = require('https');

const ESPN = {
  nfl: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard',
  nba: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard',
  mlb: 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard',
  nhl: 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard',
  ncaaf: 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard',
  wnba: 'https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard',
  mma: 'https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard',
  epl: 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard',
  laliga: 'https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/scoreboard',
  bundesliga: 'https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/scoreboard',
  seriea: 'https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/scoreboard',
  mls: 'https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/scoreboard',
  ucl: 'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/scoreboard'
};

const KALSHI = {
  mlb: 'KXMLBGAME',
  nfl: 'KXNFLGAME',
  ncaaf: 'KXNCAAFGAME',
  nba: 'KXNBAGAME',
  nhl: 'KXNHLGAME'
};

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'TheBoard/1.0' } }, (res) => {
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

function fighterName(c) {
  if (!c) return '';
  if (c.athlete) return c.athlete.shortName || c.athlete.displayName || '';
  if (c.team) return c.team.shortDisplayName || c.team.displayName || '';
  return c.displayName || c.name || '';
}
function fighterAbbr(c) {
  if (!c) return '';
  if (c.athlete) {
    const n = c.athlete.displayName || '';
    const parts = n.split(' ');
    return parts.length > 1 ? parts[parts.length - 1] : n;
  }
  if (c.team) return c.team.abbreviation || c.team.shortDisplayName || '';
  return c.abbreviation || fighterName(c);
}
function fighterLogo(c) {
  if (!c) return '';
  if (c.team && c.team.logo) return c.team.logo;
  return '';
}
function closeOdds(sideObj) {
  const c = sideObj && sideObj.close;
  if (!c || c.odds == null) return null;
  const n = parseFloat(String(c.odds).replace('+', ''));
  return isNaN(n) ? null : n;
}
function closeLine(sideObj) {
  const c = sideObj && sideObj.close;
  if (!c || c.line == null) return null;
  const n = parseFloat(String(c.line).replace('+', ''));
  return isNaN(n) ? null : n;
}

function parseCompetition(ev, comp, sport, idx) {
  const statusSrc = (comp && comp.status) || ev.status || {};
  const status = statusSrc.type || statusSrc || {};
  const competitors = (comp && comp.competitors) || [];
  const home = competitors.find(c => c.homeAway === 'home') || competitors[0] || {};
  const away = competitors.find(c => c.homeAway === 'away') || competitors[1] || {};
  const rawOdds = ((comp && comp.odds) || []).filter(Boolean);
  const odds = rawOdds[0] || {};
  const ps = odds.pointSpread || {};
  const mlBlock = odds.moneyline || {};
  const mlH = closeOdds(mlBlock.home) ?? (odds.homeTeamOdds && odds.homeTeamOdds.moneyLine) ?? null;
  const mlA = closeOdds(mlBlock.away) ?? (odds.awayTeamOdds && odds.awayTeamOdds.moneyLine) ?? null;
  const homeSpr = closeLine(ps.home);
  const spread = homeSpr != null ? homeSpr : (odds.spread != null ? Number(odds.spread) : null);
  const state = status.state || '';
  return {
    id: String((comp && comp.id) || ev.id) + (idx ? '-' + idx : ''),
    sport,
    date: (comp && (comp.date || comp.startDate)) || ev.date || '',
    status: status.description || '',
    detail: status.detail || status.shortDetail || ev.name || '',
    state,
    isLive: state === 'in',
    isFinal: state === 'post',
    home: { name: fighterName(home) || 'Home', abbrev: fighterAbbr(home), logo: fighterLogo(home), score: home.score ?? '' },
    away: { name: fighterName(away) || 'Away', abbrev: fighterAbbr(away), logo: fighterLogo(away), score: away.score ?? '' },
    odds: {
      mlH: mlH,
      mlA: mlA,
      spread: spread,
      spH: closeOdds(ps.home),
      spA: closeOdds(ps.away),
      total: closeLine((odds.total || {}).over) ?? (odds.overUnder != null ? Number(odds.overUnder) : null)
    }
  };
}

function parseEvent(ev, sport) {
  const comps = ev.competitions || [ev];
  return comps.map((c, i) => parseCompetition(ev, c, sport, i));
}

async function fetchSport(key) {
  const data = await getJson(ESPN[key]);
  if (!data) return [];
  const out = [];
  const seen = {};
  (data.events || []).forEach(ev => {
    parseEvent(ev, key).forEach(g => {
      if (g && g.id && !seen[g.id]) { seen[g.id] = true; out.push(g); }
    });
  });
  return out;
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
      const ha = String(g.home.abbrev || '').toLowerCase();
      const aa = String(g.away.abbrev || '').toLowerCase();
      if ((hn && title.indexOf(hn) >= 0) || (ha && ha.length > 2 && title.indexOf(ha) >= 0)) {
        g.odds.mlH = amer; g.oddsSrc = 'Kalshi';
      }
      if ((an && title.indexOf(an) >= 0) || (aa && aa.length > 2 && title.indexOf(aa) >= 0)) {
        g.odds.mlA = amer; g.oddsSrc = 'Kalshi';
      }
    });
  });
}

async function buildOdds() {
  const keys = Object.keys(ESPN);
  const lists = await Promise.all(keys.map(k => fetchSport(k)));
  const games = [];
  lists.forEach(list => list.forEach(g => games.push(g)));
  const sports = Object.keys(KALSHI);
  await Promise.all(sports.map(async sp => {
    const mk = await fetchKalshi(KALSHI[sp]);
    attachKalshi(games, mk, sp);
  }));
  return { games, updatedAt: Date.now(), count: games.length };
}

module.exports = { buildOdds };
