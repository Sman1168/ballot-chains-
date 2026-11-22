/* Ballot Chain core: chain, identity and sign-in logic shared by the browser and the server. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BallotCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const C = {
    DIFFICULTY: 3, BATCH: 3, CANDIDATES: ['APC', 'PDP', 'ADC'],
    SESSION_MS: 120000, MAX_FAILS: 3, LOCK_MS: 30000, OTP_MS: 300000, MAX_CODE_TRIES: 3, MAX_RESENDS: 3,
    DEMO: [
      { name: 'Ada Okafor', phone: '08031234567', nin: '12345678901', card: '90F5B12345678901234' },
      { name: 'Bola Adeyemi', phone: '08052345678', nin: '23456789012', card: '91A2C23456789012345' },
      { name: 'Chidi Nwosu', phone: '07063456789', nin: '34567890123', card: '92B3D34567890123456' }
    ]
  };

  /* ---------- SHA-256 (synchronous, runs the same in Node and the browser) ---------- */
  const SHA_K = [], SHA_H0 = [];
  (function () {
    const primes = []; for (let n = 2; primes.length < 64; n++) { if (primes.every(p => n % p)) primes.push(n); }
    primes.forEach((p, i) => { SHA_K[i] = (Math.pow(p, 1 / 3) % 1) * 4294967296 | 0; if (i < 8) SHA_H0[i] = (Math.pow(p, 1 / 2) % 1) * 4294967296 | 0; });
  })();
  function sha(str) {
    const bytes = new TextEncoder().encode(str), l = bytes.length, bits = l * 8;
    const total = ((l + 9 + 63) >> 6) << 6, buf = new Uint8Array(total); buf.set(bytes); buf[l] = 0x80;
    const dv = new DataView(buf.buffer); dv.setUint32(total - 8, Math.floor(bits / 4294967296)); dv.setUint32(total - 4, bits >>> 0);
    const h = SHA_H0.slice(), w = new Int32Array(64), ror = (x, n) => (x >>> n) | (x << (32 - n));
    for (let o = 0; o < total; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
      for (let i = 16; i < 64; i++) {
        const a = w[i - 15], b = w[i - 2];
        w[i] = (w[i - 16] + (ror(a, 7) ^ ror(a, 18) ^ (a >>> 3)) + w[i - 7] + (ror(b, 17) ^ ror(b, 19) ^ (b >>> 10))) | 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const t1 = (hh + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + SHA_K[i] + w[i]) | 0;
        const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
      h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
    }
    return h.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
  }

  const wc = (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.getRandomValues) ? globalThis.crypto : require('crypto').webcrypto;
  function randHex(n) { const a = new Uint8Array(n); wc.getRandomValues(a); return Array.from(a, x => x.toString(16).padStart(2, '0')).join(''); }
  function randCode() { const n = new Uint32Array(1); wc.getRandomValues(n); return String(n[0] % 1000000).padStart(6, '0'); }

  /* ---------- Chain ---------- */
  const canon = o => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v)) ? Object.keys(v).sort().reduce((r, x) => (r[x] = v[x], r), {}) : v);
  const voteHash = v => sha(canon(v));
  function merkleRoot(leaves) {
    if (!leaves.length) return sha('');
    let lv = leaves.slice();
    while (lv.length > 1) { if (lv.length % 2) lv.push(lv[lv.length - 1]); const n = []; for (let i = 0; i < lv.length; i += 2) n.push(sha(lv[i] + lv[i + 1])); lv = n; }
    return lv[0];
  }
  function merkleProof(leaves, idx) {
    const proof = []; let lv = leaves.slice();
    while (lv.length > 1) {
      if (lv.length % 2) lv.push(lv[lv.length - 1]);
      const s = idx ^ 1; proof.push([lv[s], s < idx ? 'left' : 'right']);
      const n = []; for (let i = 0; i < lv.length; i += 2) n.push(sha(lv[i] + lv[i + 1])); lv = n; idx >>= 1;
    }
    return proof;
  }
  const verifyProof = (leaf, proof, root) => proof.reduce((h, [s, side]) => side === 'left' ? sha(s + h) : sha(h + s), leaf) === root;
  const blockRoot = b => merkleRoot(b.votes.map(voteHash));
  const blockHash = b => sha(canon({ i: b.index, prev: b.prev, t: b.time, root: blockRoot(b), n: b.nonce }));
  function mine(b) { b.nonce = 0; for (;;) { const h = blockHash(b); if (h.startsWith('0'.repeat(C.DIFFICULTY))) { b.hash = h; return; } b.nonce++; } }

  /* ---------- Identity checks ---------- */
  const normName = s => String(s).trim().toLowerCase().replace(/\s+/g, ' ');
  const normPhone = s => { const m = String(s).replace(/[\s-]/g, '').match(/^(?:\+?234|0)([789][01]\d{8})$/); return m ? m[1] : null; };
  const normNin = s => /^\d{11}$/.test(String(s).trim()) ? String(s).trim() : null;
  const normCard = s => /^[A-Za-z0-9]{19}$/.test(String(s).trim()) ? String(s).trim().toUpperCase() : null;
  const NAME_RE = /^[\p{L}][\p{L}'-]*(?: [\p{L}][\p{L}'-]*)+$/u;
  const validate = {
    name: v => NAME_RE.test(normName(v)) ? '' : 'Enter your first and last name using letters only.',
    phone: v => normPhone(v) ? '' : 'Enter a valid Nigerian mobile number (11 digits starting with 0, or +234 then 10 digits).',
    nin: v => normNin(v) ? '' : 'The NIN must be exactly 11 digits.',
    card: v => normCard(v) ? '' : 'The voter\'s card number must be exactly 19 letters and digits.'
  };
  function validateAll(d) {
    return !!d && typeof d === 'object' && ['name', 'phone', 'nin', 'card'].every(k => typeof d[k] === 'string' && d[k].length < 100 && !validate[k](d[k]));
  }
  const maskName = n => n.split(' ').map(w => w[0].toUpperCase() + '*'.repeat(Math.max(2, w.length - 1))).join(' ');
  const maskPhone = p => { const n = normPhone(p) || ''; return '0' + n.slice(0, 3) + ' *** ' + n.slice(-4); };

  /* ---------- Election state (plain JSON so it can be stored anywhere) ---------- */
  function newElection() {
    const S = { salt: randHex(16), voters: [], eligible: {}, used: {}, pending: [], chain: [] };
    const g = { index: 0, votes: [], prev: '0'.repeat(64), time: 0, nonce: 0, hash: '' }; mine(g); S.chain.push(g);
    return S;
  }
  const hid = (S, kind, val) => sha(S.salt + '|' + kind + '|' + val);
  function enroll(S, d) {
    if (!validateAll(d)) throw new Error('Some details are not in the correct format.');
    const name = normName(d.name), phone = normPhone(d.phone), nin = normNin(d.nin), card = normCard(d.card);
    const ninH = hid(S, 'nin', nin), cardH = hid(S, 'card', card);
    if (S.voters.some(v => v.ninH === ninH || v.cardH === cardH)) throw new Error('A voter with these details is already registered.');
    const voter = { label: maskName(name), nameH: hid(S, 'name', name), phoneH: hid(S, 'phone', phone), ninH, cardH,
      nullifier: sha(S.salt + '|vote|' + ninH + '|' + cardH), ballot: null, receipt: null };
    S.eligible[voter.nullifier] = true; S.voters.push(voter);
    return S.voters.length - 1;
  }
  function seedDemo(S) { C.DEMO.forEach(d => enroll(S, d)); return S; }
  function isState(p) {
    return !!p && typeof p.salt === 'string' && Array.isArray(p.voters) && Array.isArray(p.pending) && Array.isArray(p.chain) && p.chain.length > 0
      && p.eligible && typeof p.eligible === 'object' && p.used && typeof p.used === 'object';
  }
  function identityIndex(S, d) {
    if (!validateAll(d)) return -1;
    const idx = S.voters.findIndex(x => x.ninH === hid(S, 'nin', normNin(d.nin)));
    if (idx < 0) return -1;
    const v = S.voters[idx];
    return (v.cardH === hid(S, 'card', normCard(d.card)) && v.phoneH === hid(S, 'phone', normPhone(d.phone)) && v.nameH === hid(S, 'name', normName(d.name))) ? idx : -1;
  }

  /* ---------- Lockout and one-time code ---------- */
  const newGuard = () => ({ fails: 0, lockUntil: 0 });
  const lockSeconds = g => Math.max(0, Math.ceil((g.lockUntil - Date.now()) / 1000));
  function failAttempt(g) {
    g.fails++;
    if (g.fails >= C.MAX_FAILS) { g.fails = 0; g.lockUntil = Date.now() + C.LOCK_MS; return 'Too many failed attempts. Sign-in is locked for ' + (C.LOCK_MS / 1000) + ' seconds.'; }
    const left = C.MAX_FAILS - g.fails;
    return 'The details or the code did not match. Check them and try again. (' + left + ' attempt' + (left === 1 ? '' : 's') + ' left.)';
  }
  /* A code is always issued, so a wrong detail cannot be told apart from a right one until the end. */
  function makeChallenge(S, d, mode) {
    const code = randCode();
    return { mode, code, codeH: hid(S, 'otp', code), exp: Date.now() + C.OTP_MS, tries: 0, resends: 0,
      voterIdx: mode === 'signin' ? identityIndex(S, d) : -1, data: mode === 'register' ? d : null };
  }
  function resendChallenge(S, ch) { ch.code = randCode(); ch.codeH = hid(S, 'otp', ch.code); ch.exp = Date.now() + C.OTP_MS; ch.tries = 0; ch.resends++; }
  function verifyChallenge(S, ch, entered, g) {
    if (Date.now() > ch.exp) return { status: 'denied', title: 'Code expired', msg: 'The code was not used in time. Start again.' };
    ch.tries++;
    if (hid(S, 'otp', String(entered)) !== ch.codeH) {
      if (ch.tries < C.MAX_CODE_TRIES) { const left = C.MAX_CODE_TRIES - ch.tries; return { status: 'retry', msg: 'That code is not correct. ' + left + ' ' + (left === 1 ? 'try' : 'tries') + ' left.' }; }
      return ch.mode === 'signin' ? { status: 'denied', title: 'Sign-in failed', msg: failAttempt(g) } : { status: 'denied', title: 'Phone not verified', msg: 'Too many incorrect codes. Start again.' };
    }
    if (ch.mode === 'signin') {
      if (ch.voterIdx < 0) return { status: 'denied', title: 'Sign-in failed', msg: failAttempt(g) };
      g.fails = 0; return { status: 'ok', kind: 'signin', voterIdx: ch.voterIdx };
    }
    try { enroll(S, ch.data); return { status: 'ok', kind: 'registered' }; }
    catch (e) { return { status: 'denied', title: 'Could not register', msg: e.message }; }
  }

  /* ---------- Voting ---------- */
  function seal(S) {
    if (!S.pending.length) return;
    const b = { index: S.chain.length, votes: S.pending, prev: S.chain[S.chain.length - 1].hash, time: Date.now() / 1000, nonce: 0, hash: '' };
    mine(b); S.chain.push(b); S.pending = [];
    const leaves = b.votes.map(voteHash), root = merkleRoot(leaves);
    b.votes.forEach((v, i) => { const vt = S.voters.find(x => !x.removed && x.nullifier === v.nullifier); if (vt) vt.receipt = { block: b.index, leaf: leaves[i], proof: merkleProof(leaves, i), root }; });
  }
  function castVote(S, voterIdx, candidate) {
    const voter = S.voters[voterIdx];
    if (!voter || voter.removed) throw new Error('Not an eligible voter');
    if (!C.CANDIDATES.includes(candidate)) throw new Error('Unknown candidate');
    if (!S.eligible[voter.nullifier]) throw new Error('Not an eligible voter');
    if (S.used[voter.nullifier]) throw new Error('You have already voted. Double voting is rejected.');
    const v = { ballot_id: randHex(8), nullifier: voter.nullifier, candidate };
    S.used[voter.nullifier] = true; voter.ballot = v.ballot_id; S.pending.push(v);
    if (S.pending.length >= C.BATCH) seal(S);
    return { ballot: v.ballot_id, block: voter.receipt ? voter.receipt.block : null };
  }
  /* Admin: clear a registration so the person can register again. Not allowed once a ballot exists, so nobody can vote twice. The slot stays (marked removed) so other voters' positions never shift. */
  function resetVoter(S, i) {
    const v = S.voters[i];
    if (!v || v.removed) throw new Error('No such registration.');
    if (v.ballot) throw new Error('This voter has already voted, so the registration cannot be reset.');
    delete S.eligible[v.nullifier];
    v.removed = true; v.nameH = null; v.phoneH = null; v.ninH = null; v.cardH = null; v.receipt = null;
    return true;
  }
  function flip(S, b, j) {
    const blk = S.chain[b], v = blk && blk.votes[j]; if (!v) return false;
    v.candidate = C.CANDIDATES[(C.CANDIDATES.indexOf(v.candidate) + 1) % C.CANDIDATES.length]; return true;
  }
  function remine(S, b) { const blk = S.chain[b]; if (!blk) return false; mine(blk); return true; }

  function audit(S) {
    const seen = {}, blocks = []; let first = null;
    S.chain.forEach((b, i) => {
      let err = null;
      if (blockHash(b) !== b.hash) err = 'contents no longer match the stored hash';
      else if (!b.hash.startsWith('0'.repeat(C.DIFFICULTY))) err = 'proof of work is invalid';
      else if (i > 0 && b.prev !== S.chain[i - 1].hash) err = 'link to block ' + (i - 1) + ' is broken';
      else for (const v of b.votes) {
        if (!S.eligible[v.nullifier]) { err = 'contains a vote from an ineligible voter'; break; }
        if (seen[v.nullifier]) { err = 'contains a duplicate vote'; break; }
        if (!C.CANDIDATES.includes(v.candidate)) { err = 'contains an invalid candidate'; break; }
        seen[v.nullifier] = true;
      }
      blocks.push(err); if (err && !first) first = 'Block ' + i + ' ' + err + '.';
    });
    return { ok: !first, msg: first, blocks };
  }
  function checkReceipt(S, i) {
    const v = S.voters[i]; if (!v) return { ok: false, t: 'Unknown voter.' };
    const r = v.receipt; if (!r) return { ok: false, t: 'No receipt yet. Seal the block first.' };
    const b = S.chain[r.block], cur = b && b.votes.find(x => x.ballot_id === v.ballot);
    if (!cur) return { ok: false, t: 'Receipt failed: the ballot is missing from block ' + r.block + '.' };
    if (voteHash(cur) !== r.leaf || !verifyProof(r.leaf, r.proof, r.root) || blockRoot(b) !== r.root || blockHash(b) !== b.hash)
      return { ok: false, t: 'Receipt failed: the recorded vote no longer matches what was cast.' };
    return { ok: true, t: 'Receipt valid: the ballot is in block ' + r.block + ' exactly as cast.' };
  }

  /* What anyone may see: the ledger, masked voter names and who has voted. Never hashes of identities or the salt. */
  function publicView(S) {
    return {
      candidates: C.CANDIDATES,
      chain: S.chain,
      pending: S.pending.map(v => ({ candidate: v.candidate, nullifier: v.nullifier })),
      voters: S.voters.map(v => ({ label: v.label, status: v.removed ? 'removed' : !v.ballot ? 'none' : v.receipt ? 'sealed' : 'pending', block: v.receipt ? v.receipt.block : null })),
      audit: audit(S)
    };
  }

  return { C, sha, randHex, randCode, validate, validateAll, maskName, maskPhone, newElection, seedDemo, enroll, isState,
    newGuard, lockSeconds, failAttempt, makeChallenge, resendChallenge, verifyChallenge,
    seal, castVote, resetVoter, flip, remine, audit, checkReceipt, publicView, blockRoot, blockHash };
});
