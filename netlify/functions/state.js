'use strict';
// The Board data API.
//   GET                      -> what the logged-in user may see (admins: everything except passwords)
//   POST { action, ... }     -> one specific change. There is no "save the whole board" anymore.
// Every request needs "Authorization: Bearer <token>" from the login function.
const B = require('../lib/board');

const STATUSES = ['open', 'won', 'lost', 'push', 'cancelled'];
const SETTLED = ['won', 'lost', 'push', 'cancelled'];
const SEL_FIELDS = ['gid', 'mkt', 'side', 'label', 'odds', 'lockedOdds', 'baseOdds', 'fav', 'matchup', 'sport', 'home', 'away',
  'liveAtAdd', 'gameDate', 'commence', 'baseSpread', 'spreadAdj', 'currentSpread', 'baseTotal', 'totalAdj', 'currentTotal',
  'verifiedSrc', 'verifiedOdds', 'verifiedAt', 'verifiedTeams', 'propPlayer', 'propMarket', 'team', 'oddsApiId'];
const USER_FIELDS = ['anchorAt', 'balanceAnchor', 'cashedOut', 'cashedAt', 'cashedAmount', 'opening', 'team'];
const DEFAULT_SETTINGS = { bettingEnabled: true, minStake: 20, maxStake: 500, minParlayLegs: 2, maxParlayLegs: 6,
  maxParlayFavorites: 3, minParlayStake: 20, disabledSports: [], blockedUsers: [], blockedGames: [] };
const NEG_LIMIT = -500;           // same default the page used
const GAME_OVER_MS = 4 * 3600e3;  // a game that started more than 4h ago is treated as over

const bad = msg => { throw new B.HttpError(400, msg); };
const forbid = () => { throw new B.HttpError(403, 'Admin only.'); };
const str = (v, n) => (v == null ? '' : String(v)).slice(0, n || 200);

function settingsOf(st) {
  const s = Object.assign({}, DEFAULT_SETTINGS, st.settings || {});
  if (s.minStake == null || s.minStake < 20) s.minStake = 20;
  if (s.minParlayStake == null || s.minParlayStake < 20) s.minParlayStake = 20;
  return s;
}
function findTicket(st, userId, id) {
  const keys = Object.keys(st.bets).filter(k => B.sameKey(k, userId));
  for (const k of keys) {
    const t = (st.bets[k] || []).find(b => b && b.id === id);
    if (t) return { key: k, t };
  }
  return null;
}
function cleanSel(s) {
  const o = {};
  SEL_FIELDS.forEach(f => {
    if (s[f] === undefined) return;
    const v = s[f];
    o[f] = typeof v === 'string' ? v.slice(0, 300) : (typeof v === 'number' || typeof v === 'boolean' || v === null ? v : undefined);
    if (o[f] === undefined) delete o[f];
  });
  return o;
}
function validOdds(o) {
  return Number.isFinite(o) && Math.abs(o) >= 100 && Math.abs(o) <= 50000;
}
function startTime(s) {
  const v = s.commence || s.gameDate;
  if (!v || !/T\d\d:/.test(String(v))) return null;   // date-only values carry no start time
  const t = new Date(v).getTime();
  return isNaN(t) ? null : t;
}

// ---------- actions ----------
function placeBet(st, me, body, ctx) {
  const admin = B.isAdmin(me);
  const s = settingsOf(st);
  const idem = str(body.idem, 80);
  if (!idem) bad('Missing bet key. Refresh and try again.');
  const userKey = me.id;
  const seen = (st.idem[userKey] || []).find(x => x.k === idem);
  if (seen) {
    const f = findTicket(st, userKey, seen.id);
    return { noWrite: true, ok: true, duplicate: true, ticket: f && f.t, balance: B.balanceOf(st, userKey) };
  }
  const sels = Array.isArray(body.selections) ? body.selections : [];
  if (!sels.length) bad('No selections');
  if (sels.length > 10) bad('Too many selections');
  const stake = Math.round(Number(body.stake) * 100) / 100;
  if (!Number.isFinite(stake) || stake <= 0) bad('Enter a stake');
  if (stake > 100000) bad('Stake too large');
  const clean = sels.map(x => cleanSel(x || {}));
  const now = Date.now();
  const sigs = {};
  clean.forEach(x => {
    const o = Number(x.lockedOdds != null ? x.lockedOdds : x.odds);
    if (!validOdds(o)) bad('Bad odds on ' + (x.label || 'a selection') + '. Refresh the board.');
    x.odds = o; x.lockedOdds = o;
    if (!x.gid && x.mkt !== 'prop') bad('Missing game on a selection. Refresh the board.');
    const sig = [x.gid, x.mkt, x.side, x.mkt === 'prop' ? x.label : ''].join('|');
    if (sigs[sig]) bad('Same pick is on the slip twice.');
    sigs[sig] = 1;
    const r = x.gid && st.results[x.gid];
    if (r && r.final) bad('That game is already final: ' + (x.matchup || x.label || ''));
    const t0 = startTime(x);
    if (t0 && now > t0 + GAME_OVER_MS) bad('That game is over: ' + (x.matchup || x.label || ''));
  });
  if (!admin) {
    if (!s.bettingEnabled) bad('Betting is temporarily turned off by the admin.');
    if ((s.blockedUsers || []).some(u => B.sameKey(u, me.id))) bad('Your account is currently blocked from placing bets. Contact admin.');
    clean.forEach(x => {
      if (x.sport && (s.disabledSports || []).indexOf(x.sport) >= 0) bad('Betting on ' + String(x.sport).toUpperCase() + ' is currently disabled.');
      if (x.gid && (s.blockedGames || []).map(String).indexOf(String(x.gid)) >= 0) bad('This game is blocked by the admin and cannot be bet on.');
    });
    if (stake < s.minStake) bad('Minimum bet is $' + Number(s.minStake).toFixed(2));
    if (stake > s.maxStake) bad('Maximum bet is $' + Number(s.maxStake).toFixed(2));
    if (clean.length >= 2) {
      if (stake < s.minParlayStake) bad('Parlay minimum is $' + Number(s.minParlayStake).toFixed(2));
      if (clean.length < s.minParlayLegs) bad('Parlays require at least ' + s.minParlayLegs + ' selections');
      if (clean.length > s.maxParlayLegs) bad('Maximum ' + s.maxParlayLegs + ' selections on a parlay');
      const plus = clean.filter(x => x.odds > 0).length;
      const maxPlus = s.maxParlayFavorites != null ? s.maxParlayFavorites : 3;
      if (plus > maxPlus) bad('Parlay limit: max ' + maxPlus + ' plus (+) odds.');
    }
    const limit = Number.isFinite(Number(s.negLimit)) ? Number(s.negLimit) : NEG_LIMIT;
    if (B.balanceOf(st, me.id) - stake < limit) bad('This pending stake would put your balance below the allowed limit ($' + limit.toFixed(2) + ')');
  }
  if (!st.bets[userKey]) st.bets[userKey] = [];
  let id = 'b' + now;
  while (Object.keys(st.bets).some(k => (st.bets[k] || []).some(b => b && b.id === id))) id = 'b' + (Number(id.slice(1)) + 1);
  const ticket = {
    id, time: new Date(now).toISOString(), stake, locked: true, status: 'open',
    verifiedSrc: str(body.verifiedSrc, 200), selections: clean, idem, rev: 1
  };
  st.bets[userKey].unshift(ticket);
  st.idem[userKey] = [{ k: idem, id, at: now }].concat((st.idem[userKey] || []).filter(x => now - x.at < 7 * 864e5)).slice(0, 100);
  let msg = str(body.alertText, 450) || (me.id + ' bet $' + stake.toFixed(2) + ': ' + clean.map(x => x.label).join(' | '));
  if (msg.toLowerCase().indexOf(String(me.id).toLowerCase()) !== 0) msg = me.id + ': ' + msg;
  ctx.after = () => B.sendAlert(msg);
  return { ok: true, ticket, balance: B.balanceOf(st, userKey) };
}

function patchTickets(st, me, body) {
  const patches = Array.isArray(body.patches) ? body.patches.slice(0, 500) : [];
  const out = { ok: true, applied: [], stale: [], missing: [], refused: [] };
  patches.forEach(p => {
    if (!p || !p.userId || !p.id) return;
    const f = findTicket(st, p.userId, p.id);
    if (!f) { out.missing.push(p.id); return; }   // tickets can't be created or brought back this way
    const t = f.t;
    if (p.rev != null && Number(p.rev) !== Number(t.rev || 1)) { out.stale.push(p.id); return; }
    if (p.status != null && STATUSES.indexOf(p.status) < 0) { out.refused.push(p.id); return; }
    if (p.status === 'open' && SETTLED.indexOf(t.status) >= 0 && !p.reopen) { out.refused.push(p.id); return; }
    let changed = false;
    if (p.status != null && p.status !== t.status) { t.status = p.status; changed = true; }
    if (p.settledAt !== undefined && p.settledAt !== t.settledAt) {
      if (p.settledAt === null) delete t.settledAt; else t.settledAt = str(p.settledAt, 40);
      changed = true;
    }
    if (p.paid !== undefined && !!p.paid !== !!t.paid) { t.paid = !!p.paid; changed = true; }
    if (Array.isArray(p.results)) {
      (t.selections || []).forEach((s, i) => {
        const r = p.results[i];
        if (r === undefined) return;
        if (r === null) { if (s.result) { delete s.result; changed = true; } return; }
        if (STATUSES.indexOf(r) >= 0 && s.result !== r) { s.result = r; changed = true; }
      });
    }
    if (Array.isArray(p.gameDates)) {
      (t.selections || []).forEach((s, i) => {
        const g = p.gameDates[i];
        if (g && typeof g === 'string' && g !== s.gameDate) { s.gameDate = g.slice(0, 40); changed = true; }
      });
    }
    if (t.status === 'open') { delete t.settledAt; }
    if (changed) { t.rev = Number(t.rev || 1) + 1; t.updatedBy = me.id; out.applied.push({ id: t.id, rev: t.rev }); }
  });
  if (!out.applied.length) out.noWrite = true;
  return out;
}

function setBalance(st, me, body) {
  const now = Date.now();
  const b = body.balances || {};
  const ids = Object.keys(b);
  if (!ids.length) bad('Nothing to set');
  ids.forEach(id => {
    const v = Math.round(Number(b[id]) * 100) / 100;
    if (!Number.isFinite(v) || Math.abs(v) > 1e7) bad('Invalid number for ' + id);
    st.balanceBase[id] = v; st.balanceBaseAt[id] = now; st.balanceAt[id] = now; st.balanceLock[id] = now;
    st.balances[id] = v;
  });
  return { ok: true, balances: B.computeBalances(st) };
}

function updateUsers(st, me, body) {
  const list = Array.isArray(body.users) ? body.users : [];
  let n = 0;
  list.forEach(p => {
    const u = p && B.findUser(st, p.id);
    if (!u) return;
    USER_FIELDS.forEach(f => { if (p[f] !== undefined) { u[f] = p[f]; n++; } });
    if (p.role === 'admin' || p.role === 'user') {
      if (B.sameKey(u.id, me.id) && p.role !== 'admin') bad('You cannot remove your own admin role.');
      if (u.role !== p.role) { u.role = p.role; u.sv = Number(u.sv || 0) + 1; n++; }
    }
  });
  return n ? { ok: true } : { ok: true, noWrite: true };
}

function createUser(st, me, body) {
  const id = str(body.id, 40).trim();
  const pw = body.password == null ? '' : String(body.password);
  if (!/^[A-Za-z0-9 _.\-]{2,32}$/.test(id)) bad('User ID must be 2-32 letters or numbers');
  if (pw.length < 4) bad('Password too short (min 4)');
  if (B.findUser(st, id)) bad('User ID already exists');
  st.users.push({ id, passHash: B.hashPassword(pw), role: 'user', created: new Date().toISOString(), opening: 0 });
  st.balanceBase[id] = 0; st.balanceBaseAt[id] = Date.now(); st.balances[id] = 0;
  return { ok: true };
}
function deleteUser(st, me, body) {
  const u = B.findUser(st, body.id);
  if (!u) bad('No such user');
  if (B.isAdmin(u)) bad('Cannot delete an admin account');
  st.users = st.users.filter(x => x !== u);
  return { ok: true };
}
function resetPassword(st, me, body) {
  const u = B.findUser(st, body.id);
  if (!u) bad('No such user');
  const pw = body.password == null ? '' : String(body.password);
  if (pw.length < 4) bad('Password too short (min 4)');
  u.passHash = B.hashPassword(pw);
  u.sv = Number(u.sv || 0) + 1;   // signs that user out everywhere
  return { ok: true };
}
function saveSettings(st, me, body) {
  const s = body.settings || {};
  const o = Object.assign({}, settingsOf(st));
  ['minStake', 'maxStake', 'minParlayLegs', 'maxParlayLegs', 'maxParlayFavorites', 'minParlayStake', 'negLimit'].forEach(k => {
    if (s[k] != null && Number.isFinite(Number(s[k]))) o[k] = Number(s[k]);
  });
  if (s.bettingEnabled != null) o.bettingEnabled = !!s.bettingEnabled;
  ['disabledSports', 'blockedUsers', 'blockedGames'].forEach(k => {
    if (Array.isArray(s[k])) o[k] = s[k].map(x => String(x).slice(0, 80)).slice(0, 500);
  });
  st.settings = o;
  return { ok: true, settings: o };
}
function saveWeeks(st, me, body) {
  const map = {};
  st.weeks.concat(Array.isArray(body.weeks) ? body.weeks : []).forEach(w => {
    if (w && w.userId && w.week) map[w.userId + '|' + w.week] = w;
  });
  st.weeks = Object.keys(map).map(k => map[k]);
  return { ok: true };
}
function saveResults(st, me, body) {
  const r = body.results || {};
  let n = 0;
  Object.keys(r).slice(0, 2000).forEach(k => { if (r[k] && typeof r[k] === 'object') { st.results[k] = r[k]; n++; } });
  return n ? { ok: true } : { ok: true, noWrite: true };
}
function cancelTicket(st, me, body) {
  const f = findTicket(st, body.userId, body.id);
  if (!f) bad('Bet not found');
  if (f.t.status !== 'open') bad('Bet is already ' + f.t.status);
  f.t.status = 'cancelled'; f.t.rev = Number(f.t.rev || 1) + 1; f.t.updatedBy = me.id;
  return { ok: true };
}

const ADMIN_ACTIONS = {
  adminPatchTickets: patchTickets, adminSetBalance: setBalance, adminUpdateUsers: updateUsers,
  adminCreateUser: createUser, adminDeleteUser: deleteUser, adminResetPassword: resetPassword,
  adminSaveSettings: saveSettings, adminSaveWeeks: saveWeeks, adminSaveResults: saveResults,
  adminCancelBet: cancelTicket
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: {}, body: '' };
  try {
    const store = await B.getStore(event);
    if (event.httpMethod === 'GET') {
      let view;
      await B.mutate(store, st => { const me = B.requireUser(st, event); view = B.viewFor(st, me); return { noWrite: true }; });
      return B.reply(200, view);
    }
    if (event.httpMethod !== 'POST') return B.reply(405, { error: 'method' });
    const body = B.parseBody(event);
    const action = String(body.action || '');
    const ctx = {};
    const result = await B.mutate(store, st => {
      const me = B.requireUser(st, event);
      ctx.after = null;
      if (action === 'placeBet') return placeBet(st, me, body, ctx);
      if (action === 'me') return { noWrite: true, ok: true, me: B.publicUser(me) };
      const fn = ADMIN_ACTIONS[action];
      if (!fn) bad('Unknown action');
      if (!B.isAdmin(me)) forbid();
      return fn(st, me, body);
    });
    if (ctx.after) { try { await ctx.after(); } catch (e) {} }
    delete result.noWrite; delete result.st;
    return B.reply(200, result);
  } catch (e) { return B.fail(e); }
};
