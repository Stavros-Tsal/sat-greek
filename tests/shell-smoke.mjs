// Smoke test for the built shell/app variants.
//   node scripts/build_gated.mjs . dist
//   npm i --no-save jsdom        (not a project dependency; only needed for this check)
//   node tests/shell-smoke.mjs dist
// Loads dist/_public/shell.html and dist/_private/app.html in jsdom with a fake Firebase and a fake fetch.
import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const DIST = process.argv[2] || 'dist';

function fakeFirebase(user) {
  const auth = {
    onAuthStateChanged(cb) { setTimeout(function () { cb(user); }, 0); return function () {}; },
    getRedirectResult() { return Promise.resolve(); },
    signOut() { return Promise.resolve(); },
    currentUser: user,
  };
  const snap = { empty: false, docs: [{ data: function () { return { group: '1' }; } }] };
  const db = { collection() { return { where() { return { limit() { return { get() { return Promise.resolve(snap); } }; } }; } }; } };
  const fb = { initializeApp() {}, apps: [], auth: function () { return auth; }, firestore: function () { return db; } };
  fb.auth.GoogleAuthProvider = function () { this.setCustomParameters = function () {}; };
  return fb;
}

async function load(file, scenario, check) {
  const errors = [], reloads = [], fetches = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', function (e) { if (/navigation/i.test(e.message)) reloads.push(1); else errors.push(e.message); });
  const user = scenario === 'guest' ? null : { email: 'student@example.com', getIdToken: function () { return Promise.resolve('FAKE'); } };
  const dom = new JSDOM(fs.readFileSync(file, 'utf8'), {
    url: 'https://site.test/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.firebase = fakeFirebase(user);
      w.scrollTo = function () {};
      w.fetch = function (url) {
        fetches.push(String(url));
        const status = /api\/session$/.test(url) ? (scenario === 'denied' ? 403 : scenario === 'noserver' ? 404 : 200) : 200;
        return Promise.resolve({ ok: status === 200, status: status });
      };
    },
  });
  await new Promise(function (r) { setTimeout(r, 1500); });
  try { await check({ w: dom.window, errors, reloads, fetches }); }
  finally { dom.window.close(); }      // stop the page's timers so the next load is not slowed down
}

const shell = DIST + '/_public/shell.html', app = DIST + '/_private/app.html';
// MathJax is not loaded in jsdom; that one error also happens on the unmodified page.
const real = (errs) => errs.filter(function (e) { return !/MathJax/.test(e); });

await load(shell, 'guest', function (r) {
  assert.deepEqual(real(r.errors), [], 'shell loads cleanly');
  r.w.enterAsGuest(); r.w.goScreen('screen-subject'); r.w.goScreen('screen-mode', 'Math');
  assert.equal(r.w.document.querySelector('.screen.active').id, 'screen-subject', 'guest cannot reach member screens');
  assert.equal(r.w.document.querySelectorAll('.member-only').length, 0, 'no member-only markup in shell');
  // `const` declarations are not window properties, so read them from inside the page's global scope.
  assert.equal(r.w.eval('ANSWERS.reduce(function (a, o) { return a + Object.keys(o).length; }, 0)'), 0, 'no answers in shell');
  assert.equal(r.w.eval('QUESTIONS.reduce(function (a, t) { return a + t.length; }, 0)'), 0, 'no questions in shell');
});

await load(shell, 'member', function (r) {
  assert.deepEqual(real(r.errors), []);
  assert.ok(r.fetches.includes('api/session'), 'shell asks the server for a session');
  assert.equal(r.reloads.length, 1, 'shell reloads once the session is set');
});

await load(shell, 'denied', function (r) {
  assert.equal(r.reloads.length, 0);
  assert.match(r.w.document.getElementById('auth-error').textContent, /δεν έχει πρόσβαση/);
});

await load(shell, 'noserver', function (r) {
  assert.equal(r.reloads.length, 0);
  assert.match(r.w.document.getElementById('auth-error').textContent, /Προσωρινό πρόβλημα/);
});

await load(app, 'member', function (r) {
  assert.deepEqual(real(r.errors), []);
  assert.ok(r.fetches.includes('api/session'));
  assert.equal(r.reloads.length, 0, 'the full app does not reload');
});

console.log('shell/app smoke test: OK');
process.exit(0);
