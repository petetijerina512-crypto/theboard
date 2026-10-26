'use strict';
// (1125) The Board casino: Blackjack. (1126) + Video Poker (Jacks or Better), Slots, Roulette. Admins only while being tested.
// (1129) + players the admin turns on one by one (casinoSettings.allowUsers). Everyone else is refused here, on the server.
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

const DEFAULTS = { enabled: true, min: 1, max: 100, games: { blackjack: true, poker: true, slots: true, roulette: true } };
const DECKS = 6;
const NEG_LIMIT = -500;
const CODE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';   // one letter per card (0..51)
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];
const SUITS = ['S', 'H', 'D', 'C'];
const RULES = '6 decks, new shoe every hand, dealer stands on soft 17, blackjack pays 3:2, double any 2 cards, 1 split';

const bad = msg => { throw new B.HttpError(400, msg); };
const forbid = msg => { throw new B.HttpError(403, msg || 'The casino is not open for your account.'); };
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

// =====================================================================================================
// (1126) more games. Same fair-deal design for every game:
//   - the server makes the outcome with crypto.randomInt ONLY (a shuffled deck, reel stops or a wheel pocket)
//   - it locks it in BEFORE you bet: commit = SHA-256(data + ":" + salt) is shown on the phone with "next game"
//   - the bet then uses exactly that locked outcome; afterwards data + salt are revealed and saved with the hand
//   - the phone ("Verify") and the admin card re-check the hash and re-work the result and the payout
// =====================================================================================================
const GAMES = ['blackjack', 'poker', 'slots', 'roulette'];
const GAME_NAME = { blackjack: 'Blackjack', poker: 'Video Poker', slots: 'Slots', roulette: 'Roulette' };
const GAME_PREFIX = { blackjack: 'bj', poker: 'vp', slots: 'sl', roulette: 'rl' };

// ---------- Video Poker: Jacks or Better, 9/6 full pay, one 52-card deck ----------
// Payouts are "for 1": the amount paid back per $1 bet, stake included (Jacks or Better = your bet back).
const VP_PAY = [
  ['royal', 'Royal Flush', 250], ['sflush', 'Straight Flush', 50], ['quads', 'Four of a Kind', 25], ['full', 'Full House', 9],
  ['flush', 'Flush', 6], ['straight', 'Straight', 4], ['trips', 'Three of a Kind', 3], ['twopair', 'Two Pair', 2], ['jacks', 'Jacks or Better', 1]
];
const VP_RULES = 'Jacks or Better 9/6, one 52-card deck shuffled for every hand, deal 5, hold any, draw once. Pays for 1: ' +
  VP_PAY.map(p => p[1] + ' ' + p[2]).join(', ');
function newDeck(randInt) {
  randInt = randInt || crypto.randomInt;
  const a = CODE.split('');
  for (let i = a.length - 1; i > 0; i--) { const j = randInt(i + 1); const t = a[i]; a[i] = a[j]; a[j] = t; }
  return a.join('');
}
const RV = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
const rankVal = c => RV[c[0]] || Number(c[0]);
function vpRank(cards) {
  if (!Array.isArray(cards) || cards.length !== 5) throw new Error('need 5 cards');
  const v = cards.map(rankVal).sort((a, b) => a - b);
  const flush = cards.every(c => c[1] === cards[0][1]);
  const uniq = Array.from(new Set(v));
  let straight = false, wheel = false;
  if (uniq.length === 5) {
    if (v[4] - v[0] === 4) straight = true;
    else if (v.join() === '2,3,4,5,14') { straight = true; wheel = true; }   // A-2-3-4-5
  }
  const cnt = {}; v.forEach(x => { cnt[x] = (cnt[x] || 0) + 1; });
  const groups = Object.keys(cnt).map(k => [Number(k), cnt[k]]).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  let key = null;
  if (straight && flush) key = (!wheel && v[0] === 10) ? 'royal' : 'sflush';
  else if (groups[0][1] === 4) key = 'quads';
  else if (groups[0][1] === 3 && groups[1][1] === 2) key = 'full';
  else if (flush) key = 'flush';
  else if (straight) key = 'straight';
  else if (groups[0][1] === 3) key = 'trips';
  else if (groups[0][1] === 2 && groups[1][1] === 2) key = 'twopair';
  else if (groups[0][1] === 2 && groups[0][0] >= 11) key = 'jacks';
  const row = VP_PAY.find(p => p[0] === key);
  return { key: key || 'none', name: row ? row[1] : 'No win', mult: row ? row[2] : 0 };
}
function vpStart(o) {
  const deck = o.data || newDeck();
  const salt = o.salt || crypto.randomBytes(16).toString('hex');
  const cards = deck.slice(0, 5).split('').map(cardOf);
  return {
    id: o.id, user: o.user, game: 'poker', startedAt: o.at, idem: o.idem || '', bet: o.bet,
    deck, salt, commit: commitOf(deck, salt), pos: 5, draws: deck.slice(0, 5),
    cards, held: [false, false, false, false, false], hands: [{ cards: cards.slice(), bet: o.bet }],   // hands[0].bet: counted in the balance while it is open
    seq: 0, phase: 'hold', log: [{ a: 'deal', at: o.at }], balanceBefore: o.balanceBefore
  };
}
// hold = five true/false. Replacements always come from the next cards of the locked deck, left to right:
// which cards you hold decides WHERE they go, never WHICH cards come out.
function vpDraw(h, hold, at) {
  if (h.phase !== 'hold') bad('This hand is over.');
  if (!Array.isArray(hold) || hold.length !== 5) bad('Pick the cards to hold.');
  const held = hold.map(x => x === true || x === 1 || x === '1');
  h.held = held;
  h.first = h.cards.slice();
  h.cards = h.cards.map((c, i) => held[i] ? c : (() => { const ch = h.deck[h.pos++]; h.draws += ch; return cardOf(ch); })());
  h.hands = [{ cards: h.cards.slice(), bet: h.bet }];
  h.seq++;
  h.log.push({ a: 'draw', hold: held.map(x => x ? 1 : 0).join(''), at });
  vpFinish(h);
  return h;
}
function vpFinish(h) {
  const r = vpRank(h.cards);
  h.phase = 'done'; h.rank = r.key; h.rankName = r.name; h.mult = r.mult;
  h.net = round2(h.bet * r.mult - h.bet);
  return h;
}
function vpPublic(h) {
  return { id: h.id, game: 'poker', phase: 'hold', commit: h.commit, bet: h.bet, wagered: h.bet, seq: h.seq, startedAt: h.startedAt,
    cards: h.cards.slice(), held: h.held.slice(), rank: vpRank(h.cards), can: { draw: true }, rules: VP_RULES };
}

// ---------- Slots: 3 reels, one pay line (the middle row), fixed published reel strip ----------
// Each reel stops at crypto.randomInt(32) on the same 32-stop strip. 32 x 32 x 32 = 32,768 equally likely spins,
// so the return to player is exact: SLOT_RTP below is worked out from every one of them (tests re-check it).
const SLOT_STRIP = '7_CL_WB_L_DC_WL_B_C_LW_D_BL_W_C_';
const SLOT_SYM = { 7: '7️⃣', D: '💎', B: '🔔', W: '🍉', L: '🍋', C: '🍒', _: '▫️' };
const SLOT_NAME = { 7: 'Seven', D: 'Diamond', B: 'Bell', W: 'Melon', L: 'Lemon', C: 'Cherry', _: 'blank' };
const SLOT_PAY3 = { 7: 300, D: 100, B: 40, W: 20, L: 12, C: 10 };   // three of a kind on the line, for 1
const SLOT_CHERRY = { 2: 5, 1: 2 };                                 // cherries anywhere on the line (not three), for 1
function slotPay(sy) {
  if (sy[0] === sy[1] && sy[1] === sy[2] && sy[0] !== '_') return { mult: SLOT_PAY3[sy[0]], why: '3 × ' + SLOT_NAME[sy[0]] };
  const ch = sy.filter(x => x === 'C').length;
  if (SLOT_CHERRY[ch]) return { mult: SLOT_CHERRY[ch], why: ch + ' × Cherry' };
  return { mult: 0, why: 'No win' };
}
function slotRtp() {
  let tot = 0, hits = 0; const n = SLOT_STRIP.length;
  for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) for (let c = 0; c < n; c++) {
    const m = slotPay([SLOT_STRIP[a], SLOT_STRIP[b], SLOT_STRIP[c]]).mult; tot += m; if (m) hits++;
  }
  return { rtp: tot / (n * n * n), hit: hits / (n * n * n), spins: n * n * n, totalReturn: tot };
}
const SLOT_RTP = slotRtp();
const SLOT_RULES = '3 reels x 32 stops, middle line pays. 3 Sevens 300, 3 Diamonds 100, 3 Bells 40, 3 Melons 20, 3 Lemons 12, 3 Cherries 10, 2 Cherries 5, 1 Cherry 2 (for 1). Return to player ' + (SLOT_RTP.rtp * 100).toFixed(2) + '% (exact)';
const slotData = stops => stops.map(x => String(x).padStart(2, '0')).join('-');
function slotNew(randInt) { randInt = randInt || crypto.randomInt; return slotData([randInt(32), randInt(32), randInt(32)]); }
function slotOutcome(data) {
  const stops = String(data).split('-').map(Number);
  if (stops.length !== 3 || stops.some(x => !(x >= 0 && x < 32) || Math.round(x) !== x)) throw new Error('bad stops');
  const sy = stops.map(i => SLOT_STRIP[i]);
  const p = slotPay(sy);
  const n = SLOT_STRIP.length;
  const rows = [-1, 0, 1].map(d => stops.map(i => SLOT_STRIP[(i + d + n) % n]));   // above / pay line / below
  return { stops, line: sy, rows, mult: p.mult, why: p.why };
}

// ---------- Roulette: American wheel, 0 and 00 ----------
const RL_WHEEL = ['0', '28', '9', '26', '30', '11', '7', '20', '32', '17', '5', '22', '34', '15', '3', '24', '36', '13', '1', '00', '27', '10', '25', '29', '12', '8', '19', '31', '18', '6', '21', '33', '16', '4', '23', '35', '14', '2'];
const RL_RED = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
const RL_PAY = { straight: 35, dozen: 2, column: 2, red: 1, black: 1, odd: 1, even: 1, low: 1, high: 1 };
const RL_RULES = 'American wheel (0 and 00, 38 pockets). Straight up 35:1, dozens and columns 2:1, red/black, odd/even, 1-18/19-36 1:1. 0 and 00 lose every outside bet. House edge 5.26% on every bet.';
const rlColor = p => (p === '0' || p === '00') ? 'green' : RL_RED.indexOf(Number(p)) >= 0 ? 'red' : 'black';
function rlNew(randInt) { randInt = randInt || crypto.randomInt; const i = randInt(38); return i === 37 ? '00' : String(i); }
function rlWins(type, pick, p) {
  const zero = p === '0' || p === '00';
  const n = zero ? 0 : Number(p);
  switch (type) {
    case 'straight': return String(pick) === p;
    case 'red': return !zero && rlColor(p) === 'red';
    case 'black': return !zero && rlColor(p) === 'black';
    case 'odd': return !zero && n % 2 === 1;
    case 'even': return !zero && n % 2 === 0;
    case 'low': return !zero && n >= 1 && n <= 18;
    case 'high': return !zero && n >= 19 && n <= 36;
    case 'dozen': return !zero && Math.ceil(n / 12) === Number(pick);
    case 'column': return !zero && ((n - 1) % 3) + 1 === Number(pick);
  }
  return false;
}
function rlCleanBets(bets) {
  if (!Array.isArray(bets) || !bets.length) bad('Put a chip on the table first.');
  if (bets.length > 60) bad('Too many bets on one spin.');
  const merged = {};
  bets.forEach(b => {
    const type = String(b && b.type || '');
    if (!Object.prototype.hasOwnProperty.call(RL_PAY, type)) bad('Unknown bet');   // (1129) no '__proto__' / 'constructor'
    let pick = '';
    if (type === 'straight') { pick = String(b.pick); if (RL_WHEEL.indexOf(pick) < 0) bad('Pick a number 0, 00 or 1-36'); }
    else if (type === 'dozen' || type === 'column') { pick = String(Number(b.pick)); if (['1', '2', '3'].indexOf(pick) < 0) bad('Pick 1st, 2nd or 3rd'); }
    const amt = Number(b.amount);
    if (!Number.isFinite(amt) || amt <= 0 || Math.round(amt) !== amt) bad('Chips are whole dollars.');
    const k = type + ':' + pick;
    merged[k] = Object.prototype.hasOwnProperty.call(merged, k) ? merged[k] : { type, pick, amount: 0 };
    merged[k].amount += amt;
  });
  return Object.keys(merged).map(k => merged[k]);
}
function rlSettle(bets, pocket) {
  let net = 0;
  const out = bets.map(b => {
    const win = rlWins(b.type, b.pick, pocket);
    const n = win ? b.amount * RL_PAY[b.type] : -b.amount;
    net += n;
    return { type: b.type, pick: b.pick, amount: b.amount, win, net: n };
  });
  return { bets: out, net: round2(net) };
}
function rlEdge() {   // exact: average result of $1 on every bet over all 38 pockets
  const per = {};
  const sample = { straight: ['0', '00', '17'], dozen: ['1', '2', '3'], column: ['1', '2', '3'], red: [''], black: [''], odd: [''], even: [''], low: [''], high: [''] };
  Object.keys(sample).forEach(t => sample[t].forEach(pk => {
    const ev = RL_WHEEL.reduce((n, p) => n + (rlWins(t, pk, p) ? RL_PAY[t] : -1), 0) / 38;
    per[t + (pk ? ':' + pk : '')] = ev;
  }));
  return per;
}

// ---------- the "next game" lock: outcome + salt made and committed before the bet ----------
function nextData(game, rnd) {
  if (game === 'blackjack') return newShoe(rnd);
  if (game === 'poker') return newDeck(rnd);
  if (game === 'slots') return slotNew(rnd);
  if (game === 'roulette') return rlNew(rnd);
  throw new Error('game');
}
function nextOf(st, userId, game, now, rnd) {
  const C = casinoOf(st);
  C.next = C.next && typeof C.next === 'object' ? C.next : {};
  C.next[userId] = C.next[userId] || {};
  let n = C.next[userId][game];
  if (n && n.commit && isBurned(st, n.commit)) { delete C.next[userId][game]; n = null; }   // (1129) shown or used once: never again
  if (!n || !n.data) {
    const data = nextData(game, rnd), salt = crypto.randomBytes(16).toString('hex');
    n = C.next[userId][game] = { id: 'n' + now + game.slice(0, 2) + crypto.randomBytes(3).toString('hex'), data, salt, commit: commitOf(data, salt), at: new Date(now).toISOString() };
    return { n, made: true };
  }
  return { n, made: false };
}
// (1129) every code that was used for a game, or shown with a game that did not save, is burned for good
function isBurned(st, commit) { const C = casinoOf(st); return Array.isArray(C.burned) && C.burned.indexOf(commit) >= 0; }
function burn(st, commit) { const C = casinoOf(st); if (!commit || isBurned(st, commit)) return; C.burned = (Array.isArray(C.burned) ? C.burned : []).concat([commit]).slice(-1000); }
function takeNext(st, userId, game, now, wantId) {
  const C = casinoOf(st);
  let cur0 = C.next && C.next[userId] && C.next[userId][game];
  if (cur0 && cur0.commit && isBurned(st, cur0.commit)) { delete C.next[userId][game]; if (wantId) return null; }
  const cur = C.next && C.next[userId] && C.next[userId][game];
  if (wantId && (!cur || cur.id !== wantId)) return null;   // the phone showed a different lock: refresh, no money
  const n = cur && cur.data ? cur : nextOf(st, userId, game, now).n;
  delete C.next[userId][game];
  burn(st, n.commit);   // (1129) used now: never dealt again
  nextOf(st, userId, game, now + 1);   // lock in the one after it right away
  return n;
}
function publicNext(st, userId) {
  const C = casinoOf(st), m = (C.next && C.next[userId]) || {};
  const out = {};
  Object.keys(m).forEach(g => { if (m[g] && m[g].commit) out[g] = { id: m[g].id, commit: m[g].commit, at: m[g].at }; });   // NEVER data or salt
  return out;
}

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
  if (h && h.game === 'poker') return vpPublic(h);   // (1126)
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
function bjTicketOf(h, at, me) {
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
// (1126) one ticket shape for every game: stake = |net| at even money (+100), the details in t.casino
// (1128) every game record keeps the id of the locked fairness code it was played with and the time that
// code was made and sent to the phone (before the bet), so each game proves "code shown, then bet".
function ticketOf(h, at, me) {
  const t = ticketOf0(h, at, me);
  if (t && t.casino && h.codeId) Object.assign(t.casino, { codeId: h.codeId, codeShownAt: h.codeShownAt, codeBeforeBet: Date.parse(h.codeShownAt) <= Date.parse(h.startedAt) });
  return t;
}
function ticketOf0(h, at, me) {
  const game = h.game || 'blackjack';
  if (game === 'blackjack') return bjTicketOf(h, at, me);
  const net = round2(h.net);
  const status = net > 0 ? 'won' : net < 0 ? 'lost' : 'push';
  let c;
  if (game === 'poker') c = { rules: VP_RULES, bet: h.bet, wagered: h.bet, first: (h.first || h.cards).slice(), held: (h.held || []).slice(), cards: h.cards.slice(),
    rank: h.rank, rankName: h.rankName, mult: h.mult, log: h.log, draws: h.draws, deck: h.deck, salt: h.salt, commit: h.commit };
  else if (game === 'slots') c = { rules: SLOT_RULES, bet: h.bet, wagered: h.bet, stops: h.stops, line: h.line, rows: h.rows, mult: h.mult, why: h.why,
    data: h.data, salt: h.salt, commit: h.commit, log: h.log };
  else c = { rules: RL_RULES, bet: h.bet, wagered: h.bet, bets: h.bets, pocket: h.pocket, color: rlColor(h.pocket), data: h.data, salt: h.salt, commit: h.commit, log: h.log };
  return {
    id: GAME_PREFIX[game] + h.id.replace(/^h/, ''), kind: 'casino', game, time: h.startedAt, settledAt: at,
    stake: Math.abs(net), status, locked: true, paid: true, rev: 1, updatedBy: 'casino',
    selections: [{ gid: 'casino-' + h.id, mkt: 'casino', sport: 'casino', side: '', label: 'Casino · ' + GAME_NAME[game], matchup: GAME_NAME[game],
      odds: 100, lockedOdds: 100, result: status === 'push' ? 'push' : status }],
    casino: Object.assign({ handId: h.id, game, net }, c, { balanceBefore: h.balanceBefore, balanceAfter: null, player: me })
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
  const g = Object.assign({}, DEFAULTS.games, (st.casinoSettings && st.casinoSettings.games) || {});
  s.games = {}; GAMES.forEach(k => { s.games[k] = g[k] !== false; });
  s.allowUsers = allowListOf(st);   // (1129)
  return s;
}
// (1129) players (not admins) the admin let into the casino. Empty by default: nobody but admins.
function allowListOf(st) {
  const a = st.casinoSettings && Array.isArray(st.casinoSettings.allowUsers) ? st.casinoSettings.allowUsers : [];
  const out = [];
  a.forEach(x => { const v = str(x, 60).trim(); if (v && !out.some(y => B.sameKey(y, v))) out.push(v); });
  return out;
}
// what a player's phone gets: no one else's name
function publicSettings(st, me) {
  const s = settingsOf(st);
  if (!B.isAdmin(me)) delete s.allowUsers;
  return s;
}
function negLimit(st) { const n = Number(st.settings && st.settings.negLimit); return Number.isFinite(n) ? n : NEG_LIMIT; }
// (1125) admins only while testing. (1129) + players on the admin's casino list. The main switch and the
// per-game switches still apply to everyone (checked in deal).
function canPlay(st, me) { return B.isAdmin(me) || (!!me && allowListOf(st).some(u => B.sameKey(u, me.id))); }
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
  st.balanceLog = (st.balanceLog || []).concat([{ at, user: me.id, bet: t.id, type: 'casino', status: t.status, amount: t.casino.net, wagered: t.casino.wagered, balanceBefore: t.casino.balanceAtSettleBefore, balanceAfter: after, by: 'casino (' + (h.game || 'blackjack') + ')' }]).slice(-200);
  audit(st, { at, type: 'hand', game: h.game || 'blackjack', user: me.id, hand: h.id, ticket: t.id, wagered: t.casino.wagered, net: t.casino.net, balanceBefore: t.casino.balanceAtSettleBefore, balanceAfter: after, commit: h.commit, codeId: h.codeId || null, codeShownAt: h.codeShownAt || null });
  return t;
}
function viewOut(st, me, extra) {
  const C = casinoOf(st);
  const h = C.active[me.id];
  return Object.assign({ ok: true, settings: publicSettings(st, me), balance: B.balanceOf(st, me.id), active: h ? publicActive(h) : null, next: publicNext(st, me.id) }, extra || {});
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
  if (C.active[me.id]) return Object.assign(viewOut(st, me, { resumed: true }), { noWrite: true });   // one game at a time (all games)
  if (!s.enabled) bad('The casino is turned off right now.');
  const game = GAMES.indexOf(String(body.game || 'blackjack')) >= 0 ? String(body.game || 'blackjack') : bad('Unknown game');
  if (!s.games[game]) bad(GAME_NAME[game] + ' is turned off right now.');
  const rlBets = game === 'roulette' ? rlCleanBets(body.bets) : null;
  const bet = rlBets ? rlBets.reduce((n, b) => n + b.amount, 0) : Number(body.bet);
  if (!Number.isFinite(bet) || bet <= 0) bad('Pick a bet first.');
  if (Math.round(bet) !== bet) bad('Bets are whole dollars.');
  if (bet < s.min) bad('Minimum bet is $' + s.min);
  if (bet > s.max) bad('Maximum bet is $' + s.max);
  const bal = B.balanceOf(st, me.id);
  if (bal - bet < negLimit(st)) bad('This bet would put your balance below the allowed limit ($' + negLimit(st).toFixed(2) + ').');
  let id = 'h' + now;
  while (C.active[id] || findCasinoTicket(st, me.id, id)) id = 'h' + (Number(id.slice(1)) + 1);
  const at = new Date(now).toISOString();
  // (1126) the outcome was locked in before this bet (its code is on the phone); a different code = refresh, no money
  const n = takeNext(st, me.id, game, now, str(body.nextId, 60));
  if (!n) return Object.assign(viewOut(st, me, { stale: true, error: 'The game code changed. Check the new code and tap again.' }), { noWrite: true });
  let h;
  if (game === 'blackjack') h = startHand({ id, user: me.id, at, idem, bet, balanceBefore: bal, shoe: n.data, salt: n.salt });
  else if (game === 'poker') h = vpStart({ id, user: me.id, at, idem, bet, balanceBefore: bal, data: n.data, salt: n.salt });
  else if (game === 'slots') {
    const o = slotOutcome(n.data);
    h = Object.assign({ id, user: me.id, game, startedAt: at, idem, bet, data: n.data, salt: n.salt, commit: n.commit, log: [{ a: 'spin', at }], balanceBefore: bal, phase: 'done' }, o);
    h.net = round2(bet * o.mult - bet);
  } else {
    const r = rlSettle(rlBets, n.data);
    h = { id, user: me.id, game, startedAt: at, idem, bet, bets: r.bets, net: r.net, pocket: n.data, data: n.data, salt: n.salt, commit: n.commit, log: [{ a: 'spin', at }], balanceBefore: bal, phase: 'done' };
  }
  h.codeId = n.id; h.codeShownAt = n.at;   // (1128)
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
  if (h.game === 'poker') { if (a !== 'draw') bad('Not allowed now.'); vpDraw(h, body.hold, at); }
  else if (a === 'draw') bad('Not allowed now.');
  else act(h, a, at, extra => {
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
  if (b.games && typeof b.games === 'object') GAMES.forEach(k => { if (b.games[k] != null) s.games[k] = !!b.games[k]; });
  s.allowUsers = allowListOf(st);   // (1129) the player list changes only through the 'access' action (one player at a time, logged)
  const prev = settingsOf(st);
  st.casinoSettings = s;
  const at = new Date().toISOString();
  audit(st, { at, type: 'settings', by: me.id, from: prev, to: s });
  st.adminLog = (st.adminLog || []).concat([{ at, by: me.id, action: 'casino-settings', from: prev, to: s }]).slice(-500);
  return { ok: true, settings: s };
}
// (1129) turn the casino on or off for one player. Admin only; every change goes in the admin log and the casino log.
function setAccess(st, me, body) {
  const u = B.findUser(st, str(body.userId, 60));
  if (!u) bad('Player not found');
  if (B.isAdmin(u)) bad('Admins always have the casino.');
  const on = body.on === true || body.on === 1 || body.on === '1' || body.on === 'true';
  const list = allowListOf(st);
  const was = list.some(x => B.sameKey(x, u.id));
  if (was === on) return { ok: true, unchanged: true, user: u.id, on, allowUsers: list, noWrite: true };
  if (!on) {
    const C = casinoOf(st);
    if (Object.keys(C.active).some(k => B.sameKey(k, u.id))) bad(u.id + ' has a casino game in progress. Let it finish (or void it below) first.');
  }
  const next = on ? list.concat([u.id]) : list.filter(x => !B.sameKey(x, u.id));
  st.casinoSettings = Object.assign({}, settingsOf(st), { allowUsers: next });
  const at = new Date().toISOString();
  audit(st, { at, type: 'access', by: me.id, user: u.id, on });
  st.adminLog = (st.adminLog || []).concat([{ at, by: me.id, action: 'casino-access', user: u.id, from: was ? 'on' : 'off', to: on ? 'on' : 'off' }]).slice(-500);
  return { ok: true, user: u.id, on, allowUsers: next };
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
  audit(st, { at, type: 'void', game: t.casino.game || 'blackjack', by: me.id, user: f.key, hand: t.casino.handId, ticket: t.id, from, amount: round2(after - before), balanceBefore: before, balanceAfter: after, reason });
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
  const t = h.game === 'poker' ? ticketOf(Object.assign({}, h, { net: 0, first: h.cards, rank: 'void', rankName: 'Voided', mult: 0 }), at, key)
    : ticketOf(Object.assign({}, h, { net: 0, dealerTotal: total(h.dealer).total, hands: h.hands.map(x => Object.assign({}, x, { total: total(x.cards).total, result: 'void', net: 0 })) }), at, key);
  t.status = 'cancelled'; t.stake = 0; t.selections[0].result = 'cancelled';
  delete C.active[key];
  if (!st.bets[key]) st.bets[key] = [];
  st.bets[key].unshift(t);
  const after = B.balanceOf(st, key);
  t.casino.balanceAfter = after;
  t.casino.voided = { by: me.id, at, reason: str(body.reason, 200), from: 'in progress', net: 0, balanceBefore: before, balanceAfter: after };
  st.adminLog = (st.adminLog || []).concat([{ at, by: me.id, action: 'casino-void-active', user: key, bet: t.id, amount: round2(after - before), balanceBefore: before, balanceAfter: after }]).slice(-500);
  audit(st, { at, type: 'void-active', game: h.game || 'blackjack', by: me.id, user: key, hand: h.id, ticket: t.id, amount: round2(after - before), balanceBefore: before, balanceAfter: after });
  return { ok: true, balanceBefore: before, balanceAfter: after, amount: round2(after - before) };
}
// Re-check a finished hand: the hash of the revealed shoe + salt must equal the code shown before the deal,
// and the cards dealt must be exactly the top of that shoe, in order.
function verifyRecord(c) {
  if (c && c.game && c.game !== 'blackjack') return verifyOther(c);   // (1126)
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
// (1126) Video Poker / Slots / Roulette: hash, the locked outcome, and the payout worked out again from it
function verifyOther(c) {
  const inProgressVoid = !!(c.voided && c.voided.from === 'in progress');
  if (c.game === 'poker') {
    if (!c.deck || !c.salt) return { ok: false, why: 'no revealed deck' };
    const hashOk = commitOf(c.deck, c.salt) === c.commit;
    const deckOk = c.deck.length === 52 && CODE.split('').every(ch => c.deck.split(ch).length - 1 === 1);
    const first = c.deck.slice(0, 5).split('').map(cardOf);
    const firstOk = first.join() === (c.first || []).join();
    let pos = 5;
    const fin = inProgressVoid ? first : first.map((x, i) => (c.held || [])[i] ? x : cardOf(c.deck[pos++]));
    const cardsOk = fin.join() === (c.cards || []).join();
    const r = vpRank(fin);
    const payOk = inProgressVoid || (r.key === c.rank && round2(c.bet * r.mult - c.bet) === round2(c.net));
    return { ok: hashOk && deckOk && firstOk && cardsOk && payOk, hashOk, deckOk, firstOk, cardsOk, payOk, rank: r, dealt: c.deck.slice(0, pos).split('').map(cardOf) };
  }
  if (!c.data || !c.salt) return { ok: false, why: 'no revealed result' };
  const hashOk = commitOf(c.data, c.salt) === c.commit;
  if (c.game === 'slots') {
    let o; try { o = slotOutcome(c.data); } catch (e) { return { ok: false, hashOk, why: 'bad stops' }; }
    const lineOk = o.line.join() === (c.line || []).join();
    const payOk = inProgressVoid || round2(c.bet * o.mult - c.bet) === round2(c.net);
    return { ok: hashOk && lineOk && payOk, hashOk, lineOk, payOk, outcome: o };
  }
  if (c.game === 'roulette') {
    const pocketOk = RL_WHEEL.indexOf(c.data) >= 0 && c.data === c.pocket;
    const r = rlSettle((c.bets || []).map(b => ({ type: b.type, pick: b.pick, amount: b.amount })), c.data);
    const payOk = inProgressVoid || (r.net === round2(c.net) && r.bets.every((b, i) => b.win === c.bets[i].win && b.net === c.bets[i].net));
    return { ok: hashOk && pocketOk && payOk, hashOk, pocketOk, payOk, net: r.net };
  }
  return { ok: false, why: 'unknown game' };
}
function casinoDetail(c) {   // what the admin list shows (no deck / shoe / salt)
  const o = {};
  ['game', 'dealer', 'dealerTotal', 'hands', 'first', 'held', 'cards', 'rank', 'rankName', 'mult', 'stops', 'line', 'why', 'bets', 'pocket', 'color', 'bet'].forEach(k => { if (c && c[k] !== undefined) o[k] = c[k]; });
  return o;
}
function adminView(st) {
  const C = casinoOf(st);
  const per = {}; const recent = [];
  Object.keys(st.bets).forEach(k => (st.bets[k] || []).forEach(t => {
    if (!t || t.kind !== 'casino') return;
    const p = per[k] = per[k] || { user: k, hands: 0, net: 0, wagered: 0, voided: 0, games: {} };
    const gm = (t.casino && t.casino.game) || 'blackjack';
    const pg = p.games[gm] = p.games[gm] || { hands: 0, net: 0 };
    if (t.status === 'cancelled') p.voided++;
    else { p.hands++; p.net = round2(p.net + B.ticketNet(t)); p.wagered = round2(p.wagered + Number(t.casino && t.casino.wagered || 0)); pg.hands++; pg.net = round2(pg.net + B.ticketNet(t)); }
    recent.push({ user: k, id: t.id, handId: t.casino && t.casino.handId, at: t.settledAt, status: t.status, net: t.casino && t.casino.net, wagered: t.casino && t.casino.wagered,
      dealer: t.casino && t.casino.dealer, hands: t.casino && t.casino.hands, voided: t.casino && t.casino.voided || null, commit: t.casino && t.casino.commit,
      game: (t.casino && t.casino.game) || 'blackjack', detail: casinoDetail(t.casino) });
  }));
  recent.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const active = Object.keys(C.active).map(k => ({ user: k, id: C.active[k].id, game: C.active[k].game || 'blackjack', startedAt: C.active[k].startedAt, wagered: wagered(C.active[k]) }));
  const allow = allowListOf(st);   // (1129) every player with his casino switch
  const access = (st.users || []).filter(u => u && !B.isAdmin(u)).map(u => ({ user: u.id, on: allow.some(x => B.sameKey(x, u.id)) }));
  return { players: Object.keys(per).map(k => per[k]).sort((a, b) => b.hands - a.hands), recent: recent.slice(0, 60), active, log: C.log.slice(-60).reverse(), access, allowUsers: allow };
}

const ADMIN = { settings: saveSettings, void: voidHand, voidActive, access: setAccess };
const PLAY = ['hit', 'stand', 'double', 'split', 'draw'];
// (1126) lock in the next outcome of every game (only the codes go to the phone)
function prepare(st, me, now) {
  let made = false;
  GAMES.forEach(g => { if (nextOf(st, me.id, g, now).made) made = true; });
  return Object.assign(viewOut(st, me), made ? {} : { noWrite: true });
}
const GAME_INFO = {
  blackjack: { name: 'Blackjack', rules: RULES },
  poker: { name: 'Video Poker', rules: VP_RULES, pay: VP_PAY },
  slots: { name: 'Slots', rules: SLOT_RULES, strip: SLOT_STRIP, symbols: SLOT_SYM, pay3: SLOT_PAY3, cherry: SLOT_CHERRY, rtp: SLOT_RTP.rtp },
  roulette: { name: 'Roulette', rules: RL_RULES, wheel: RL_WHEEL, red: RL_RED, pay: RL_PAY }
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: {}, body: '' };
  try {
    const store = await B.getStore(event);
    if (event.httpMethod === 'GET') {
      const q = event.queryStringParameters || {};
      let out;
      await B.mutate(store, st => {
        const me = B.requireUser(st, event);
        if (!canPlay(st, me)) forbid();
        out = viewOut(st, me, { isAdmin: B.isAdmin(me), rules: RULES, games: GAME_INFO });
        if (q.admin === '1' && B.isAdmin(me)) out.admin = adminView(st);
        if (q.verify && B.isAdmin(me)) { const f = findCasinoTicket(st, q.user || me.id, str(q.verify, 60)); out.verify = f ? Object.assign({ hand: publicFinished(f.t) }, verifyRecord(f.t.casino)) : { ok: false, why: 'Hand not found' }; }
        return { noWrite: true };
      });
      return B.reply(200, out);
    }
    if (event.httpMethod !== 'POST') return B.reply(405, { error: 'method' });
    const body = B.parseBody(event);
    const action = String(body.action || '');
    let meId = null;
    const result = await B.mutate(store, st => {
      const me = B.requireUser(st, event);
      if (!canPlay(st, me)) forbid();
      meId = me.id;
      const now = Date.now();
      if (action === 'deal') return deal(st, me, body, now);
      if (action === 'prepare') return prepare(st, me, now);
      if (PLAY.indexOf(action) >= 0) return play(st, me, body, now);
      const fn = ADMIN[action];
      if (!fn) bad('Unknown action');
      if (!B.isAdmin(me)) forbid('Admin only.');
      return fn(st, me, body);
    });
    // (1129) the cards / result go to the phone only after the saved game is read back from the store
    if (!result.noWrite && (action === 'deal' || PLAY.indexOf(action) >= 0)) {
      const okSaved = await confirmSaved(store, meId, action, body, result);
      if (!okSaved) {
        await burnUnsaved(store, meId, action, body, result);
        return B.reply(503, { error: 'That game did not save, so it was cancelled and no money moved. Its code is burned; tap again for a new game.', unsaved: true });
      }
    }
    delete result.noWrite;
    return B.reply(200, result);
  } catch (e) { return B.fail(e); }
};
function savedHandId(result) { return (result.active && result.active.id) || (result.hand && result.hand.id) || null; }
async function confirmSaved(store, userId, action, body, result, readImpl) {
  try {
    const { data } = await (readImpl || B.readKey)(store, B.KEY);
    const C = (data && data.casino) || {};
    const id = savedHandId(result);
    if (!id) return true;
    if (result.hand) return !!findCasinoTicket({ bets: (data && data.bets) || {} }, userId, result.hand.id);
    const a = C.active && Object.keys(C.active).map(k => B.sameKey(k, userId) ? C.active[k] : null).find(Boolean);
    return !!(a && a.id === id && a.seq === result.active.seq);
  } catch (e) { return false; }
}
// a game the phone was about to see did not save: burn its code (so it can never be dealt again) and,
// for a hand still open from an earlier step, void it with the stake refunded (the phone may have seen the next cards)
async function burnUnsaved(store, userId, action, body, result) {
  const commit = (result.active && result.active.commit) || (result.hand && result.hand.commit) || null;
  const id = savedHandId(result);
  try {
    await B.mutate(store, st => {
      const C = casinoOf(st);
      if (commit) burn(st, commit);
      Object.keys(C.next || {}).forEach(u => { if (!B.sameKey(u, userId)) return; Object.keys(C.next[u] || {}).forEach(g => { const n = C.next[u][g]; if (n && n.commit === commit) delete C.next[u][g]; }); });
      const key = Object.keys(C.active).find(k => B.sameKey(k, userId));
      if (key && C.active[key] && C.active[key].commit === commit && C.active[key].id !== id) {
        voidActive(st, { id: 'casino-check' }, { userId: key, reason: 'step did not save (cards may have been seen)' });
      } else if (key && C.active[key] && C.active[key].commit === commit && action !== 'deal' && C.active[key].seq !== (result.active && result.active.seq)) {
        voidActive(st, { id: 'casino-check' }, { userId: key, reason: 'step did not save (cards may have been seen)' });
      }
      audit(st, { at: new Date().toISOString(), type: 'unsaved', user: userId, action, hand: id, commit });
      return {};
    });
  } catch (e) {}
}
exports._test = { confirmSaved, burnUnsaved, isBurned, canPlay, allowListOf, publicSettings, newDeck, vpRank, vpStart, vpDraw, vpPublic, VP_PAY, slotPay, slotOutcome, slotRtp, SLOT_STRIP, SLOT_PAY3, SLOT_CHERRY, SLOT_RTP,
  rlWins, rlSettle, rlCleanBets, rlEdge, rlColor, RL_WHEEL, RL_RED, RL_PAY, nextOf, takeNext, publicNext, GAMES, verifyOther, newShoe, commitOf, cardOf, total, isBJ, startHand, act, finish, canDo, publicActive, publicFinished, ticketOf, verifyRecord, settingsOf, wagered, CODE, RULES };
