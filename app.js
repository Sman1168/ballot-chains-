'use strict';
/* Ballot Chain page. Talks to the shared server database when it is there, otherwise keeps everything in this browser. */
const B = window.BallotCore, C = B.C;
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (h, n = 14) => h.slice(0, n) + '…';
const NET = 'Could not reach the server. Check your connection and try again.';

/* ---------- Backend 1: this browser only (saved in localStorage) ---------- */
const LS_KEY = 'ballotchain.state.v1';
function makeLocal() {
  let S = null; const chs = {}, sess = {}, g = B.newGuard();
  const save = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (e) { /* storage blocked: keep working in memory */ } };
  try { const raw = localStorage.getItem(LS_KEY); if (raw) { const p = JSON.parse(raw); if (B.isState(p)) S = p; } } catch (e) { /* ignore */ }
  if (!S) { S = B.seedDemo(B.newElection()); save(); }
  return {
    mode: 'local',
    async state() { return Object.assign(B.publicView(S), { tools: true }); },
    async challenge(mode, data) {
      if (!B.validateAll(data)) return { ok: false, error: 'Some details are not in the correct format.' };
      if (mode === 'signin' && B.lockSeconds(g) > 0) return { ok: false, locked: true, error: 'Too many failed attempts. Try again in ' + B.lockSeconds(g) + ' seconds.' };
      const ch = B.makeChallenge(S, data, mode), id = B.randHex(8); chs[id] = ch;
      return { ok: true, id, demoCode: ch.code, phone: B.maskPhone(data.phone) };
    },
    async resend(id) {
      const ch = chs[id];
      if (!ch) return { ok: false, error: 'This code request has ended. Start again.' };
      if (ch.resends >= C.MAX_RESENDS) return { ok: false, error: 'No more new codes. Start again.' };
      B.resendChallenge(S, ch); return { ok: true, demoCode: ch.code };
    },
    async verify(id, code) {
      const ch = chs[id];
      if (!ch) return { status: 'denied', title: 'Code expired', msg: 'This code request has ended. Start again.' };
      const r = B.verifyChallenge(S, ch, code, g);
      if (r.status !== 'retry') delete chs[id];
      if (r.status === 'ok' && r.kind === 'signin') {
        const token = B.randHex(16); sess[token] = { i: r.voterIdx, exp: Date.now() + C.SESSION_MS };
        return { status: 'ok', kind: 'signin', token, label: S.voters[r.voterIdx].label };
      }
      if (r.status === 'ok') save();
      return r;
    },
    async vote(token, candidate) {
      const s = sess[token];
      if (!s || Date.now() > s.exp) { delete sess[token]; return { ok: false, expired: true, error: 'Your session has ended. Sign in again to vote.' }; }
      try { const r = B.castVote(S, s.i, candidate); delete sess[token]; save(); return { ok: true, ballot: r.ballot, block: r.block }; }
      catch (e) { return { ok: false, error: e.message }; }
    },
    async seal() { B.seal(S); save(); return { ok: true }; },
    async flip(b, j) { B.flip(S, b, j); save(); return { ok: true }; },
    async remine(b) { B.remine(S, b); save(); return { ok: true }; },
    async receipt(i) { return B.checkReceipt(S, i); },
    async reset() { S = B.seedDemo(B.newElection()); save(); return { ok: true }; },
    async adminLogin() { return { ok: false, disabled: true, error: 'The admin page needs the shared server.' }; },
    async adminReset() { return { ok: false, error: 'The admin page needs the shared server.' }; },
    async adminLogout() { return { ok: true }; }
  };
}

/* ---------- Backend 2: shared server and database ---------- */
function makeRemote() {
  const call = async (method, path, body) => {
    const r = await fetch(path, { method, cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    return r.json();
  };
  return {
    mode: 'remote',
    async state() { const j = await call('GET', '/api/state'); if (!j.ok) throw new Error('state'); return j.view; },
    challenge: (mode, data) => call('POST', '/api/challenge', { mode, data }),
    resend: id => call('POST', '/api/resend', { id }),
    verify: (id, code) => call('POST', '/api/verify', { id, code }),
    vote: (token, candidate) => call('POST', '/api/vote', { token, candidate }),
    seal: () => call('POST', '/api/seal', {}),
    flip: (b, j) => call('POST', '/api/flip', { b, j }),
    remine: b => call('POST', '/api/remine', { b }),
    receipt: i => call('GET', '/api/receipt?i=' + i),
    reset: () => call('POST', '/api/reset', {}),
    adminLogin: password => call('POST', '/api/admin/login', { password }),
    adminReset: (token, i) => call('POST', '/api/admin/reset-voter', { token, i }),
    adminLogout: token => call('POST', '/api/admin/logout', { token })
  };
}

/* ---------- Page state ---------- */
let API = null, V = null, SESSION = null;
let ADMIN = null; // { token, exp, msg, confirm } while the admin is signed in
let F = { mode: null, data: {}, outcome: null, msg: '', title: '', ch: null };
let RM = {}; // receipt messages by voter number
const blank = () => ({ mode: null, data: {}, outcome: null, msg: '', title: '', ch: null });
const STEPS = [
  { key: 'name', title: 'Your full name', label: 'Full name', hint: 'First name and last name, as on your voter\'s card.', type: 'text', mode: 'text', ac: 'off', ph: 'e.g. Ada Okafor', validate: B.validate.name },
  { key: 'phone', title: 'Your phone number', label: 'Phone number', hint: 'A Nigerian mobile number, like 0803 123 4567 or +234 803 123 4567.', type: 'tel', mode: 'tel', ac: 'off', ph: '0803 123 4567', validate: B.validate.phone },
  { key: 'nin', title: 'Your NIN', label: 'National Identification Number (NIN)', hint: 'The 11-digit number on your NIN slip or card.', type: 'password', mode: 'numeric', ac: 'off', ph: '11 digits', secret: true, validate: B.validate.nin },
  { key: 'card', title: 'Your voter\'s card number', label: 'Voter\'s card number (VIN)', hint: 'The 19-character number printed on your permanent voter\'s card.', type: 'password', mode: 'text', ac: 'off', ph: '19 letters and digits', secret: true, validate: B.validate.card }
];
const STEP_KEYS = STEPS.map(s => s.key), TOTAL = STEPS.length + 1, FLOW = $('view-flow');
const sessionOk = () => !!(SESSION && Date.now() < SESSION.exp);
const stepBars = i => Array.from({ length: TOTAL }, (_, k) => `<i class="${k < i ? 'done' : k === i ? 'cur' : ''}"></i>`).join('');
function netError() {
  const el = ['otpMsg', 'stepMsg', 'voteMsg', 'adminMsg', 'resultsMsg', 'accessMsg'].map($).find(x => x && x.offsetParent !== null);
  if (el) el.textContent = NET;
}
async function refresh() { V = await API.state(); }

/* ---------- Results page (ledger, tally, roll) ---------- */
function setChips() {
  ['modeChip', 'modeChip2'].forEach(id => {
    const el = $(id); el.hidden = false;
    el.className = 'chip ' + (API.mode === 'remote' ? 'ok' : 'wait');
    el.textContent = API.mode === 'remote' ? 'Shared server database' : 'Saved in this browser only';
  });
}
function renderHome() {
  if (!V) return;
  const a = V.audit, chain = V.chain;
  setChips();
  $('resetBtn').hidden = !V.tools;
  $('banner').innerHTML = a.ok
    ? `<div class="banner ok"><span class="dot"></span><div><strong>Audit passed</strong><span class="d">${chain.length} block${chain.length === 1 ? '' : 's'}, every hash and link verified.</span></div></div>`
    : `<div class="banner bad"><span class="dot"></span><div><strong>Tampering detected</strong><span class="d">${esc(a.msg)}</span></div></div>`;
  const c = Object.fromEntries(V.candidates.map(x => [x, 0]));
  chain.forEach(b => b.votes.forEach(v => { if (v.candidate in c) c[v.candidate]++; }));
  const pc = Object.fromEntries(V.candidates.map(x => [x, 0]));
  V.pending.forEach(v => { if (v.candidate in pc) pc[v.candidate]++; });
  const total = Object.values(c).reduce((x, y) => x + y, 0), waiting = V.pending.length;
  const max = Math.max(1, ...V.candidates.map(n => c[n] + pc[n]));
  $('tallyMeta').textContent = (total + waiting) + ' cast · ' + total + ' sealed · ' + waiting + ' pending';
  $('tally').innerHTML = V.candidates.map(n => `<div class="tally-row" style="grid-template-columns:90px 1fr 70px"><span>${esc(n)}</span><div class="bar"><i style="width:${(c[n] + pc[n]) / max * 100}%"></i></div><b>${c[n] + pc[n]}${pc[n] ? ` <span class="mono" title="Not sealed into a block yet">(${pc[n]} pending)</span>` : ''}</b></div>`).join('');
  $('rollMeta').textContent = V.voters.filter(v => v.status !== 'removed').length + ' registered';
  $('voters').innerHTML = V.voters.map((v, i) => {
    if (v.status === 'removed') return '';
    const state = v.status === 'none' ? '<span class="chip">Not voted</span>' : v.status === 'sealed' ? '<span class="chip ok">Vote sealed</span>' : '<span class="chip wait">In pending pool</span>';
    const r = RM[i], res = r && r.t ? `<div class="msg ${r.ok ? 'ok' : 'bad'}" style="flex-basis:100%">${esc(r.t)}</div>` : '';
    return `<div class="voter"><span class="who mono">${esc(v.label)}</span>${state}${v.status === 'sealed' ? `<button class="btn ghost small" data-a="receipt" data-i="${i}">Check receipt</button>` : ''}${res}</div>`;
  }).join('') || '<p class="sub">No voters registered yet.</p>';
  $('pending').innerHTML = V.pending.length ? `<div class="pending"><div class="row" style="justify-content:space-between"><span class="label">Pending pool (${V.pending.length} of ${C.BATCH})</span><button class="btn small" data-a="seal">Seal block now</button></div>${V.pending.map(v => `<div class="vote"><span class="cand">${esc(v.candidate)}</span><span class="mono">${esc(short(v.nullifier))}</span></div>`).join('')}<p class="msg">Blocks seal automatically at ${C.BATCH} votes. Pending votes are not on the chain yet.</p></div>` : '';
  $('blocks').innerHTML = chain.map((b, i) => {
    const bad = a.blocks[i], root = B.blockRoot(b), re = B.blockHash(b), mism = re !== b.hash;
    const votes = b.votes.map((v, j) => `<div class="vote"><span class="cand">${esc(v.candidate)}</span><span class="mono">ballot ${esc(v.ballot_id)}</span>${V.tools ? `<button class="btn danger small" data-a="flip" data-b="${i}" data-j="${j}">Tamper: change vote</button>` : ''}</div>`).join('');
    return `<article class="block ${bad ? 'bad' : ''}">
      <div class="block-head"><h3>${i === 0 ? 'Genesis block' : 'Block ' + i}</h3>${bad ? `<span class="chip bad">${esc(bad)}</span>` : '<span class="chip ok">Valid</span>'}</div>
      <dl class="kv" style="margin:0">
        <dt>Hash</dt><dd class="mono">${esc(b.hash)}</dd>
        ${mism ? `<dt>Recomputed</dt><dd class="mono diff">${esc(re)}</dd>` : ''}
        <dt>Previous</dt><dd class="mono">${esc(b.prev)}</dd>
        <dt>Merkle root</dt><dd class="mono">${esc(root)}</dd>
        <dt>Nonce</dt><dd class="mono">${b.nonce}</dd>
      </dl>
      ${b.votes.length ? `<div class="vlist">${votes}</div>${V.tools ? `<div class="row"><button class="btn danger small" data-a="remine" data-b="${i}">Attacker re-mines this block</button></div>` : ''}` : '<p class="msg">No votes. Anchors the chain.</p>'}
    </article>`;
  }).join('');
}

/* ---------- Pages (hash routes: home, signin, register, results, admin, name, phone, nin, card, code, vote, done, registered, denied) ---------- */
function showView(name) { $('view-front').hidden = name !== 'front'; $('view-home').hidden = name !== 'results'; FLOW.hidden = name !== 'flow'; }
function redirect(h) { location.replace('#' + h); }
const demoHtml = () => C.DEMO.map(d => `<div><b>${esc(d.name)}</b><span class="mono">Phone ${esc(d.phone)}</span><span class="mono">NIN ${esc(d.nin)}</span><span class="mono">Card ${esc(d.card)}</span></div>`).join('');
function renderSignin() {
  FLOW.innerHTML = `<section class="panel flow">
    <div class="panel-head"><span class="label">Sign in</span><button class="btn ghost small" type="button" data-go="home">Home</button></div>
    <h2>Sign in to vote</h2>
    <p class="sub">You will be asked for your full name, phone number, NIN and voter's card number, one on each page, then a one-time code sent to your phone. Use the same four details you registered with.</p>
    <div class="row"><button class="btn" type="button" data-a="start-signin">Start sign-in</button><button class="btn ghost" type="button" data-go="register">I need to register</button></div>
    <div class="notice"><b>Forgot the details you registered with?</b> They are kept only as hashes, so nobody can read them back for you. Ask the election admin to reset your registration, then register again and write the four details down.</div>
    <details>
      <summary>Demo accounts for testing</summary>
      <p class="sub" style="margin-top:8px">Made-up details for this demo only. Do not enter your own NIN or voter's card number.</p>
      <div class="demo">${demoHtml()}</div>
    </details>
  </section>`;
  showView('flow');
}
function renderRegister() {
  FLOW.innerHTML = `<section class="panel flow">
    <div class="panel-head"><span class="label">Register</span><button class="btn ghost small" type="button" data-go="home">Home</button></div>
    <h2>Register as a voter</h2>
    <p class="sub">Registration takes your full name, phone number, NIN and voter's card number, one on each page, then a one-time code sent to your phone. Each NIN and voter's card can be registered once.</p>
    <div class="notice"><b>Keep a note of what you enter.</b> You need the same four details, spelled the same way, every time you sign in. They cannot be read back later.</div>
    <div class="row"><button class="btn" type="button" data-a="start-register">Start registration</button><button class="btn ghost" type="button" data-go="signin">I already registered</button></div>
  </section>`;
  showView('flow');
}
async function renderAdmin() {
  const adminOn = !!(ADMIN && Date.now() < ADMIN.exp);
  if (API.mode !== 'remote') {
    FLOW.innerHTML = `<section class="panel flow"><div class="panel-head"><span class="label">Admin</span><button class="btn ghost small" type="button" data-go="home">Home</button></div>
      <h2>Admin</h2><p class="sub">The admin page needs the shared server and database. This copy of the page is saved in this browser only.</p></section>`;
    return showView('flow');
  }
  if (!adminOn) {
    ADMIN = null;
    FLOW.innerHTML = `<section class="panel flow">
      <div class="panel-head"><span class="label">Admin</span><button class="btn ghost small" type="button" data-go="home">Home</button></div>
      <h2>Admin sign-in</h2>
      <form id="adminForm" class="field" novalidate>
        <label for="adminPw">Admin password</label>
        <input id="adminPw" name="password" type="password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Password">
        <p class="msg bad" id="adminMsg" role="alert"></p>
        <div class="row"><button class="btn" type="submit">Sign in</button></div>
      </form>
    </section>`;
    showView('flow'); $('adminPw').focus(); return;
  }
  try { await refresh(); } catch (e) { ADMIN.msg = NET; }
  const list = V ? V.voters : [], live = list.filter(v => v.status !== 'removed');
  const rows = list.map((v, i) => {
    if (v.status === 'removed') return '';
    if (v.status !== 'none') return `<div class="voter"><span class="who mono">${esc(v.label)}</span><span class="chip ok">Voted</span><span class="msg" style="min-height:0">Cannot be reset</span></div>`;
    const ask = ADMIN.confirm === i;
    return `<div class="voter"><span class="who mono">${esc(v.label)}</span><span class="chip">Not voted</span>${ask
      ? `<span class="msg" style="min-height:0">Reset this registration?</span><button class="btn danger small" type="button" data-a="admin-yes" data-i="${i}">Yes, reset</button><button class="btn ghost small" type="button" data-a="admin-no">Cancel</button>`
      : `<button class="btn ghost small" type="button" data-a="admin-reset" data-i="${i}">Reset registration</button>`}</div>`;
  }).join('') || '<p class="sub">No voters registered yet.</p>';
  FLOW.innerHTML = `<section class="panel">
    <div class="panel-head"><span class="label">Admin</span><div class="row"><button class="btn ghost small" type="button" data-go="home">Home</button><button class="btn ghost small" type="button" data-a="admin-out">Sign out of admin</button></div></div>
    <h2>Registered voters</h2>
    <p class="sub">Voters' details are kept only as hashes, so nobody, including the admin, can read a forgotten detail back. If a voter cannot sign in, reset their registration here. They can then register again. A voter who has already voted cannot be reset.</p>
    <p class="msg ${ADMIN.msg && ADMIN.msg.startsWith('Registration reset') ? 'ok' : 'bad'}" id="adminMsg" role="alert">${esc(ADMIN.msg || '')}</p>
    <div class="label">${live.length} registered</div>
    <div class="voters">${rows}</div>
  </section>`;
  showView('flow');
}
function renderCode() {
  const signin = F.mode === 'signin', ch = F.ch, mins = Math.round(C.OTP_MS / 60000);
  FLOW.innerHTML = `<section class="panel flow">
    <div class="panel-head"><span class="label">Step ${TOTAL} of ${TOTAL} · ${signin ? 'Sign in' : 'Register'}</span><button class="btn ghost small" type="button" data-a="cancel">Cancel</button></div>
    <div class="steps" aria-hidden="true">${stepBars(TOTAL - 1)}</div>
    <h2>Check your phone</h2>
    <form id="otpForm" class="field" novalidate>
      <label for="otpInput">6-digit code</label>
      <p class="sub">We sent a code to ${esc(ch.phone)}. It is valid for ${mins} minutes.</p>
      <input id="otpInput" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" autocapitalize="off" autocorrect="off" spellcheck="false">
      <p class="msg bad" id="otpMsg" role="alert"></p>
      <div class="row">
        <button class="btn ghost" type="button" data-go="card">Back</button>
        <button class="btn" type="submit">${signin ? 'Verify and sign in' : 'Verify and register'}</button>
        <button class="btn ghost small" type="button" data-a="resend">Send a new code</button>
      </div>
    </form>
    <div class="notice"><b>Demo SMS inbox.</b> A real system sends this by SMS to the registered phone. No text message is sent here, so the code is shown instead.<br><span class="mono" id="smsBox">Ballot Chain code: ${esc(ch.code)}</span></div>
  </section>`;
  showView('flow'); $('otpInput').focus();
}
function renderStep(i) {
  const st = STEPS[i], signin = F.mode === 'signin';
  const where = API.mode === 'remote' ? 'Details are sent over HTTPS to this demo server and kept only as salted hashes.' : 'Details stay in this browser and are kept only as salted hashes.';
  FLOW.innerHTML = `<section class="panel flow">
    <div class="panel-head"><span class="label">Step ${i + 1} of ${TOTAL} · ${signin ? 'Sign in' : 'Register'}</span><button class="btn ghost small" type="button" data-a="cancel">Cancel</button></div>
    <div class="steps" aria-hidden="true">${stepBars(i)}</div>
    <h2>${esc(st.title)}</h2>
    <form id="stepForm" class="field" novalidate>
      <label for="stepInput">${esc(st.label)}</label>
      <p class="sub">${esc(st.hint)}</p>
      <div class="row">
        <input id="stepInput" name="${st.key}" type="${st.type}" inputmode="${st.mode}" autocomplete="${st.ac}" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="${esc(st.ph)}" value="${esc(F.data[st.key] || '')}">
        ${st.secret ? '<button class="btn ghost small" type="button" data-a="toggle">Show</button>' : ''}
      </div>
      <p class="msg bad" id="stepMsg" role="alert"></p>
      <div class="row">
        ${i > 0 ? `<button class="btn ghost" type="button" data-go="${STEP_KEYS[i - 1]}">Back</button>` : ''}
        <button class="btn" type="submit">Continue</button>
      </div>
    </form>
    <p class="notice">Demo only. ${where} Do not enter a real NIN or voter's card number; use the demo accounts on the sign-in page.</p>
  </section>`;
  showView('flow'); $('stepInput').focus();
}
function renderVote() {
  FLOW.innerHTML = `<section class="panel flow">
    <div class="panel-head"><span class="label">Voting booth</span><button class="btn ghost small" type="button" data-a="signout">Sign out</button></div>
    <div class="banner ok"><span class="dot"></span><div><strong>Signed in</strong><span class="d mono">${esc(SESSION.label)}</span></div></div>
    <h2>Choose one candidate</h2>
    <form id="voteForm" class="field">
      <div class="cands">${C.CANDIDATES.map((c, i) => `<label><input type="radio" name="cand" value="${esc(c)}"${i === 0 ? ' checked' : ''}>${esc(c)}</label>`).join('')}</div>
      <p class="msg bad" id="voteMsg" role="alert"></p>
      <button class="btn" type="submit">Cast vote</button>
    </form>
    <p class="notice">Your session ends after ${C.SESSION_MS / 60000} minutes or when you cast your vote. The ledger stores an anonymous ID, not your name.</p>
  </section>`;
  showView('flow');
}
function renderOutcome(kind) {
  const body = {
    done: `<div class="banner ok"><span class="dot"></span><div><strong>Vote recorded</strong><span class="d">${F.block != null ? 'Sealed in block ' + F.block + '.' : 'In the pending pool. It is sealed into a block when ' + C.BATCH + ' votes are in.'}</span></div></div>
      <p class="sub">Ballot ID <span class="mono">${esc(F.ballot || '')}</span>. You have been signed out. Use "Check receipt" on the results page to confirm your vote stays unchanged.</p>
      <div class="row"><button class="btn" type="button" data-go="results">See the results</button><button class="btn ghost" type="button" data-go="home">Home</button></div>`,
    registered: `<div class="banner ok"><span class="dot"></span><div><strong>Voter record created</strong><span class="d">Your details are stored only as salted hashes.</span></div></div>
      <p class="sub">Now sign in with the same four details to vote. Keep a note of the name, phone number, NIN and voter's card number you just used. If you forget them, the election admin has to reset your registration.</p>
      <div class="row"><button class="btn" type="button" data-a="start-signin">Sign in now</button><button class="btn ghost" type="button" data-go="home">Home</button></div>`,
    denied: `<div class="banner bad"><span class="dot"></span><div><strong>${esc(F.title)}</strong><span class="d">${esc(F.msg)}</span></div></div>
      <div class="row"><button class="btn" type="button" data-a="again">Try again</button><button class="btn ghost" type="button" data-go="home">Home</button></div>`
  }[kind];
  FLOW.innerHTML = `<section class="panel flow">${body}</section>`;
  showView('flow');
}
async function route() {
  const r = location.hash.slice(1) || 'home', idx = STEP_KEYS.indexOf(r);
  if (idx >= 0) {
    if (!F.mode) return redirect('home');
    for (let k = 0; k < idx; k++) if (!F.data[STEP_KEYS[k]]) return redirect(STEP_KEYS[k]);
    renderStep(idx);
  } else if (r === 'code') {
    if (!F.mode) return redirect('home');
    for (let k = 0; k < STEP_KEYS.length; k++) if (!F.data[STEP_KEYS[k]]) return redirect(STEP_KEYS[k]);
    if (!F.ch) return redirect('card');
    renderCode();
  } else if (r === 'vote') {
    if (!sessionOk()) { SESSION = null; $('accessMsg').textContent = 'Your session has ended. Sign in again to vote.'; return redirect('home'); }
    renderVote();
  } else if (r === 'done' || r === 'registered' || r === 'denied') {
    if (F.outcome !== r) return redirect('home');
    renderOutcome(r);
  } else if (r === 'signin') {
    renderSignin();
  } else if (r === 'register') {
    renderRegister();
  } else if (r === 'admin') {
    await renderAdmin();
  } else if (r === 'results') {
    showView('results'); $('resultsMsg').textContent = '';
    try { await refresh(); } catch (e) { $('resultsMsg').textContent = NET; }
    renderHome();
  } else {
    showView('front'); setChips();
  }
  window.scrollTo(0, 0);
}
function startFlow(mode) {
  $('accessMsg').textContent = '';
  F = Object.assign(blank(), { mode });
  location.hash = '#name';
}
function deny(title, msg) { F.outcome = 'denied'; F.title = title; F.msg = msg; F.data = {}; F.ch = null; location.hash = '#denied'; }
async function afterDetails() {
  const r = await API.challenge(F.mode, F.data);
  if (!r.ok) return r.locked ? deny('Sign-in locked', r.error) : void ($('stepMsg').textContent = r.error || NET);
  F.ch = { id: r.id, code: r.demoCode, phone: r.phone };
  location.hash = '#code';
}
async function submitCode(entered) {
  const r = await API.verify(F.ch.id, entered);
  if (r.status === 'retry') { $('otpMsg').textContent = r.msg; $('otpInput').value = ''; $('otpInput').focus(); return; }
  if (r.status === 'denied') return deny(r.title, r.msg);
  if (r.status === 'ok' && r.kind === 'signin') {
    SESSION = { token: r.token, label: r.label, exp: Date.now() + C.SESSION_MS };
    F.data = {}; F.ch = null; location.hash = '#vote'; return;
  }
  if (r.status === 'ok') { F.outcome = 'registered'; F.data = {}; F.ch = null; location.hash = '#registered'; return; }
  $('otpMsg').textContent = NET;
}

/* ---------- Events ---------- */
async function onClick(e) {
  const g = e.target.closest('[data-go]'); if (g) { location.hash = '#' + g.dataset.go; return; }
  const t = e.target.closest('[data-a]'); if (!t) return;
  const a = t.dataset.a;
  if (a === 'start-signin') return startFlow('signin');
  if (a === 'start-register') return startFlow('register');
  if (a === 'again') return startFlow(F.mode);
  if (a === 'cancel') { F = blank(); location.hash = '#home'; return; }
  if (a === 'signout') { SESSION = null; F = blank(); location.hash = '#home'; return; }
  if (a === 'toggle') { const inp = $('stepInput'), show = inp.type === 'password'; inp.type = show ? 'text' : 'password'; t.textContent = show ? 'Hide' : 'Show'; inp.focus(); return; }
  if (a === 'resend') {
    const r = await API.resend(F.ch.id);
    if (!r.ok) { $('otpMsg').textContent = r.error; return; }
    F.ch.code = r.demoCode; renderCode(); $('otpMsg').textContent = 'A new code was sent. The old code no longer works.'; return;
  }
  if (a === 'admin-reset') { ADMIN.confirm = +t.dataset.i; ADMIN.msg = ''; return renderAdmin(); }
  if (a === 'admin-no') { ADMIN.confirm = null; return renderAdmin(); }
  if (a === 'admin-yes') {
    const r = await API.adminReset(ADMIN.token, +t.dataset.i);
    if (r.expired) { ADMIN = null; return renderAdmin(); }
    ADMIN.confirm = null; ADMIN.msg = r.ok ? 'Registration reset. The voter can register again.' : (r.error || NET);
    return renderAdmin();
  }
  if (a === 'admin-out') { await API.adminLogout(ADMIN.token).catch(() => {}); ADMIN = null; location.hash = '#home'; return; }
  if (a === 'reset') { await API.reset(); RM = {}; $('accessMsg').textContent = ''; }
  if (a === 'seal') await API.seal();
  if (a === 'flip') await API.flip(+t.dataset.b, +t.dataset.j);
  if (a === 'remine') await API.remine(+t.dataset.b);
  if (a === 'receipt') RM[+t.dataset.i] = await API.receipt(+t.dataset.i);
  await refresh(); renderHome();
}
async function onSubmit(e) {
  e.preventDefault();
  if (e.target.id === 'stepForm') {
    const i = STEP_KEYS.indexOf(location.hash.slice(1)); if (i < 0) return;
    const val = $('stepInput').value.trim(), err = STEPS[i].validate(val);
    if (err) { $('stepMsg').textContent = err; $('stepInput').focus(); return; }
    F.data[STEPS[i].key] = val;
    if (i < STEPS.length - 1) location.hash = '#' + STEP_KEYS[i + 1]; else await afterDetails();
  }
  if (e.target.id === 'adminForm') {
    const pw = $('adminPw').value;
    if (!pw) { $('adminMsg').textContent = 'Enter the admin password.'; $('adminPw').focus(); return; }
    const r = await API.adminLogin(pw);
    if (!r.ok) { $('adminMsg').textContent = r.error || NET; $('adminPw').value = ''; return; }
    ADMIN = { token: r.token, exp: Date.now() + 15 * 60000, msg: '', confirm: null };
    return renderAdmin();
  }
  if (e.target.id === 'otpForm') {
    const entered = $('otpInput').value.trim();
    if (!/^\d{6}$/.test(entered)) { $('otpMsg').textContent = 'Enter the 6-digit code.'; $('otpInput').focus(); return; }
    await submitCode(entered);
  }
  if (e.target.id === 'voteForm') {
    if (!sessionOk()) { SESSION = null; return route(); }
    const cand = (document.querySelector('input[name=cand]:checked') || {}).value;
    const r = await API.vote(SESSION.token, cand);
    if (!r.ok) {
      if (r.expired) { SESSION = null; $('accessMsg').textContent = r.error; return redirect('home'); }
      $('voteMsg').textContent = r.error; return;
    }
    SESSION = null; F = Object.assign(blank(), { outcome: 'done', ballot: r.ballot, block: r.block });
    location.hash = '#done';
  }
}
document.addEventListener('click', e => { onClick(e).catch(netError); });
document.addEventListener('submit', e => { onSubmit(e).catch(netError); });
window.addEventListener('hashchange', () => { route().catch(netError); });
setInterval(async () => { /* shared mode: show other people's votes without a refresh */
  if (!API || API.mode !== 'remote' || document.hidden || location.hash !== '#results') return;
  try { await refresh(); renderHome(); } catch (e) { /* try again next time */ }
}, 8000);

(async function boot() {
  try {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 3000);
    const r = await fetch('/api/state', { cache: 'no-store', signal: ctl.signal }); clearTimeout(timer);
    const j = await r.json();
    if (j && j.ok && j.view) API = makeRemote();
  } catch (e) { /* no server here: use this browser */ }
  if (!API) API = makeLocal();
  if (location.hash && !['#home', '#signin', '#register', '#results', '#admin'].includes(location.hash)) location.replace('#home');
  await route();
})();
