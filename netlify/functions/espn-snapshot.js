'use strict';
// 1158: one shared compact ESPN score snapshot for every phone.
// Uses the existing odds-cache Blob store and cached() helper (1115/1130):
// one refresh is shared, so ESPN is not fetched per browser. Live / soon-to-start
// sports refresh about every 10s; idle sports about every 2 minutes.
// Allowlisted ESPN hosts only. Slim fields only (no raw scoreboard, no odds).
// The LIVE section and 1157 live-parlay detection read isLive from this feed.

const OA = require('./odds-api');

const TTL_LIVE_MS = 10 * 1000;
const TTL_IDLE_MS = 2 * 60 * 1000;
const SOON_MS = 60 * 60 * 1000; // kickoff within an hour counts as soon
const FETCH_MS = 8000;
const MAX_BYTES = 2 * 1024 * 1024;

const ALLOWED_HOSTS = { 'site.api.espn.com': true, 'site.web.api.espn.com': true };
const ALLOWED_PATH = /^\/apis\/(?:site\/v2\/sports\/|v2\/scoreboard\/)/i;

const ESPN = {
  nfl: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard',
  nba: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard',
  mlb: 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard',
  nhl: 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard',
  ncaaf: 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard',
  wnba: 'https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard',
  mma: 'https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard',
  pfl: 'https://site.api.espn.com/apis/site/v2/sports/mma/pfl/scoreboard',
  epl: 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard',
  laliga: 'https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/scoreboard',
  bundesliga: 'https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/scoreboard',
  seriea: 'https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/scoreboard',
  ligue1: 'https://site.api.espn.com/apis/site/v2/sports/soccer/fra.1/scoreboard',
  mls: 'https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/scoreboard',
  ucl: 'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/scoreboard',
  ligamx: 'https://site.api.espn.com/apis/site/v2/sports/soccer/mex.1/scoreboard',
  uel: 'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.europa/scoreboard',
  facup: 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.fa/scoreboard',
  efl: 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.2/scoreboard',
  ere: 'https://site.api.espn.com/apis/site/v2/sports/soccer/ned.1/scoreboard',
  liga_pt: 'https://site.api.espn.com/apis/site/v2/sports/soccer/por.1/scoreboard',
  brazil: 'https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/scoreboard',
  libertadores: 'https://site.api.espn.com/apis/site/v2/sports/soccer/conmebol.libertadores/scoreboard',
  ligaarg: 'https://site.api.espn.com/apis/site/v2/sports/soccer/arg.1/scoreboard',
  superlig: 'https://site.api.espn.com/apis/site/v2/sports/soccer/tur.1/scoreboard',
  ncaab: 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard',
  ncaaw: 'https://site.api.espn.com/apis/site/v2/sports/basketball/womens-college-basketball/scoreboard',
  cfl: 'https://site.api.espn.com/apis/site/v2/sports/football/cfl/scoreboard',
  tennis: 'https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard'
};

const SPORTS = Object.keys(ESPN);

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'public, max-age=0, must-revalidate',
  'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=10, stale-while-revalidate=10'
};

let fetchImpl = null;
function getFetch() { return fetchImpl || global.fetch; }

function allowedUrl(raw) {
  if (raw == null) return null;
  const s = String(raw);
  if (!s || s.length > 1024) return null;
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  const host = String(u.hostname || '').toLowerCase();
  if (!ALLOWED_HOSTS[host]) return null;
  if (!ALLOWED_PATH.test(u.pathname || '')) return null;
  return u.toString();
}

function espnDayStamp(offset) {
  const d = new Date(Date.now() + (Number(offset) || 0) * 86400000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d);
  const get = t => parts.find(p => p.type === t).value;
  return get('year') + get('month') + get('day');
}

function sportUrls(sport, stamp) {
  const base = ESPN[sport];
  if (!base) return [];
  const join = base.indexOf('?') >= 0 ? '&' : '?';
  let u = base + join + 'dates=' + stamp + '&limit=300';
  if (sport === 'ncaaf') u += '&groups=80';
  if (sport === 'ncaab' || sport === 'ncaaw') u += '&groups=50';
  const out = [u];
  if (sport === 'tennis') out.push(u.replace('/tennis/atp/', '/tennis/wta/'));
  return out.filter(x => !!allowedUrl(x));
}

function slimTeam(c, fallback) {
  const x = c || {};
  const team = x.team || {};
  const ath = x.athlete || {};
  const name = ath.shortName || ath.displayName || ath.fullName || team.shortDisplayName || team.displayName || fallback;
  const fullName = ath.displayName || ath.fullName || team.displayName || name || '';
  const abbrev = team.abbreviation || team.shortDisplayName || '';
  const logo = team.logo || (team.logos && team.logos[0] && team.logos[0].href) || (ath.flag && ath.flag.href) || '';
  const score = x.score != null ? x.score : '';
  const periods = (x.linescores || []).map(l => Number(l.value != null ? l.value : l.displayValue)).filter(n => !isNaN(n));
  const out = { name: name || fallback, fullName: fullName, abbrev: abbrev, logo: logo, score: score };
  if (team.location) out.loc = team.location;
  if (team.name) out.nick = team.name;
  if (periods.length >= 2) out.half = periods[0] + periods[1];
  if (periods.length) out.periods = periods;
  return out;
}

function parseCompetition(ev, comp, sport, idx) {
  const statusSrc = (comp && comp.status) || ev.status || {};
  const status = statusSrc.type || statusSrc || {};
  const competitors = (comp && comp.competitors) || [];
  const home = competitors.find(c => c.homeAway === 'home') || competitors[0] || {};
  const away = competitors.find(c => c.homeAway === 'away') || competitors[1] || {};
  const desc = String(status.description || '');
  const detail = String(status.detail || status.shortDetail || ev.name || '');
  const state = String(status.state || '');
  const finalish = /final|full time|^ft$|ended/i.test(desc + ' ' + detail);
  const g = {
    id: String((comp && comp.id) || ev.id) + (idx ? '-' + idx : ''),
    sport: sport,
    date: (comp && (comp.date || comp.startDate)) || ev.date || '',
    status: desc,
    detail: detail,
    state: state,
    period: Number(statusSrc.period) || 0,
    home: slimTeam(home, 'Home'),
    away: slimTeam(away, 'Away'),
    espn: true,
    isLive: state === 'in' && !finalish,
    isFinal: state === 'post' || finalish
  };
  return g;
}

function parseEvent(ev, sport) {
  const comps = ev.competitions || [];
  if (sport === 'tennis') {
    const out = [];
    const groups = ev.groupings || [];
    const singles = groups.filter(gr => /singles/i.test(String((gr.grouping || {}).slug || '')));
    const src = singles.length ? singles : [{ competitions: comps }];
    src.forEach(gr => (gr.competitions || []).forEach(c => {
      if (!c || !c.id) return;
      const g = parseCompetition(ev, c, 'tennis', 0);
      g.id = 'ten-' + c.id;
      const cs = c.competitors || [];
      const side = (x, t) => {
        if (!x || !t) return;
        const a = x.athlete || {};
        t.name = a.displayName || t.name;
        t.fullName = a.displayName || t.fullName || '';
        const ls = (x.linescores || []).map(l => ({ v: Number(l.value), w: l.winner === true }));
        t.sets = ls.filter(l => l.w).length;
        t.games = ls.length ? ls[ls.length - 1].v : null;
        t.setLines = ls.map(l => l.v);
        t.score = String(t.sets);
      };
      side(cs.find(x => x.homeAway === 'home') || cs[0], g.home);
      side(cs.find(x => x.homeAway === 'away') || cs[1], g.away);
      g.tennisSet = Number((c.status || {}).period) || 0;
      out.push(g);
    }));
    return out;
  }
  if (!comps.length) {
    const g = parseCompetition(ev, ev, sport, 0);
    return g && g.id ? [g] : [];
  }
  return comps.map((c, i) => parseCompetition(ev, c, sport, i));
}

function sportTtlMs(json) {
  const games = (json && json.games) || [];
  const now = Date.now();
  for (let i = 0; i < games.length; i++) {
    const g = games[i];
    if (g && g.isLive) return TTL_LIVE_MS;
    const t = Date.parse(g && g.date);
    if (!isNaN(t) && t <= now + SOON_MS && t + 4 * 60 * 60 * 1000 >= now) return TTL_LIVE_MS;
  }
  return TTL_IDLE_MS;
}

async function fetchEspnJson(url) {
  const target = allowedUrl(url);
  if (!target) return null;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), FETCH_MS);
  try {
    const res = await getFetch()(target, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { Accept: 'application/json,text/plain,*/*' }
    });
    if (!res || !res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) return null;
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    return null;
  } finally {
    clearTimeout(to);
  }
}

async function loadSport(ctx, sport, stamp) {
  const key = 'espn:sb:' + sport + ':' + stamp;
  const r = await OA.cached(ctx, key, json => sportTtlMs(json), 0, async () => {
    const urls = sportUrls(sport, stamp);
    const chunks = await Promise.all(urls.map(fetchEspnJson));
    const games = [];
    const seen = {};
    chunks.forEach(data => {
      if (!data) return;
      (data.events || []).forEach(ev => {
        parseEvent(ev, sport).forEach(g => {
          if (g && g.id && !seen[g.id]) { seen[g.id] = true; games.push(g); }
        });
      });
    });
    return { json: { games: games, sport: sport, at: Date.now() }, cacheable: true };
  });
  return (r && r.json && r.json.games) || [];
}

function json(status, body, extra) {
  const h = Object.assign({}, headers, extra || {});
  return { statusCode: status, headers: h, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod && event.httpMethod !== 'GET') return json(405, { error: 'GET only' });
  const stamp = espnDayStamp(0);
  const ctx = OA.makeCtx(event);
  const lists = await Promise.all(SPORTS.map(sp => loadSport(ctx, sp, stamp).catch(() => [])));
  const games = [];
  const seen = {};
  lists.forEach(list => (list || []).forEach(g => {
    if (g && g.id && !seen[g.id]) { seen[g.id] = true; games.push(g); }
  }));
  return json(200, { games: games, at: Date.now(), stamp: stamp });
};

exports._test = {
  allowedUrl,
  ESPN,
  SPORTS,
  TTL_LIVE_MS,
  TTL_IDLE_MS,
  SOON_MS,
  sportTtlMs,
  sportUrls,
  espnDayStamp,
  parseEvent,
  parseCompetition,
  slimTeam,
  setFetch(fn) { fetchImpl = fn; }
};
