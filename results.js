// ═══════════════════════════════════════════════════════════════════
// CLC SAT — Results recorder
// Every finished attempt (drills, College Board homework/review, related
// questions, fast track, math practice tests, full tests) is saved to
// Firestore:  results/{email}/attempts/{autoId}
// Only the signed-in student (and the host) can read it — see firestore rules.
// Guests / signed-out visitors record nothing.
// Include on any page of the stavros-tsal.github.io origin:
//   <script src=".../results.js"></script>   then   clcReport({...})
// ═══════════════════════════════════════════════════════════════════
(function () {
  var ADMIN_EMAIL = 'stavrostsalapatis@gmail.com';
  // NOTE: named FB_CFG (not CFG) on purpose — the quiz pages declare their own
  // global `CFG`, and captureMisses() below reads it by name.
  var FB_CFG = {
    apiKey: 'AIzaSyAkUxve_zohtR45XPKYmfAX8VGTk_ClR5g',
    authDomain: 'sat-greek-quiz-stavros.firebaseapp.com',
    projectId: 'sat-greek-quiz-stavros',
    storageBucket: 'sat-greek-quiz-stavros.firebasestorage.app',
    messagingSenderId: '227150541720',
    appId: '1:227150541720:web:d07a027044f5d7470ef1ed'
  };
  var SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
  var OUTBOX = 'clc_results_outbox_v1';
  var readyP = null;

  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = function () { rej(new Error('load ' + src)); };
      document.head.appendChild(s);
    });
  }

  // Resolves with { db, user } (user may be null).
  function ensure() {
    if (readyP) return readyP;
    readyP = (async function () {
      if (!window.firebase || !firebase.auth || !firebase.firestore) {
        if (!window.firebase) await loadScript(SDK + 'firebase-app-compat.js');
        if (!firebase.auth) await loadScript(SDK + 'firebase-auth-compat.js');
        if (!firebase.firestore) await loadScript(SDK + 'firebase-firestore-compat.js');
      }
      var app = firebase.apps.length ? firebase.app() : firebase.initializeApp(FB_CFG);
      var auth = firebase.auth(app), db = firebase.firestore(app);
      var user = await new Promise(function (res) {
        var done = false;
        var t = setTimeout(function () { if (!done) { done = true; res(auth.currentUser || null); } }, 7000);
        var off = auth.onAuthStateChanged(function (u) {
          if (done) return; done = true; clearTimeout(t); off(); res(u || null);
        });
      });
      return { db: db, user: user, auth: auth };
    })().catch(function (e) { readyP = null; throw e; });
    return readyP;
  }

  // ── derive subject / chapter / skill / kind from the page location ──
  function titleCase(s) { return String(s || '').replace(/-/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }

  function fromPath() {
    var p = decodeURIComponent(location.pathname);
    var m = p.match(/college-board\/(math|english)\/(sat|psat)\/(?:([^\/]+)\/)?(?:([^\/]+)\/)?([^\/]+)\.html$/i);
    if (!m) return null;
    var subject = m[1], level = m[2], file = m[5], out = { subject: subject, level: level };
    if (subject === 'math') {
      out.chapter = m[3] || '';
      var parts = file.split('_');
      if (parts.length >= 3) { out.skill = parts[1].toLowerCase(); out.kind = /^extra/i.test(parts[2]) ? 'Extra' : parts[2].replace(/-\d+$/, ''); }
      out.ref = file;
    } else {
      out.chapter = m[3] || '';
      if (/Related-Questions/i.test(file)) { out.kind = 'RelatedQuestions'; out.ref = file; }
      else {
        var q = file.split('_');
        if (q.length >= 3) { out.skill = q[1].toLowerCase(); out.kind = q[2].replace(/-\d+$/, ''); }
        out.ref = file;
      }
    }
    return out;
  }

  function fromFastTrack() {
    var m = location.pathname.match(/module(\d)_part(\d+)\.html$/i);
    return m ? { subject: 'math', chapter: 'Fast Track', skill: 'Module ' + m[1], kind: 'FastTrack', ref: 'module' + m[1] + '_part' + m[2], part: +m[2] } : null;
  }

  // ── per-question capture (error log) ──
  // Quiz pages call clcReport({src:'cb', correct, total}) from inside their own
  // finish() handler, so their top-level state is still in scope. Instead of
  // editing 130+ generated pages, read it from here:
  //   Math pages    : CFG.qs[i] = {n, key, …},  picks[i] = chosen letter
  //   English pages : DATA.questions[i] = {id, answer, …}, state.answers[id]
  // Adds: page (site-relative path), right[] / wrong[] (question ids as
  // strings; unanswered counts as wrong), retry (true when the page was opened
  // with ?retry=… and only a subset of questions was shown).
  // Never throws; if nothing is detected the record is left untouched.
  function captureMisses(rec) {
    try {
      if (rec.src !== 'cb' || rec.wrong || rec.right) return;
      var right = [], wrong = [];
      if (typeof CFG !== 'undefined' && typeof D !== 'undefined' && typeof picks !== 'undefined' && Array.isArray(D)) {
        D.forEach(function (d, i) { (picks[i] && picks[i] === d.key ? right : wrong).push(String(d.n)); });
      } else if (typeof DATA !== 'undefined' && typeof state !== 'undefined' && DATA.questions) {
        DATA.questions.forEach(function (q) { (state.answers && state.answers[q.id] === q.answer ? right : wrong).push(String(q.id)); });
      } else return;
      rec.right = right; rec.wrong = wrong;
      var m = decodeURIComponent(location.pathname).match(/(college-board\/.+\.html)$/i);
      if (m) rec.page = m[1];
      if (/[?&]retry=/.test(location.search)) rec.retry = true;
    } catch (e) { /* ignore */ }
  }

  function normalize(rec) {
    var r = {};
    var base = (rec.src === 'fasttrack' ? fromFastTrack() : (rec.src === 'cb' || rec.src === 'rq') ? fromPath() : null) || {};
    Object.keys(base).forEach(function (k) { r[k] = base[k]; });
    Object.keys(rec).forEach(function (k) { if (rec[k] !== undefined && rec[k] !== null) r[k] = rec[k]; });
    r.src = rec.src;
    r.subject = r.subject || 'math';
    r.correct = Math.max(0, +r.correct || 0);
    r.total = Math.max(0, +r.total || 0);
    r.pct = r.total ? Math.round(1000 * r.correct / r.total) / 10 : 0;
    if (r.skill) r.skill = String(r.skill).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return r;
  }

  function outboxGet() { try { return JSON.parse(localStorage.getItem(OUTBOX) || '[]'); } catch (e) { return []; } }
  function outboxSet(a) { try { localStorage.setItem(OUTBOX, JSON.stringify(a.slice(-300))); } catch (e) {} }

  async function write(ctx, rec) {
    var email = (ctx.user.email || '').trim().toLowerCase();
    var doc = Object.assign({}, rec, {
      email: email, name: ctx.user.displayName || '',
      ts: firebase.firestore.FieldValue.serverTimestamp()
    });
    if (rec.clientTs) doc.clientTs = rec.clientTs;
    await ctx.db.collection('results').doc(email).collection('attempts').add(doc);
  }

  async function flush(ctx) {
    var box = outboxGet(); if (!box.length) return;
    var email = (ctx.user.email || '').trim().toLowerCase();
    var keep = [];
    for (var i = 0; i < box.length; i++) {
      if (box[i]._email && box[i]._email !== email) { keep.push(box[i]); continue; }
      try { var r = Object.assign({}, box[i]); delete r._email; await write(ctx, r); } catch (e) { keep.push(box[i]); }
    }
    outboxSet(keep);
  }

  window.clcReport = async function (rec) {
    try {
      captureMisses(rec);
      var r = normalize(rec);
      if (!r.total) return;
      r.clientTs = new Date().toISOString();
      var ctx = await ensure();
      if (!ctx.user) return; // guests are not recorded
      try { await flush(ctx); await write(ctx, r); }
      catch (e) { var b = outboxGet(); r._email = (ctx.user.email || '').toLowerCase(); b.push(r); outboxSet(b); }
    } catch (e) { console.warn('clcReport', e); }
  };

  // ── one-time import of what the browser already remembers ──
  var EN_CHAPTERS = {};
  function legacyFromSlug(slug) {
    var m = slug.match(/^(.*)-(Homework|Review)-(\d+)$/);
    if (!m) return null;
    var rest = m[1], level = 'sat', subject = 'math', chapter = '';
    if (/^PSAT-/.test(rest)) { level = 'psat'; rest = rest.slice(5); }
    if (/^SAT-English-/.test(rest)) { subject = 'english'; rest = rest.slice(12); }
    else {
      var chs = ['Algebra', 'Advanced-Math', 'PSDA', 'Geometry-and-Trigonometry'];
      for (var i = 0; i < chs.length; i++) { if (rest.indexOf(chs[i] + '-') === 0) { chapter = chs[i]; rest = rest.slice(chs[i].length + 1); break; } }
      if (!chapter) return null;
    }
    return { src: 'cb', subject: subject, level: level, chapter: chapter, skill: rest.toLowerCase(), kind: m[2], total: +m[3], ref: slug, legacy: true };
  }

  window.clcMigrateOnce = async function () {
    try {
      var ctx = await ensure(); if (!ctx.user) return;
      var email = (ctx.user.email || '').trim().toLowerCase();
      var flagRef = ctx.db.collection('results').doc(email);
      var snap = await flagRef.get();
      if (snap.exists && snap.data().migrated) return;
      var items = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf('clc-') === 0) {
          var base = legacyFromSlug(k.slice(4));
          if (!base) continue;
          var arr; try { arr = JSON.parse(localStorage.getItem(k) || '[]'); } catch (e) { arr = []; }
          if (!Array.isArray(arr)) continue;
          arr.forEach(function (h) {
            var r = normalize(Object.assign({}, base, { correct: h.c })); r.clientTs = h.d || null; items.push(r);
          });
        }
      }
      try {
        var P = JSON.parse(localStorage.getItem('clc_progress_v1') || 'null');
        if (P) {
          var tabs = ['Algebra', 'Interpretation', 'Probabilities & Statistics', 'Geometry'];
          Object.keys(P.drillStats || {}).forEach(function (t) {
            var s = P.drillStats[t]; if (s && s.total) items.push(normalize({ src: 'drill', subject: 'math', chapter: tabs[+t] || ('Tab ' + t), kind: 'Drill', correct: s.correct, total: s.total, legacy: true }));
          });
          Object.keys(P.mathTests || {}).forEach(function (id) {
            (P.mathTests[id] || []).forEach(function (a) { items.push(normalize({ src: 'mathtest', subject: 'math', chapter: 'Math Practice Test', skill: 'test ' + id, kind: 'MathTest', ref: 'math-test-' + id, correct: a.score, total: 800, score: a.score, clientTs: a.date, legacy: true })); });
          });
          Object.keys(P.fullTests || {}).forEach(function (id) {
            (P.fullTests[id] || []).forEach(function (a) { items.push(normalize({ src: 'full', subject: 'both', chapter: 'Full Practice Test', skill: 'test ' + id, kind: 'FullTest', ref: 'full-test-' + id, correct: a.correctCount, total: a.totalCount, score: a.scaledScore, clientTs: a.date, legacy: true })); });
          });
          Object.keys(P.specificPractice || {}).forEach(function (bank) {
            (P.specificPractice[bank] || []).forEach(function (a) { items.push(normalize({ src: 'specific', subject: 'math', chapter: bank, kind: 'Specific', correct: a.correctCount, total: a.totalCount, clientTs: a.date, legacy: true })); });
          });
        }
      } catch (e) {}
      for (var j = 0; j < items.length; j += 400) {
        var batch = ctx.db.batch();
        items.slice(j, j + 400).forEach(function (r) {
          var d = Object.assign({}, r, { email: email, name: ctx.user.displayName || '', ts: firebase.firestore.FieldValue.serverTimestamp() });
          batch.set(flagRef.collection('attempts').doc(), d);
        });
        await batch.commit();
      }
      await flagRef.set({ migrated: true, migratedAt: firebase.firestore.FieldValue.serverTimestamp(), count: items.length, email: email }, { merge: true });
    } catch (e) { console.warn('clcMigrateOnce', e); }
  };

  window.clcResultsEnsure = ensure;
  window.CLC_ADMIN_EMAIL = ADMIN_EMAIL;
})();
