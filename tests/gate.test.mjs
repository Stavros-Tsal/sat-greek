// Run: node --test tests/
// Exercises the Pages Functions with a fake Firebase (JWKS + Firestore) and a fake ASSETS binding.
import test from 'node:test';
import assert from 'node:assert/strict';
import { signSession, verifySession, b64u, COOKIE } from '../functions/_lib/session.js';
import { verifyIdToken, isAllowedStudent, resetJwksCache } from '../functions/_lib/firebase.js';
import { onRequestPost as sessionPost } from '../functions/api/session.js';
import { onRequestPost as logoutPost } from '../functions/api/logout.js';
import { onRequest as middleware } from '../functions/_middleware.js';
import { resetGuestCache } from '../functions/_lib/guest.js';

const enc = new TextEncoder();
const PROJECT = 'sat-greek-quiz-stavros';
const SECRET = 'x'.repeat(48);
const ENV = { SESSION_SECRET: SECRET, FIREBASE_PROJECT_ID: PROJECT, ADMIN_EMAIL: 'admin@example.com' };

// ---------- fake Firebase ----------
async function newKey(kid) {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { kid, priv: pair.privateKey, jwk: Object.assign(jwk, { kid, alg: 'RS256', use: 'sig' }) };
}
async function makeToken(key, overrides = {}, header = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims = Object.assign({
    iss: 'https://securetoken.google.com/' + PROJECT, aud: PROJECT, sub: 'uid1', iat: now - 5, exp: now + 3000,
    email: 'student@example.com', email_verified: true, firebase: { sign_in_provider: 'google.com' },
  }, overrides);
  for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];
  const h = b64u.enc(enc.encode(JSON.stringify(Object.assign({ alg: 'RS256', kid: key.kid, typ: 'JWT' }, header))));
  const p = b64u.enc(enc.encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.priv, enc.encode(h + '.' + p));
  return h + '.' + p + '.' + b64u.enc(sig);
}

let KEY, OTHER, calls, students, firestoreStatus;
function installFetch() {
  calls = { jwks: 0, firestore: [] };
  globalThis.fetch = async function (url, init) {
    url = String(url);
    if (url.includes('securetoken@system.gserviceaccount.com')) {
      calls.jwks++;
      return new Response(JSON.stringify({ keys: [KEY.jwk] }), { status: 200, headers: { 'Cache-Control': 'public, max-age=600' } });
    }
    if (url.includes('firestore.googleapis.com') && url.endsWith(':runQuery')) {
      const body = JSON.parse(init.body);
      calls.firestore.push({ auth: init.headers.Authorization, body });
      if (firestoreStatus !== 200) return new Response('{}', { status: firestoreStatus });
      const email = body.structuredQuery.where.fieldFilter.value.stringValue;
      return new Response(JSON.stringify(students.has(email) ? [{ document: { name: 'x' }, readTime: 't' }] : [{ readTime: 't' }]), { status: 200 });
    }
    throw new Error('unexpected fetch ' + url);
  };
}
const realFetch = globalThis.fetch;
test.before(async () => { KEY = await newKey('k1'); OTHER = await newKey('k1'); });
test.beforeEach(() => { resetJwksCache(); resetGuestCache(); students = new Set(['student@example.com']); firestoreStatus = 200; installFetch(); });
test.after(() => { globalThis.fetch = realFetch; });

// ---------- session cookie ----------
test('session cookie: round trip, expiry, tampering, wrong secret', async () => {
  const t = await signSession(SECRET, 'a@b.c', 60);
  assert.deepEqual((await verifySession(SECRET, t)).email, 'a@b.c');
  assert.equal(await verifySession('y'.repeat(48), t), null);
  assert.equal(await verifySession(SECRET, t, Date.now() + 61000), null);
  const [v, p, s] = t.split('.');
  const forged = b64u.enc(enc.encode(JSON.stringify({ e: 'evil@x.y', x: Math.floor(Date.now() / 1000) + 9999 })));
  assert.equal(await verifySession(SECRET, [v, forged, s].join('.')), null);
  assert.equal(await verifySession(SECRET, 'garbage'), null);
  assert.equal(await verifySession(SECRET, ''), null);
  assert.equal(await verifySession('', t), null);
});

// ---------- ID token verification ----------
test('verifyIdToken accepts a valid Google token and lower-cases the email', async () => {
  const r = await verifyIdToken(await makeToken(KEY, { email: 'Student@Example.com' }), ENV);
  assert.equal(r.email, 'student@example.com');
});
test('verifyIdToken rejects bad tokens', async () => {
  const bad = {
    'wrong audience': await makeToken(KEY, { aud: 'other' }),
    'wrong issuer': await makeToken(KEY, { iss: 'https://securetoken.google.com/other' }),
    'expired': await makeToken(KEY, { exp: Math.floor(Date.now() / 1000) - 10 }),
    'issued in the future': await makeToken(KEY, { iat: Math.floor(Date.now() / 1000) + 3600 }),
    'unverified email': await makeToken(KEY, { email_verified: false }),
    'no email': await makeToken(KEY, { email: undefined }),
    'password provider': await makeToken(KEY, { firebase: { sign_in_provider: 'password' } }),
    'no firebase claim': await makeToken(KEY, { firebase: undefined }),
    'signed by another key': await makeToken(OTHER),
    'alg none': await makeToken(KEY, {}, { alg: 'none' }),
    'alg HS256': await makeToken(KEY, {}, { alg: 'HS256' }),
    'unknown kid': await makeToken(Object.assign({}, KEY, { kid: 'nope' })),
    'not a jwt': 'abc.def',
  };
  for (const [name, tok] of Object.entries(bad)) {
    resetJwksCache();
    await assert.rejects(() => verifyIdToken(tok, ENV), undefined, name + ' should be rejected');
  }
  await assert.rejects(() => verifyIdToken(undefined, ENV));
  await assert.rejects(() => verifyIdToken('a'.repeat(9000), ENV));
});
test('verifyIdToken caches the JWKS', async () => {
  await verifyIdToken(await makeToken(KEY), ENV);
  await verifyIdToken(await makeToken(KEY), ENV);
  assert.equal(calls.jwks, 1);
});

// ---------- students check ----------
test('isAllowedStudent: admin needs no lookup; students are looked up with the user token', async () => {
  assert.equal(await isAllowedStudent('admin@example.com', 'tok', ENV), true);
  assert.equal(calls.firestore.length, 0);
  assert.equal(await isAllowedStudent('student@example.com', 'TOKEN123', ENV), true);
  assert.equal(calls.firestore[0].auth, 'Bearer TOKEN123');
  assert.equal(calls.firestore[0].body.structuredQuery.from[0].collectionId, 'students');
  assert.equal(await isAllowedStudent('stranger@example.com', 'TOKEN123', ENV), false);
  firestoreStatus = 403;
  await assert.rejects(() => isAllowedStudent('student@example.com', 'T', ENV));
});

// ---------- /api/session ----------
function sessionReq(body, headers) {
  return new Request('https://site.test/api/session', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: typeof body === 'string' ? body : JSON.stringify(body) });
}
test('/api/session: student gets a hardened cookie', async () => {
  const res = await sessionPost({ request: sessionReq({ idToken: await makeToken(KEY) }), env: ENV });
  assert.equal(res.status, 200);
  const c = res.headers.get('Set-Cookie');
  assert.match(c, new RegExp('^' + COOKIE + '=v1\\.'));
  for (const f of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=43200']) assert.ok(c.includes(f), f);
  const val = c.split(';')[0].split('=').slice(1).join('=');
  assert.equal((await verifySession(SECRET, val)).email, 'student@example.com');
});
test('/api/session: admin is accepted without a students entry', async () => {
  const res = await sessionPost({ request: sessionReq({ idToken: await makeToken(KEY, { email: 'admin@example.com' }) }), env: ENV });
  assert.equal(res.status, 200);
  assert.equal(calls.firestore.length, 0);
});
test('/api/session: refuses non-students, bad tokens, bad origin, missing config', async () => {
  let res = await sessionPost({ request: sessionReq({ idToken: await makeToken(KEY, { email: 'stranger@example.com' }) }), env: ENV });
  assert.equal(res.status, 403);
  assert.match(res.headers.get('Set-Cookie'), /Max-Age=0/);
  res = await sessionPost({ request: sessionReq({ idToken: 'nope' }), env: ENV });
  assert.equal(res.status, 401);
  res = await sessionPost({ request: sessionReq('not json'), env: ENV });
  assert.equal(res.status, 400);
  res = await sessionPost({ request: sessionReq({ idToken: await makeToken(KEY) }, { Origin: 'https://evil.test' }), env: ENV });
  assert.equal(res.status, 403);
  res = await sessionPost({ request: sessionReq({ idToken: await makeToken(KEY) }), env: Object.assign({}, ENV, { SESSION_SECRET: 'short' }) });
  assert.equal(res.status, 500);
  firestoreStatus = 500;
  res = await sessionPost({ request: sessionReq({ idToken: await makeToken(KEY) }), env: ENV });
  assert.equal(res.status, 502);
  assert.equal(res.headers.get('Set-Cookie'), null);
});
test('/api/logout clears the cookie', async () => {
  const res = await logoutPost({ request: new Request('https://site.test/api/logout', { method: 'POST' }) });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Set-Cookie'), /Max-Age=0/);
});

// ---------- middleware ----------
const FILES = {
  '/_public/shell.html': 'SHELL',
  '/_private/app.html': 'FULLAPP',
  '/module1_part1': 'MODULE1',                       // Pages serves foo.html at /foo
  '/college-board/math/Algebra_Homework-30': 'FREE SAMPLE',
  '/college-board/math/Algebra_Review-15': 'MEMBER SAMPLE',
  '/college-board/img-zoom.js': 'JS',
  '/assets/greek-flag.png': 'PNG',
  '/progress': 'PROGRESS',
  '/_public/guest-paths.json': JSON.stringify(['/college-board/math/Algebra_Homework-30.html', '/college-board/img-zoom.js', '/assets/greek-flag.png']),
};
function makeEnv(files) {
  files = files || FILES;
  return Object.assign({}, ENV, {
    ASSETS: {
      async fetch(req) {
        const u = new URL(req.url);
        let p = u.pathname;
        if (p.endsWith('.html') && files[p.slice(0, -5)] !== undefined) return new Response(null, { status: 308, headers: { Location: p.slice(0, -5) } });
        if (files[p] === undefined) return new Response('nf', { status: 404 });
        return new Response(files[p], { status: 200, headers: { 'Cache-Control': 'public, max-age=0, must-revalidate' } });
      },
    },
  });
}
async function cookieFor(email, ttl) { return COOKIE + '=' + await signSession(SECRET, email || 'student@example.com', ttl || 600); }
async function hit(path, opts) {
  opts = opts || {};
  const headers = Object.assign({}, opts.html === false ? {} : { Accept: 'text/html' }, opts.cookie ? { Cookie: opts.cookie } : {});
  const res = await middleware({ request: new Request('https://site.test' + path, { method: opts.method || 'GET', headers }), env: opts.env || makeEnv(), next: async () => new Response('API', { status: 200 }) });
  return res;
}
const body = async function (r) { return r.text(); };

test('middleware: "/" is the shell for visitors and the full app for members', async () => {
  let r = await hit('/');
  assert.equal(await body(r), 'SHELL');
  assert.match(r.headers.get('Cache-Control'), /no-store/);
  r = await hit('/index.html');
  assert.equal(await body(r), 'SHELL');
  const c = await cookieFor();
  assert.equal(await body(await hit('/', { cookie: c })), 'FULLAPP');
  assert.equal(await body(await hit('/index.html', { cookie: c })), 'FULLAPP');
});
test('middleware: gated files redirect pages / 401 others without a cookie', async () => {
  let r = await hit('/module1_part1.html');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('Location'), '/');
  r = await hit('/module1_part1.html', { html: false });
  assert.equal(r.status, 401);
  r = await hit('/college-board/math/Algebra_Review-15.html');
  assert.equal(r.status, 302);
  r = await hit('/_private/app.html');
  assert.equal(r.status, 302);
});
test('middleware: members get the file at its .html URL (no redirect), private cache headers', async () => {
  const r = await hit('/module1_part1.html', { cookie: await cookieFor() });
  assert.equal(r.status, 200);
  assert.equal(await body(r), 'MODULE1');
  assert.match(r.headers.get('Cache-Control'), /^private/);
  assert.equal(r.headers.get('X-Content-Type-Options'), 'nosniff');
});
test('middleware: expired or forged cookies do not count', async () => {
  assert.equal((await hit('/module1_part1.html', { cookie: await cookieFor('a@b.c', -10) })).status, 302);
  assert.equal((await hit('/module1_part1.html', { cookie: COOKIE + '=v1.abc.def' })).status, 302);
  const other = COOKIE + '=' + await signSession('z'.repeat(48), 'a@b.c', 600);
  assert.equal((await hit('/module1_part1.html', { cookie: other })).status, 302);
});
test('middleware: guest samples and shared assets are public, member material is not', async () => {
  assert.equal((await hit('/college-board/math/Algebra_Homework-30.html')).status, 200);
  assert.equal((await hit('/college-board/img-zoom.js', { html: false })).status, 200);
  assert.equal((await hit('/assets/greek-flag.png', { html: false })).status, 200);
  assert.equal((await hit('/progress.html')).status, 200);
});
test('middleware: fails closed when the guest list is unreadable', async () => {
  const files = Object.assign({}, FILES); delete files['/_public/guest-paths.json'];
  assert.equal((await hit('/college-board/math/Algebra_Homework-30.html', { env: makeEnv(files) })).status, 302);
  assert.equal((await hit('/assets/greek-flag.png', { env: makeEnv(files), html: false })).status, 200); // prefix-public, unaffected
});
test('middleware: path tricks never reach gated files', async () => {
  for (const p of ['/assets/../module1_part1.html', '//module1_part1.html', '/assets/%2e%2e/module1_part1.html', '/%2e%2e/module1_part1.html', '/assets%2f..%2fmodule1_part1.html', '/Assets/greek-flag.png', '/module1_part1.html/', '/%5cmodule1_part1.html']) {
    const r = await hit(p);
    assert.ok(r.status !== 200 || (await body(r)) !== 'MODULE1', p + ' leaked');
  }
});
test('middleware: methods and API', async () => {
  assert.equal((await hit('/module1_part1.html', { method: 'POST' })).status, 405);
  assert.equal((await hit('/', { method: 'PUT' })).status, 405);
  assert.equal((await hit('/api/session', { method: 'POST' })).status, 200);   // delegated to its handler
  assert.equal((await hit('/api/other')).status, 404);
  assert.equal((await hit('/module1_part1.html', { method: 'HEAD', cookie: await cookieFor() })).status, 200);
});
