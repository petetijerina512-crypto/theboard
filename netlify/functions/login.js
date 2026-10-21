'use strict';
// POST { id, password } -> { token, exp, user }
// Checks the password on the server. Locks an account (or an IP) for 15 minutes
// after 8 wrong passwords in a row.
const B = require('./board');

const MAX_FAILS = 8;
const LOCK_MS = 15 * 60 * 1000;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: {}, body: '' };
  if (event.httpMethod !== 'POST') return B.reply(405, { error: 'POST only' });
  try {
    const body = B.parseBody(event);
    const id = String(body.id == null ? '' : body.id).trim();
    const pw = body.password == null ? '' : String(body.password);
    if (!id || !pw) throw new B.HttpError(400, 'Enter User ID and Password');
    const store = await B.getStore(event);
    const ip = B.clientIp(event);
    const keys = ['u:' + id.toLowerCase(), 'ip:' + ip];

    const { data: fails } = await B.readKey(store, B.AUTH_KEY);
    const now = Date.now();
    const locked = keys.some(k => fails && fails[k] && fails[k].until > now);
    if (locked) throw new B.HttpError(429, 'Too many tries. Wait 15 minutes and try again.');

    const { st } = await B.readState(store);   // runs the password migration if needed
    const user = B.findUser(st, id);
    const ok = !!(user && user.passHash && B.verifyPassword(pw, user.passHash));

    await B.mutate(store, f => {
      const had = keys.some(k => k in f);
      if (ok && !had) return { noWrite: true };
      Object.keys(f).forEach(k => { if (f[k] && f[k].until && f[k].until < now && !f[k].n) delete f[k]; });
      keys.forEach(k => {
        if (ok) { delete f[k]; return; }
        const r = f[k] || { n: 0, until: 0 };
        r.n = (r.until && r.until < now) ? 1 : r.n + 1;
        r.until = r.n >= MAX_FAILS ? now + LOCK_MS : 0;
        if (r.n >= MAX_FAILS) r.n = 0;
        f[k] = r;
      });
      return {};
    }, B.AUTH_KEY);

    if (!ok) throw new B.HttpError(401, 'Invalid credentials.');
    const t = B.makeToken(user);
    return B.reply(200, { token: t.token, exp: t.exp, user: B.publicUser(user) });
  } catch (e) { return B.fail(e); }
};
