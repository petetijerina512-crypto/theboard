'use strict';
// (1125) The Board casino: Blackjack. Admins only while it is being tested.
//
// Everything is decided here, on the server. The phone only sends "deal $X", "hit", "stand", "double", "split"
// and gets back what it is allowed to see. It never receives the dealer's hole card or the shoe until the hand is over.
//
// Fair deal (anyone can check a hand afterwards):
//   - A fresh 6-deck shoe is shuffled for every hand with crypto.randomInt (Fisher-Yates). Nothing else picks cards.
//   - Before the first card is shown, the server publishes commit = SHA-256(shoe + ":" + salt), salt = 16 random bytes.
//   - Cards are drawn strictly from the top of that shoe, in order. A player's choice never re-orders the shoe.
//   - When the hand ends, the shoe and salt are revealed and saved with the hand, so the hash and every card dealt can
//     be re-checked (admin Casino card -> Verify).
//
// Money: the stake comes off the balance the moment the hand is dealt (the hand in progress is counted in the balance),
// and the result is booked in the same write that saves the finished hand. A finished hand is saved as an ordinary
// settled ticket on the player's account, worth exactly its net: won = profit at even money, lost = the loss, push = 0.
// So balances, cash outs and the calendar treat it like any graded ticket, and older versions of the site (1124) add
// up the same balances if the casino files are ever removed.
//
// Rules: 6 decks, fresh shoe each hand, dealer stands on all 17s (soft 17 too), dealer peeks for blackjack with an
// ace or ten showing, blackjack pays 3:2, double on any first two cards (also after a split, not on split aces),
// one split of two equal-value cards (split aces get one card each; 21 after a split is not a blackjack), no insurance.
const crypto = require('crypto');
const B = require('./board');

const DEFAULTS = { enabled: true, min: 1, max: 100 };
const DECKS = 6;
const NEG_LIMIT = -500;
const CODE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';   // one letter per card (0..51)
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];
const SUITS = ['S', 'H', 'D', 'C'];
const RULES = '6 decks, new shoe every hand, dealer stands on soft 17, blackjack pays 3:2, double any 2 cards, 1 split';

const bad = msg => { throw new B.HttpError(400, msg); };
const forbid = msg => { throw new B.HttpError(403, msg || 'The casino is open to admins only while it is being tested.'); };
const round2 = n => Math.round(Number(n || 0) * 100) / 100;
const str = (v, n) => (v == null ? '' : String(v)).slice(0, n || 200);
const sha256 = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// ---------- cards ----------
function cardOf(ch) { const i = CODE.indexOf(ch); if (i < 0) throw new Error('bad card'); return RANKS[i % 13] + SUITS[Math.floor(i / 13)]; }
function newShoe(randInt) {
  randInt = randInt || crypto.randomInt;
  const a = [];
  for (let d = 0; d < DECKS; d++) for (let i = 0; i < 52; i++) a.push(CODE[i]);
  for (let i = a.length - 1; i > 0; i--) { const j = randInt(i + 1); const t = a[i]; a[i] = a[j]; a[j] = t; }
  return a.join('');
}
const commitOf = (shoe, salt) => sha256(shoe + ':' + salt);
function val(card) { const r = card[0]; return r === 'A' ? 1 : (r === 'T' || r === 'J' || r === 'Q' || r === 'K') ? 10 : Number(r); }
function total(cards) {
  let t = 0, ace = false;
  cards.forEach(c => { t += val(c); if (c[0] === 'A') ace = true; });
  const soft = ace && t + 10 <= 21;
  return { total: soft ? t + 10 : t, soft };
}
const isBJ = cards => cards.length === 2 && total(cards).total === 21;

// ---------- one hand (pure; tests drive these directly) ----------
function draw(h) {
  if (h.pos >= h.shoe.length) throw new Error('shoe empty');
  const ch = h.shoe[h.pos++];
  h.draws += ch;
  return cardOf(ch);
}
function startHand(o) {
  const shoe = o.shoe || newShoe();
  const salt = o.salt || crypto.randomBytes(16).toString('hex');
  const h = {
    id: o.id, user: o.user, game: 'blackjack', startedAt: o.at, idem: o.idem || '', bet: o.bet,
    shoe, salt, commit: commitOf(shoe, salt), pos: 0, draws: '',
    dealer: [], hands: [{ cards: [], bet: o.bet, doubled: false, done: false, split: false, splitAces: false }],
    cur: 0, seq: 0, phase: 'player', log: [{ a: 'deal', at: o.at }], balanceBefore: o.balanceBefore
  };
  const p = h.hands[0];
  p.cards.push(draw(h)); h.dealer.push(draw(h)); p.cards.push(draw(h)); h.dealer.push(draw(h));
  const up = h.dealer[0];
  const peek = up[0] === 'A' || val(up) === 10;
  if ((peek && isBJ(h.dealer)) || isBJ(p.cards)) { p.done = true; finish(h); }
  return h;
}
function wagered(h) { return round2(h.hands.reduce((n, x) => n + x.bet, 0)); }
function canDo(h) {
  if (h.phase !== 'player') return {};
  const x = h.hands[h.cur];
  const two = x.cards.length === 2;
  return {
    hit: !x.done, stand: !x.done,
    double: !x.done && two && !x.splitAces,
    split: !x.done && two && h.hands.length === 1 && val(x.cards[0]) === val(x.cards[1])
  };
}
// extra = more money the action puts at risk (double / split); checkMoney throws if not allowed
function act(h, a, at, checkMoney) {
  if (h.phase !== 'player') bad('This hand is over.');
  const can = canDo(h);
  if (!can[a]) bad(a === 'double' ? 'You can only double on your first two cards.' : a === 'split' ? 'Only two cards of the same value can be split (one split per hand).' : 'Not allowed now.');
  const x = h.hands[h.cur];
  if (a === 'double' || a === 'split') checkMoney(x.bet);
  if (a === 'hit') {
    x.cards.push(draw(h));
    const t = total(x.cards).total;
    if (t >= 21) x.done = true;
  } else if (a === 'stand') {
    x.done = true;
  } else if (a === 'double') {
    x.bet = round2(x.bet * 2); x.doubled = true;
    x.cards.push(draw(h)); x.done = true;
  } else if (a === 'split') {
    const aces = x.cards[0][0] === 'A';
    const y = { cards: [x.cards.pop()], bet: x.bet, doubled: false, done: false, split: true, splitAces: aces };
    x.split = true; x.splitAces = aces;
    h.hands.push(y);
    x.cards.push(draw(h));
    if (aces) { y.cards.push(draw(h)); x.done = true; y.done = true; }
    else if (total(x.cards).total === 21) x.done = true;
  }
  h.seq++;
  h.log.push({ a, h: h.cur, at });
  advance(h);
  return h;
}
function advance(h) {
  while (h.cur < h.hands.length) {
    const x = h.hands[h.cur];
    if (x.cards.length === 1) {   // second split hand gets its second card when its turn comes
      x.cards.push(draw(h));
      if (total(x.cards).total === 21) x.done = true;
    }
    if (!x.done) return;
    h.cur++;
  }
  finish(h);
}
function finish(h) {
  h.phase = 'done';
  h.cur = Math.min(h.cur, h.hands.length - 1);
  const natural = h.hands.length === 1 && isBJ(h.hands[0].cards);
  const dBJ = isBJ(h.dealer);
  const live = h.hands.some(x => total(x.cards).total <= 21);
  // the dealer draws only when a player hand is still standing and the hand wasn't decided by a blackjack
  if (live && !natural && !dBJ) {
    while (total(h.dealer).total < 17) h.dealer.push(draw(h));   // stands on soft 17
  }
  const d = total(h.dealer).total;
  let net = 0;
  h.hands.forEach(x => {
    const p = total(x.cards).total;
    let r, n;
    if (p > 21) { r = 'bust'; n = -x.bet; }
    else if (natural && !dBJ) { r = 'blackjack'; n = round2(x.bet * 1.5); }
    else if (natural && dBJ) { r = 'push'; n = 0; }
    else if (dBJ) { r = 'lose'; n = -x.bet; }
    else if (d > 21) { r = 'win'; n = x.bet; }
    else if (p > d) { r = 'win'; n = x.bet; }
    else if (p < d) { r = 'lose'; n = -x.bet; }
    else { r = 'push'; n = 0; }
    x.result = r; x.net = round2(n); x.total = p; net += n;
  });
  h.dealerTotal = d; h.dealerBJ = dBJ; h.natural = natural;
  h.net = round2(net);
  return h;
}

// ---------- views (what the phone may see) ----------
function handTotals(x) { const t = total(x.cards); return { cards: x.cards.slice(), bet: x.bet, doubled: !!x.doubled, done: !!x.done, split: !!x.split, total: t.total, soft: t.soft }; }
function publicActive(h) {
  // NEVER the shoe, the salt, the draw position or the dealer's second card
  return {
    id: h.id, phase: 'player', commit: h.commit, bet: h.bet, wagered: wagered(h), seq: h.seq, cur: h.cur,
    startedAt: h.startedAt, rules: RULES,
    dealer: [h.dealer[0], null], dealerTotal: total([h.dealer[0]]).total,
    hands: h.hands.map(handTotals), can: canDo(h)
  };
}
function publicFinished(t) {
  const c = t.casino || {};
  return Object.assign({ id: c.handId, ticket: t.id, phase: 'done', status: t.status, settledAt: t.settledAt, voided: c.voided || null }, c);
}
function ticketOf(h, at, me) {
  const net = h.net;
  const status = net > 0 ? 'won' : net < 0 ? 'lost' : 'push';
  return {
    id: 'bj' + h.id.replace(/^h/, ''), kind: 'casino', game: 'blackjack', time: h.startedAt, settledAt: at,
    // the money: stake = |net| at even money, so every version of the site adds up the same amount
    stake: Math.abs(net), status, locked: true, paid: true, rev: 1, updatedBy: 'casino',
    selections: [{ gid: 'casino-' + h.id, mkt: 'casino', sport: 'casino', side: '', label: 'Casino · Blackjack', matchup: 'Blackjack',
      odds: 100, lockedOdds: 100, result: status === 'push' ? 'push' : status }],
    casino: {
      handId: h.id, game: 'blackjack', rules: RULES, bet: h.bet, wagered: wagered(h), net,
      dealer: h.dealer.slice(), dealerTotal: h.dealerTotal, dealerBJ: !!h.dealerBJ, natural: !!h.natural,
      hands: h.hands.map(x => ({ cards: x.cards.slice(), bet: x.bet, doubled: !!x.doubled, split: !!x.split, total: x.total, result: x.result, net: x.net })),
      log: h.log, draws: h.draws, shoe: h.shoe, salt: h.salt, commit: h.commit,
      balanceBefore: h.balanceBefore, balanceAfter: null, player: me
    }
  };
}

// ---------- state helpers ----------
function casinoOf(st) {
  st.casino = st.casino && typeof st.casino === 'object' ? st.casino : {};
  st.casino.active = st.casino.active || {};
  st.casino.idem = st.casino.idem || {};
  st.casino.log = Array.isArray(st.casino.log) ? st.casino.log : [];
  return st.casino;
}
function settingsOf(st) {
  const s = Object.assign({}, DEFAULTS, st.casinoSettings || {});
  s.min = Math.max(1, Math.round(Number(s.min) || DEFAULTS.min));
  s.max = Math.max(s.min, Math.round(Number(s.max) || DEFAULTS.max));
  s.enabled = s.enabled !== false;
  return s;
}
function negLimit(st) { const n = Number(st.settings && st.settings.negLimit); return Number.isFinite(n) ? n : NEG_LIMIT; }
function canPlay(me) { return B.isAdmin(me); }   // (1125) admins only while testing
function audit(st, e) { const C = casinoOf(st); C.log = C.log.concat([e]).slice(-2000); }
function findCasinoTicket(st, userId, id) {
  const keys = Object.keys(st.bets).filter(k => B.sameKey(k, userId));
  for (const k of keys) {
    const t = (st.bets[k] || []).find(b => b && b.kind === 'casino' && (b.id === id || (b.casino && b.casino.handId === id)));
    if (t) return { key: k, t };
  }
  return null;
}
function settle(st, me, h, at) {
  const C = casinoOf(st);
  const t = ticketOf(h, at, me.id);
  delete C.active[me.id];
  if (!st.bets[me.id]) st.bets[me.id] = [];
  st.bets[me.id].unshift(t);
  const after = B.balanceOf(st, me.id);
  t.casino.balanceAfter = after;
  t.casino.balanceAtSettleBefore = round2(after - t.casino.net);
  st.balanceLog = (st.balanceLog || []).concat([{ at, user: me.id, bet: t.id, type: 'casino', status: t.status, amount: t.casino.net, wagered: t.casino.wagered, balanceBefore: t.casino.balanceAtSettleBefore, balanceAfter: after, by: 'casino (blackjack)' }]).slice(-200);
  audit(st, { at, type: 'hand', user: me.id, hand: h.id, ticket: t.id, wagered: t.casino.wagered, net: t.casino.net, balanceBefore: t.casino.balanceAtSettleBefore, balanceAfter: after, commit: h.commit });
  return t;
}
function viewOut(st, me, extra) {
  const C = casinoOf(st);
  const h = C.active[me.id];
  return Object.assign({ ok: true, settings: settingsOf(st), balance: B.balanceOf(st, me.id), active: h ? publicActive(h) : null }, extra || {});
}

// ---------- actions ----------
function deal(st, me, body, now) {
  const s = settingsOf(st);
  const C = casinoOf(st);
  const idem = str(body.idem, 80);
  if (!idem) bad('Missing hand key. Refresh and try again.');
  const seen = (C.idem[me.id] || []).find(x => x.k === idem);
  if (seen) {   // same tap again: the same hand, nothing new
    const act0 = C.active[me.id];
    if (act0 && act0.id === seen.id) return Object.assign(viewOut(st, me, { duplicate: true }), { noWrite: true });
    const f = findCasinoTicket(st, me.id, seen.id);
    return Object.assign(viewOut(st, me, { duplicate: true, hand: f ? publicFinished(f.t) : null }), { noWrite: true });
  }
  if (C.active[me.id]) return Object.assign(viewOut(st, me, { resumed: true }), { noWrite: true });   // one hand at a time
  if (!s.enabled) bad('The casino is turned off right now.');
  const bet = Number(body.bet);
  if (!Number.isFinite(bet) || bet <= 0) bad('Pick a bet first.');
  if (Math.round(bet) !== bet) bad('Bets are whole dollars.');
  if (bet < s.min) bad('Minimum bet is $' + s.min);
  if (bet > s.max) bad('Maximum bet is $' + s.max);
  const bal = B.balanceOf(st, me.id);
  if (bal - bet < negLimit(st)) bad('This bet would put your balance below the allowed limit ($' + negLimit(st).toFixed(2) + ').');
  let id = 'h' + now;
  while (C.active[id] || findCasinoTicket(st, me.id, id)) id = 'h' + (Number(id.slice(1)) + 1);
  const at = new Date(now).toISOString();
  const h = startHand({ id, user: me.id, at, idem, bet, balanceBefore: bal });
  C.idem[me.id] = [{ k: idem, id, at: now }].concat((C.idem[me.id] || []).filter(x => now - x.at < 7 * 864e5)).slice(0, 200);
  if (h.phase === 'done') {
    const t = settle(st, me, h, at);
    return viewOut(st, me, { hand: publicFinished(t) });
  }
  C.active[me.id] = h;
  return viewOut(st, me);
}
function play(st, me, body, now) {
  const C = casinoOf(st);
  const a = String(body.action);
  const h = C.active[me.id];
  const handId = str(body.handId, 40);
  if (!h || h.id !== handId) {
    // an old or repeated tap for a hand that is already over: show how it ended, change nothing
    const f = handId ? findCasinoTicket(st, me.id, handId) : null;
    return Object.assign(viewOut(st, me, { stale: true, hand: f ? publicFinished(f.t) : null }), { noWrite: true });
  }
  if (Number(body.seq) !== h.seq) return Object.assign(viewOut(st, me, { stale: true }), { noWrite: true });   // double tap / other device
  const at = new Date(now).toISOString();
  act(h, a, at, extra => {
    if (B.balanceOf(st, me.id) - extra < negLimit(st)) bad('Not enough balance to ' + a + ' (limit $' + negLimit(st).toFixed(2) + ').');
  });
  if (h.phase === 'done') {
    const t = settle(st, me, h, at);
    return viewOut(st, me, { hand: publicFinished(t) });
  }
  return viewOut(st, me);
}
function saveSettings(st, me, body) {
  const s = settingsOf(st);
  const b = body.settings || {};
  if (b.enabled != null) s.enabled = !!b.enabled;
  if (b.min != null) { const v = Math.round(Number(b.min)); if (!Number.isFinite(v) || v < 1) bad('Minimum must be at least $1'); s.min = v; }
  if (b.max != null) { const v = Math.round(Number(b.max)); if (!Number.isFinite(v) || v < 1 || v > 100000) bad('Maximum must be a number'); s.max = v; }
  if (s.max < s.min) bad('Maximum must be at least the minimum');
  const prev = settingsOf(st);
  st.casinoSettings = s;
  const at = new Date().toISOString();
  audit(st, { at, type: 'settings', by: me.id, from: prev, to: s });
  st.adminLog = (st.adminLog || []).concat([{ at, by: me.id, action: 'casino-settings', from: prev, to: s }]).slice(-500);
  return { ok: true, settings: s };
}
// Void a finished hand: its net comes back off the balance (a win is taken back, a loss is refunded). Audited.
function voidHand(st, me, body) {
  const f = findCasinoTicket(st, body.userId, str(body.id, 60));
  if (!f) bad('Hand not found');
  const t = f.t;
  if (t.status === 'cancelled') return { ok: true, unchanged: true, noWrite: true };
  const reason = str(body.reason, 200);
  const before = B.balanceOf(st, f.key);
  const net = B.ticketNet(t);
  const target = round2(before - net);
  const from = t.status;
  t.status = 'cancelled';
  t.selections.forEach(s => { s.result = 'cancelled'; });
  t.rev = Number(t.rev || 1) + 1; t.updatedBy = me.id;
  // a hand from before the player's last cash out / balance reset is already inside the stored start balance
  const after0 = B.balanceOf(st, f.key);
  const fix = round2(target - after0);
  if (Math.abs(fix) >= 0.005) st.balanceBase[f.key] = round2(Number(st.balanceBase[f.key] || 0) + fix);
  const after = B.balanceOf(st, f.key);
  const at = new Date().toISOString();
  t.casino.voided = { by: me.id, at, reason, from, net, balanceBefore: before, balanceAfter: after };
  st.balanceLog = (st.balanceLog || []).concat([{ at, user: f.key, bet: t.id, type: 'casino-void', status: 'cancelled', amount: round2(after - before), balanceBefore: before, balanceAfter: after, by: me.id + ' (void casino hand)' }]).slice(-200);
  st.adminLog = (st.adminLog || []).concat([{ at, by: me.id, action: 'casino-void', user: f.key, bet: t.id, from, to: 'cancelled', amount: round2(after - before), balanceBefore: before, balanceAfter: after, reason }]).slice(-500);
  audit(st, { at, type: 'void', by: me.id, user: f.key, hand: t.casino.handId, ticket: t.id, from, amount: round2(after - before), balanceBefore: before, balanceAfter: after, reason });
  return { ok: true, balanceBefore: before, balanceAfter: after, amount: round2(after - before) };
}
// Void a hand still in progress: the stake goes back (nothing was won or lost). The hand is saved, cards revealed.
function voidActive(st, me, body) {
  const C = casinoOf(st);
  const key = Object.keys(C.active).find(k => B.sameKey(k, body.userId));
  if (!key) return { ok: true, unchanged: true, noWrite: true };
  const h = C.active[key];
  const before = B.balanceOf(st, key);
  const at = new Date().toISOString();
  const t = ticketOf(Object.assign({}, h, { net: 0, dealerTotal: total(h.dealer).total, hands: h.hands.map(x => Object.assign({}, x, { total: total(x.cards).total, result: 'void', net: 0 })) }), at, key);
  t.status = 'cancelled'; t.stake = 0; t.selections[0].result = 'cancelled';
  delete C.active[key];
  if (!st.bets[key]) st.bets[key] = [];
  st.bets[key].unshift(t);
  const after = B.balanceOf(st, key);
  t.casino.balanceAfter = after;
  t.casino.voided = { by: me.id, at, reason: str(body.reason, 200), from: 'in progress', net: 0, balanceBefore: before, balanceAfter: after };
  st.adminLog = (st.adminLog || []).concat([{ at, by: me.id, action: 'casino-void-active', user: key, bet: t.id, amount: round2(after - before), balanceBefore: before, balanceAfter: after }]).slice(-500);
  audit(st, { at, type: 'void-active', by: me.id, user: key, hand: h.id, ticket: t.id, amount: round2(after - before), balanceBefore: before, balanceAfter: after });
  return { ok: true, balanceBefore: before, balanceAfter: after, amount: round2(after - before) };
}
// Re-check a finished hand: the hash of the revealed shoe + salt must equal the code shown before the deal,
// and the cards dealt must be exactly the top of that shoe, in order.
function verifyRecord(c) {
  if (!c || !c.shoe || !c.salt) return { ok: false, why: 'no revealed shoe' };
  const hashOk = commitOf(c.shoe, c.salt) === c.commit;
  const prefixOk = c.shoe.indexOf(c.draws) === 0;
  const shoeOk = c.shoe.length === DECKS * 52 && CODE.split('').every(ch => c.shoe.split(ch).length - 1 === DECKS);
  const dealt = c.draws.split('').map(cardOf);
  const shown = [];
  // order the cards were drawn in: player, dealer, player, dealer, then each action, then the dealer's draws
  const all = [].concat(c.hands.reduce((a, x) => a.concat(x.cards), []), c.dealer);
  const sameSet = all.slice().sort().join() === dealt.slice().sort().join();
  return { ok: hashOk && prefixOk && shoeOk && sameSet, hashOk, prefixOk, shoeOk, cardsMatch: sameSet, dealt, shown };
}
function adminView(st) {
  const C = casinoOf(st);
  const per = {}; const recent = [];
  Object.keys(st.bets).forEach(k => (st.bets[k] || []).forEach(t => {
    if (!t || t.kind !== 'casino') return;
    const p = per[k] = per[k] || { user: k, hands: 0, net: 0, wagered: 0, voided: 0 };
    if (t.status === 'cancelled') p.voided++;
    else { p.hands++; p.net = round2(p.net + B.ticketNet(t)); p.wagered = round2(p.wagered + Number(t.casino && t.casino.wagered || 0)); }
    recent.push({ user: k, id: t.id, handId: t.casino && t.casino.handId, at: t.settledAt, status: t.status, net: t.casino && t.casino.net, wagered: t.casino && t.casino.wagered,
      dealer: t.casino && t.casino.dealer, hands: t.casino && t.casino.hands, voided: t.casino && t.casino.voided || null, commit: t.casino && t.casino.commit });
  }));
  recent.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const active = Object.keys(C.active).map(k => ({ user: k, id: C.active[k].id, startedAt: C.active[k].startedAt, wagered: wagered(C.active[k]) }));
  return { players: Object.keys(per).map(k => per[k]).sort((a, b) => b.hands - a.hands), recent: recent.slice(0, 60), active, log: C.log.slice(-60).reverse() };
}

const ADMIN = { settings: saveSettings, void: voidHand, voidActive };
const PLAY = ['hit', 'stand', 'double', 'split'];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: {}, body: '' };
  try {
    const store = await B.getStore(event);
    if (event.httpMethod === 'GET') {
      const q = event.queryStringParameters || {};
      let out;
      await B.mutate(store, st => {
        const me = B.requireUser(st, event);
        if (!canPlay(me)) forbid();
        out = viewOut(st, me, { isAdmin: B.isAdmin(me), rules: RULES });
        if (q.admin === '1' && B.isAdmin(me)) out.admin = adminView(st);
        if (q.verify && B.isAdmin(me)) { const f = findCasinoTicket(st, q.user || me.id, str(q.verify, 60)); out.verify = f ? Object.assign({ hand: publicFinished(f.t) }, verifyRecord(f.t.casino)) : { ok: false, why: 'Hand not found' }; }
        return { noWrite: true };
      });
      return B.reply(200, out);
    }
    if (event.httpMethod !== 'POST') return B.reply(405, { error: 'method' });
    const body = B.parseBody(event);
    const action = String(body.action || '');
    const result = await B.mutate(store, st => {
      const me = B.requireUser(st, event);
      if (!canPlay(me)) forbid();
      const now = Date.now();
      if (action === 'deal') return deal(st, me, body, now);
      if (PLAY.indexOf(action) >= 0) return play(st, me, body, now);
      const fn = ADMIN[action];
      if (!fn) bad('Unknown action');
      if (!B.isAdmin(me)) forbid('Admin only.');
      return fn(st, me, body);
    });
    delete result.noWrite;
    return B.reply(200, result);
  } catch (e) { return B.fail(e); }
};
exports._test = { newShoe, commitOf, cardOf, total, isBJ, startHand, act, finish, canDo, publicActive, publicFinished, ticketOf, verifyRecord, settingsOf, wagered, CODE, RULES };
