'use strict';
/* Ballot Chain server: serves the page and keeps the election in a database (Postgres) so every device sees the same voters and ledger. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const B = require('./core.js');
const C = B.C;

const PORT = process.env.PORT || 3000;
const DEMO_TOOLS = (process.env.DEMO_TOOLS || 'on') !== 'off'; // set DEMO_TOOLS=off to hide tamper and reset buttons
const FILES = { '/': 'index.html', '/index.html': 'index.html', '/core.js': 'core.js', '/app.js': 'app.js', '/icon.svg': 'icon.svg', '/apple-touch-icon.png': 'apple-touch-icon.png' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const staticCache = {};
const ICON = require('./icon-data.js');
for (const f of new Set(Object.values(FILES))) if (!/^(icon\.svg|apple-touch-icon\.png)$/.test(f)) staticCache[f] = fs.readFileSync(path.join(__dirname, f));
staticCache['icon.svg'] = Buffer.from(ICON.svg, 'utf8');
staticCache['apple-touch-icon.png'] = Buffer.from(ICON.png, 'base64');

/* ---------- Storage ---------- */
function makeStore() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false } });
    return {
      name: 'postgres',
      async init() { await pool.query('CREATE TABLE IF NOT EXISTS election_state (id integer PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())'); },
      async load() { const r = await pool.query('SELECT data FROM election_state WHERE id = 1'); return r.rows[0] ? r.rows[0].data : null; },
      async save(S) { await pool.query('INSERT INTO election_state (id, data) VALUES (1, $1::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()', [JSON.stringify(S)]); }
    };
  }
  const file = process.env.STATE_FILE; // optional: keep state in a local file when there is no database
  return {
    name: file ? 'file' : 'memory',
    async init() {},
    async load() { if (!file) return null; try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } },
    async save(S) { if (file) fs.writeFileSync(file, JSON.stringify(S)); }
  };
}

const store = makeStore();
let S = null;
const challenges = new Map(); // id -> challenge (short-lived, memory only)
const sessions = new Map();   // token -> { i, exp }
const guards = new Map();     // client -> failed-attempt counter
const rates = new Map();      // client -> request counter
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''; // set this on the server to turn the admin page on
const adminSessions = new Map(); // token -> expiry time
const adminGuards = new Map();   // client -> wrong-password counter
const ADMIN_MS = 15 * 60000;
const same = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());
const adminOk = t => { const e = adminSessions.get(String(t)); if (e && Date.now() < e) return true; adminSessions.delete(String(t)); return false; };

/* One change at a time, so two voters can never overwrite each other. */
let queue = Promise.resolve();
const exclusive = fn => { const p = queue.then(fn); queue = p.catch(() => {}); return p; };
const mutate = fn => exclusive(async () => { const out = await fn(); await store.save(S); return out; });

function clientId(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim(); }
function guardFor(id) { let g = guards.get(id); if (!g) { g = B.newGuard(); guards.set(id, g); } return g; }
function limited(id, max) {
  const now = Date.now(); let r = rates.get(id);
  if (!r || now > r.reset) { r = { n: 0, reset: now + 60000 }; rates.set(id, r); }
  return ++r.n > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, c] of challenges) if (now > c.exp + 60000) challenges.delete(k);
  for (const [k, s] of sessions) if (now > s.exp) sessions.delete(k);
  for (const [k, r] of rates) if (now > r.reset) rates.delete(k);
  for (const [k, e] of adminSessions) if (now > e) adminSessions.delete(k);
}, 60000).unref();

/* ---------- HTTP helpers ---------- */
const HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'"
};
function send(res, code, body, type) { res.writeHead(code, Object.assign({ 'Content-Type': type }, HEADERS)); res.end(body); }
const json = (res, obj, code) => send(res, code || 200, JSON.stringify(obj), 'application/json; charset=utf-8');
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on('data', c => { n += c.length; if (n > 10000) { reject(new Error('Request too large')); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch (e) { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
const view = () => Object.assign(B.publicView(S), { tools: DEMO_TOOLS, storage: store.name });
const needTools = res => { if (DEMO_TOOLS) return false; json(res, { ok: false, error: 'This action is turned off on this server.' }, 403); return true; };

/* ---------- API ---------- */
async function api(req, res, url) {
  const cid = clientId(req), p = url.pathname;
  if (limited(cid, 120)) return json(res, { ok: false, error: 'Too many requests. Wait a minute and try again.' }, 429);
  if (req.method === 'GET' && p === '/api/state') return json(res, { ok: true, view: view() });
  if (req.method === 'GET' && p === '/api/receipt') return json(res, B.checkReceipt(S, parseInt(url.searchParams.get('i'), 10)));
  if (req.method !== 'POST') return json(res, { ok: false, error: 'Not found' }, 404);
  const body = await readBody(req);

  if (p === '/api/challenge') {
    if (limited('c:' + cid, 30)) return json(res, { ok: false, error: 'Too many attempts. Wait a minute and try again.' }, 429);
    const mode = body.mode === 'register' ? 'register' : 'signin', g = guardFor(cid);
    if (!B.validateAll(body.data)) return json(res, { ok: false, error: 'Some details are not in the correct format.' });
    if (mode === 'signin' && B.lockSeconds(g) > 0) return json(res, { ok: false, locked: true, error: 'Too many failed attempts. Try again in ' + B.lockSeconds(g) + ' seconds.' });
    const ch = await exclusive(async () => B.makeChallenge(S, body.data, mode));
    const id = crypto.randomBytes(8).toString('hex'); challenges.set(id, ch);
    return json(res, { ok: true, id, demoCode: ch.code, phone: B.maskPhone(body.data.phone) });
  }
  if (p === '/api/resend') {
    const ch = challenges.get(String(body.id));
    if (!ch) return json(res, { ok: false, error: 'This code request has ended. Start again.' });
    if (ch.resends >= C.MAX_RESENDS) return json(res, { ok: false, error: 'No more new codes. Start again.' });
    await exclusive(async () => B.resendChallenge(S, ch));
    return json(res, { ok: true, demoCode: ch.code });
  }
  if (p === '/api/verify') {
    if (limited('v:' + cid, 30)) return json(res, { status: 'denied', title: 'Slow down', msg: 'Too many attempts. Wait a minute and try again.' });
    const id = String(body.id), ch = challenges.get(id);
    if (!ch) return json(res, { status: 'denied', title: 'Code expired', msg: 'This code request has ended. Start again.' });
    const r = await mutate(async () => B.verifyChallenge(S, ch, String(body.code || ''), guardFor(cid)));
    if (r.status !== 'retry') challenges.delete(id);
    if (r.status === 'ok' && r.kind === 'signin') {
      const token = crypto.randomBytes(16).toString('hex');
      sessions.set(token, { i: r.voterIdx, exp: Date.now() + C.SESSION_MS });
      return json(res, { status: 'ok', kind: 'signin', token, label: S.voters[r.voterIdx].label });
    }
    return json(res, r);
  }
  if (p === '/api/vote') {
    const s = sessions.get(String(body.token));
    if (!s || Date.now() > s.exp) { sessions.delete(String(body.token)); return json(res, { ok: false, expired: true, error: 'Your session has ended. Sign in again to vote.' }); }
    try {
      const r = await mutate(async () => B.castVote(S, s.i, String(body.candidate)));
      sessions.delete(String(body.token));
      return json(res, { ok: true, ballot: r.ballot, block: r.block });
    } catch (e) { return json(res, { ok: false, error: e.message }); }
  }
  if (p === '/api/admin/login') {
    if (!ADMIN_PASSWORD) return json(res, { ok: false, disabled: true, error: 'The admin page is turned off. Set ADMIN_PASSWORD on the server to turn it on.' });
    let g = adminGuards.get(cid); if (!g) { g = B.newGuard(); adminGuards.set(cid, g); }
    if (B.lockSeconds(g) > 0) return json(res, { ok: false, error: 'Too many wrong passwords. Try again in ' + B.lockSeconds(g) + ' seconds.' });
    if (!same(body.password || '', ADMIN_PASSWORD)) {
      if (++g.fails >= 5) { g.fails = 0; g.lockUntil = Date.now() + 60000; }
      return json(res, { ok: false, error: 'Wrong password.' });
    }
    g.fails = 0;
    const token = crypto.randomBytes(16).toString('hex'); adminSessions.set(token, Date.now() + ADMIN_MS);
    return json(res, { ok: true, token });
  }
  if (p === '/api/admin/logout') { adminSessions.delete(String(body.token)); return json(res, { ok: true }); }
  if (p === '/api/admin/reset-voter') {
    if (!adminOk(body.token)) return json(res, { ok: false, expired: true, error: 'Your admin session has ended. Sign in again.' });
    try { await mutate(async () => B.resetVoter(S, parseInt(body.i, 10))); return json(res, { ok: true }); }
    catch (e) { return json(res, { ok: false, error: e.message }); }
  }
  if (p === '/api/seal') { await mutate(async () => B.seal(S)); return json(res, { ok: true }); }
  if (p === '/api/flip') { if (needTools(res)) return; await mutate(async () => B.flip(S, +body.b, +body.j)); return json(res, { ok: true }); }
  if (p === '/api/remine') { if (needTools(res)) return; await mutate(async () => B.remine(S, +body.b)); return json(res, { ok: true }); }
  if (p === '/api/reset') { if (needTools(res)) return; await mutate(async () => { S = B.seedDemo(B.newElection()); }); return json(res, { ok: true }); }
  return json(res, { ok: false, error: 'Not found' }, 404);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const f = FILES[url.pathname];
    if (req.method === 'GET' && f) return send(res, 200, staticCache[f], TYPES[path.extname(f)]);
    send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, { ok: false, error: 'Something went wrong on the server. Try again.' }, 500);
  }
});

(async function start() {
  await store.init();
  const saved = await store.load();
  if (B.isState(saved)) S = saved;
  else { S = B.seedDemo(B.newElection()); await store.save(S); }
  server.listen(PORT, () => console.log('Ballot Chain on port ' + PORT + ' (storage: ' + store.name + ', ' + S.voters.length + ' voters, ' + S.chain.length + ' blocks)'));
})().catch(e => { console.error('Could not start:', e); process.exit(1); });
