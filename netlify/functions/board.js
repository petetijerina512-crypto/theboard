'use strict';
// Shared server code for The Board: storage, auth, balances, validation.
// Everything that changes data goes through mutate(), which uses Netlify Blobs
// conditional writes (onlyIfMatch) so the grader and bet placement never
// overwrite each other.
const crypto = require('crypto');

const STORE_NAME = 'board-state';
const KEY = 'state';
const AUTH_KEY = 'auth-fails';
const SESSION_DAYS = 30;
const ADMIN_IDS = ['pistol', 'admin', 'knighthawk'];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- storage ----------
let testStore = null;
function setTestStore(s) { testStore = s; }

async function getStore(event) {
  if (testStore) return testStore;
  const mod = require('@netlify/blobs');
  if (process.env.NETLIFY_SITE_ID && process.env.NETLIFY_AUTH_TOKEN) {
    // API mode: reads and writes go to the origin, so they are strongly consistent.
    return mod.getStore({ name: STORE_NAME, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_AUTH_TOKEN });
  }
  if (event && event.blobs && mod.connectLambda) { try { mod.connectLambda(event); } catch (e) {} }
  return mod.getStore({ name: STORE_NAME, consistency: 'strong' });
}

async function readKey(store, key) {
  let r;
  try { r = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' }); }
  catch (e) {
    if (String(e && e.message || '').indexOf('consistency') >= 0) r = await store.getWithMetadata(key, { type: 'json' });
    else throw e;
  }
  return r ? { data: r.data, etag: r.etag } : { data: null, etag: null };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Read-modify-write with optimistic concurrency. fn(state) mutates state in place and
// returns a result. Return { noWrite: true, ... } to skip the write.
async function mutate(store, fn, key) {
  key = key || KEY;
  for (let attempt = 0; attempt < 8; attempt++) {
    const { data, etag } = await readKey(store, key);
    const st = key === KEY ? normalize(data) : (data || {});
    const migrated = key === KEY ? migrate(st) : false;
    const result = (await fn(st)) || {};
    if (result.noWrite && !migrated) return result;
    if (key === KEY) st.updatedAt = Date.now();
    const opts = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
    const w = await store.setJSON(key, st, opts);
    if (w && w.modified === false) { await sleep(40 + Math.random() * 120 * (attempt + 1)); continue; }
    return result;
  }
  throw new HttpError(409, 'The board is busy. Try again.');
}

// Read state (runs migrations and saves them if needed).
async function readState(store) {
  return mutate(store, st => ({ noWrite: true, st }));
}

function normalize(data) {
  const st = data && typeof data === 'object' ? data : {};
  st.users = Array.isArray(st.users) ? st.users : [];
  st.bets = st.bets && typeof st.bets === 'object' ? st.bets : {};
  st.balances = st.balances || {};
  st.balanceBase = st.balanceBase || {};
  st.balanceBaseAt = st.balanceBaseAt || {};
  st.balanceAt = st.balanceAt || {};
  st.balanceLock = st.balanceLock || {};
  st.results = st.results || {};
  st.weeks = Array.isArray(st.weeks) ? st.weeks : [];
  st.idem = st.idem || {};
  st.migrations = st.migrations || {};
  return st;
}

// ---------- passwords ----------
const SCRYPT = { N: 16384, r: 8, p: 1, len: 32 };
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, SCRYPT.len, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), h.toString('base64')].join('$');
}
function checkHash(pw, stored) {
  try {
    const [alg, N, r, p, salt, hash] = String(stored || '').split('$');
    if (alg !== 'scrypt') return false;
    const want = Buffer.from(hash, 'base64');
    const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), want.length, { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(want, got);
  } catch (e) { return false; }
}
// Accept the password exactly as typed; if that fails, also accept it with
// surrounding spaces removed (phones sometimes add a trailing space).
function verifyPassword(input, stored) {
  if (input == null) return false;
  const raw = String(input);
  if (checkHash(raw, stored)) return true;
  const trimmed = raw.trim();
  return trimmed !== raw && trimmed.length > 0 && checkHash(trimmed, stored);
}

// ---------- one-time migrations ----------
const TICKET_FIXES = {
  // Folded in from the hard-coded overrides that used to run on every save
  // (state.js lines 116-136 and index.html getBets/forceKnownResults/fixKnownTickets).
  lost: ['b1792190141750', 'b1792201458545', 'b1792112419360', 'b1792112458574', 'b1792112458573', 'b1792124315187',
    'b1792117145095', 'b1792079169448', 'b1792024585555', 'b1792019978341', 'b1791941532155', 'b1791932550748',
    'b1791076271627', 'b1791073809901'],
  won: ['b1791936910153', 'b1792102007561', 'b1792102043026', 'b1792118452746', 'b1791948459515', 'b1791948607841',
    'b1791932501673', 'b1791939856078'],
  cancelled: ['b1792102045340'],
  wonAt: { b1791940362278: '2026-10-14T01:36:00.000Z', b1791763733006: '2026-10-12T04:00:00.000Z' },
  lostAt: { b1791749762257: '2026-10-11T21:30:00.000Z' },
  settledAt: { b1791660721540: '2026-10-10T22:00:00.000Z' }
};

function migrate(st) {
  let changed = false;
  // 1. Hash any plaintext passwords (every load; cheap when none are left).
  st.users.forEach(u => {
    if (!u) return;
    if (u.password != null && u.password !== '') {
      u.passHash = hashPassword(String(u.password));
      changed = true;
    }
    if ('password' in u) { delete u.password; changed = true; }
  });
  // 2. Admin roles that the old page granted by user id.
  if (!st.migrations.roles1) {
    st.users.forEach(u => { if (u && ADMIN_IDS.indexOf(String(u.id).toLowerCase()) >= 0) u.role = 'admin'; });
    st.migrations.roles1 = Date.now(); changed = true;
  }
  // 3. Apply the old hard-coded ticket fixes once, and give every ticket a revision number.
  if (!st.migrations.ticketFixes1) {
    const setSt = (bt, s, at) => {
      bt.status = s;
      if (s !== 'cancelled') (bt.selections || []).forEach(x => { if (x) x.result = s; });
      if (at) bt.settledAt = at;
    };
    Object.keys(st.bets).forEach(id => {
      (st.bets[id] || []).forEach(bt => {
        if (!bt || !bt.id) return;
        if (TICKET_FIXES.lost.indexOf(bt.id) >= 0) setSt(bt, 'lost');
        if (TICKET_FIXES.won.indexOf(bt.id) >= 0) setSt(bt, 'won');
        if (TICKET_FIXES.cancelled.indexOf(bt.id) >= 0) setSt(bt, 'cancelled');
        if (TICKET_FIXES.wonAt[bt.id]) setSt(bt, 'won', TICKET_FIXES.wonAt[bt.id]);
        if (TICKET_FIXES.lostAt[bt.id]) setSt(bt, 'lost', TICKET_FIXES.lostAt[bt.id]);
        if (TICKET_FIXES.settledAt[bt.id]) bt.settledAt = TICKET_FIXES.settledAt[bt.id];
      });
    });
    st.migrations.ticketFixes1 = Date.now(); changed = true;
  }
  Object.keys(st.bets).forEach(id => (st.bets[id] || []).forEach(bt => {
    if (bt && typeof bt === 'object' && !bt.rev) { bt.rev = 1; changed = true; }
  }));
  return changed;
}

// ---------- sessions ----------
function secret() {
  const s = process.env.SESSION_SECRET || '';
  if (s.length < 32) throw new HttpError(500, 'Server not set up: add SESSION_SECRET (at least 32 characters) in Netlify environment variables.');
  return s;
}
const b64u = buf => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const unb64u = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
function sign(payload) { return b64u(crypto.createHmac('sha256', secret()).update(payload).digest()); }

function makeToken(user) {
  const now = Date.now();
  const body = b64u(JSON.stringify({ u: user.id, sv: Number(user.sv || 0), iat: now, exp: now + SESSION_DAYS * 864e5 }));
  return { token: body + '.' + sign(body), exp: now + SESSION_DAYS * 864e5 };
}
function readToken(event) {
  const h = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return null;
  const [body, mac] = m[1].trim().split('.');
  if (!body || !mac) return null;
  const want = Buffer.from(sign(body));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  let p; try { p = JSON.parse(unb64u(body).toString('utf8')); } catch (e) { return null; }
  if (!p || !p.u || !p.exp || Date.now() > p.exp) return null;
  return p;
}
function findUser(st, id) {
  const want = String(id || '').trim().toLowerCase();
  if (!want) return null;
  return st.users.find(u => u && String(u.id).toLowerCase() === want) || null;
}
// Returns the user for a valid session, or throws 401.
function requireUser(st, event) {
  const p = readToken(event);
  if (!p) throw new HttpError(401, 'Please log in again.');
  const u = findUser(st, p.u);
  if (!u || Number(u.sv || 0) !== Number(p.sv || 0)) throw new HttpError(401, 'Please log in again.');
  return u;
}
const isAdmin = u => !!(u && u.role === 'admin');

// ---------- money ----------
const dec = o => (o > 0 ? o / 100 + 1 : 100 / Math.abs(o) + 1);
function ticketNet(bt) {
  if (!bt || (bt.status !== 'won' && bt.status !== 'lost')) return 0;
  const stake = Number(bt.stake || 0);
  if (bt.status === 'lost') return -stake;
  let d = 1;
  (bt.selections || []).forEach(s => {
    if (!s || s.result === 'push') return;
    const o = Number(s.lockedOdds != null ? s.lockedOdds : s.odds || 0);
    if (o) d *= dec(o);
  });
  return stake * (d - 1);
}
function computeBalances(st) {
  const balances = Object.assign({}, st.balances || {});
  Object.keys(st.bets).forEach(id => {
    const start = Number(st.balanceBaseAt[id] || 0);
    let net = 0;
    (st.bets[id] || []).forEach(bt => {
      if (!bt || (bt.status !== 'won' && bt.status !== 'lost')) return;
      const when = new Date(bt.settledAt || 0).getTime();
      if (start && when && when <= start) return;
      net += ticketNet(bt);
    });
    balances[id] = Math.round((Number(st.balanceBase[id] || 0) + net) * 100) / 100;
  });
  if (st.balanceBase.BigA01 === 0) balances.BigA01 = 0;
  return balances;
}
function balanceOf(st, userId) {
  const b = computeBalances(st);
  return Number(b[userId] || 0);
}

// ---------- views ----------
function publicUser(u) {
  const o = Object.assign({}, u);
  delete o.password; delete o.passHash; delete o.sv;
  return o;
}
function sameKey(a, b) { return String(a).toLowerCase() === String(b).toLowerCase(); }

function viewFor(st, me) {
  const balances = computeBalances(st);
  const base = {
    me: publicUser(me),
    settings: st.settings || null,
    results: st.results || {},
    updatedAt: st.updatedAt || 0,
    serverTime: Date.now()
  };
  if (isAdmin(me)) {
    return Object.assign(base, {
      users: st.users.map(publicUser),
      bets: st.bets,
      balances,
      balanceBase: st.balanceBase, balanceBaseAt: st.balanceBaseAt, balanceAt: st.balanceAt, balanceLock: st.balanceLock,
      weeks: st.weeks,
      grader: st.grader || null,
      balanceLog: st.balanceLog || []
    });
  }
  const mine = Object.keys(st.bets).filter(k => sameKey(k, me.id));
  const bets = {}; const bal = {};
  mine.forEach(k => { bets[k] = st.bets[k]; });
  if (!bets[me.id]) bets[me.id] = [];
  bal[me.id] = Number(balances[me.id] || 0);
  const settings = st.settings ? Object.assign({}, st.settings, {
    blockedUsers: (st.settings.blockedUsers || []).filter(x => sameKey(x, me.id))
  }) : null;
  return Object.assign(base, {
    users: [publicUser(me)],
    bets,
    balances: bal,
    balanceAt: st.balanceAt[me.id] ? { [me.id]: st.balanceAt[me.id] } : {},
    settings,
    weeks: st.weeks.filter(w => w && sameKey(w.userId, me.id))
  });
}

// ---------- alerts (Telegram) ----------
async function sendAlert(msg) {
  const token = process.env.TELEGRAM_BOT_TOKEN || process.env.TG_TOKEN;
  const chats = String(process.env.TELEGRAM_CHAT_IDS || process.env.TG_CHATS || '').split(',').map(s => s.trim()).filter(Boolean);
  const results = [];
  if (!token || !chats.length || !msg) return results;
  for (const chat of chats) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text: String(msg).slice(0, 500) }), signal: ctrl.signal
      });
      clearTimeout(t);
      results.push({ ok: res.ok });
    } catch (e) { results.push({ ok: false }); }
  }
  const resendKey = process.env.RESEND_KEY;
  const emailTo = process.env.ALERT_EMAIL || 'pete_tijerina@icloud.com'; // same default as the old sms.js
  if (resendKey && emailTo) {
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'The Board <alerts@theboard.my>', to: [emailTo], subject: 'Bet', text: String(msg).slice(0, 500) })
      });
    } catch (e) {}
  }
  return results;
}

// ---------- http helpers ----------
const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const reply = (statusCode, body) => ({ statusCode, headers: HEADERS, body: JSON.stringify(body) });
function fail(e) {
  if (e instanceof HttpError) return reply(e.status, { error: e.message });
  console.log('server error', e && e.stack || e);
  return reply(500, { error: 'Server error. Try again.' });
}
function parseBody(event) {
  try { return JSON.parse(event.body || '{}') || {}; } catch (e) { throw new HttpError(400, 'Bad request'); }
}
function clientIp(event) {
  const h = event.headers || {};
  return String(h['x-nf-client-connection-ip'] || h['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
}

module.exports = {
  HttpError, setTestStore, getStore, mutate, readState, readKey, normalize, migrate,
  hashPassword, verifyPassword, makeToken, readToken, requireUser, findUser, isAdmin,
  ticketNet, computeBalances, balanceOf, viewFor, publicUser, sendAlert,
  reply, fail, parseBody, clientIp, KEY, AUTH_KEY, sameKey
};
