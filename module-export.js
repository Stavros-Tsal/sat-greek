// ═══════════════════════════════════════════════════════════════════
// CLC SAT — Module report export
// Shared by module1_part*.html / module2_part*.html.
//  • after "Check answers": shows an "Export report (PDF)" button
//  • the report (results + mistakes with worked solutions) is a print
//    layout → the browser's "Save as PDF"
//  • worked solutions live in solutions/<page>.js (loaded lazily) and are
//    also shown under each question as a "Show solution" toggle
// Reads the page's own globals: Q, given, checked, ok(), sectionName(),
// weight(), render(), doCheck(), chosenMinutes, timeLeft.
// ═══════════════════════════════════════════════════════════════════
(function () {
  var page = (location.pathname.match(/(module\d_part\d+)\.html$/i) || [])[1];
  if (!page || typeof Q === 'undefined') return;

  var timeUsed = null;
  var solLoading = null;

  // ── styles (screen: toggle + button; print: report layout) ──
  var css = document.createElement('style');
  css.textContent = [
    '#exp{background:#fff;color:var(--blue,#1d4ed8);border:1px solid var(--blue,#1d4ed8)}',
    '.sol{margin-top:10px;font:15px/1.55 system-ui,sans-serif;border-top:1px dashed var(--line,#d6dde9);padding-top:8px}',
    '.sol summary{cursor:pointer;font-weight:700;color:var(--blue,#1d4ed8)}',
    '.sol .st{margin:6px 0 0}',
    '.sol .st.fin{font-weight:700;color:var(--navy,#0f2a5c)}',
    '#clc-report{display:none}',
    '@media print{',
    '  @page{margin:14mm}',
    '  body.clc-printing{background:#fff!important}',
    '  body.clc-printing>*:not(#clc-report){display:none!important}',
    '  body.clc-printing #clc-report{display:block!important;font:13px/1.5 system-ui,sans-serif;color:#111;padding:0}',
    '  #clc-report h1{font-size:22px;margin:0 0 2px}',
    '  #clc-report h2{font-size:16px;margin:22px 0 8px;padding-bottom:4px;border-bottom:2px solid #0f2a5c;color:#0f2a5c}',
    '  #clc-report .meta{color:#444;margin:0 0 10px}',
    '  #clc-report .big{font-size:18px;font-weight:700;margin:8px 0}',
    '  #clc-report table{border-collapse:collapse;width:100%;margin:6px 0 4px}',
    '  #clc-report th,#clc-report td{border:1px solid #bbb;padding:3px 8px;text-align:left;font-size:12px}',
    '  #clc-report th{background:#eef2fa}',
    '  #clc-report td.ok{color:#0a7a3d;font-weight:700}#clc-report td.bad{color:#b42318;font-weight:700}',
    '  #clc-report .mq{border:1px solid #bbb;border-left:5px solid #b42318;border-radius:6px;padding:8px 12px;margin:0 0 12px;break-inside:avoid;page-break-inside:avoid}',
    '  #clc-report .mq .n{font-weight:700;color:#0f2a5c;margin-bottom:3px}',
    '  #clc-report .mq .txt{margin:0 0 6px}',
    '  #clc-report .mo{margin:2px 0;padding:2px 6px;border-radius:4px}',
    '  #clc-report .mo.key{background:#e5f6ec;border:1px solid #0a7a3d}',
    '  #clc-report .mo.mine{background:#fdeceb;border:1px solid #b42318}',
    '  #clc-report .ans{margin:6px 0 2px}',
    '  #clc-report .solbox{margin-top:6px;padding:6px 10px;background:#f6f8fc;border-radius:6px}',
    '  #clc-report .solbox .st{margin:3px 0}',
    '  #clc-report .solbox .st.fin{font-weight:700}',
    '  #clc-report .foot{margin-top:18px;color:#666;font-size:11px}',
    '}'
  ].join('\n');
  document.head.appendChild(css);

  // ── helpers ──
  function esc(x) { return String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
  function typeset(el) {
    try { if (window.MathJax && MathJax.typesetPromise) return MathJax.typesetPromise(el ? [el] : undefined); } catch (e) {}
    return Promise.resolve();
  }
  function loadSolutions() {
    if (window.CLC_SOL && window.CLC_SOL[page]) return Promise.resolve(window.CLC_SOL[page]);
    if (solLoading) return solLoading;
    solLoading = new Promise(function (res) {
      var s = document.createElement('script');
      s.src = 'solutions/' + page + '.js';
      s.onload = function () { res((window.CLC_SOL || {})[page] || null); };
      s.onerror = function () { res(null); };
      document.head.appendChild(s);
    });
    return solLoading;
  }
  function solHtml(i) {
    var sol = window.CLC_SOL && window.CLC_SOL[page] && window.CLC_SOL[page][i];
    if (!sol || !sol.length) return '';
    return sol.map(function (line, k) {
      return '<div class="st' + (k === sol.length - 1 ? ' fin' : '') + '">' + line + '</div>';
    }).join('');
  }
  function givenText(q, g) {
    if (g === undefined || g === '') return '— (no answer)';
    if (q.open) return esc(g);
    var k = 'ABCD'.indexOf(g);
    return g + (k > -1 && q.opts[k] ? ') ' + q.opts[k] : '');
  }
  function correctText(q) {
    if (q.open) return esc(q.ans);
    var k = 'ABCD'.indexOf(q.ans);
    return q.ans + (k > -1 && q.opts[k] ? ') ' + q.opts[k] : '');
  }
  function studentName() {
    try {
      if (window.firebase && firebase.apps && firebase.apps.length) {
        var u = firebase.auth().currentUser;
        if (u) return u.displayName || u.email || '';
      }
    } catch (e) {}
    return '';
  }

  // ── in-page "Show solution" toggles ──
  function decorate() {
    if (typeof checked === 'undefined' || !checked) return;
    if (!(window.CLC_SOL && window.CLC_SOL[page])) return;
    var cards = document.querySelectorAll('#m .q');
    cards.forEach(function (d, i) {
      if (d.querySelector('.sol')) return;
      var h = solHtml(i);
      if (!h) return;
      var det = document.createElement('details');
      det.className = 'sol';
      det.innerHTML = '<summary>Show solution</summary>' + h;
      d.appendChild(det);
    });
    typeset();
  }

  // wrap render() so toggles survive re-renders
  var origRender = window.render;
  if (typeof origRender === 'function') {
    window.render = function () { origRender.apply(this, arguments); decorate(); };
  }

  // wrap doCheck() so manual check and timer expiry both reveal the export
  var chk = document.getElementById('chk'), rst = document.getElementById('rst'), bar = document.getElementById('bar');
  var expBtn = document.createElement('button');
  expBtn.id = 'exp'; expBtn.className = 'alt'; expBtn.type = 'button';
  expBtn.textContent = 'Export report (PDF)';
  expBtn.style.display = 'none';
  if (bar) bar.insertBefore(expBtn, document.getElementById('score'));

  var origCheck = window.doCheck;
  if (typeof origCheck === 'function') {
    window.doCheck = function () {
      var was = checked;
      origCheck.apply(this, arguments);
      if (!was && checked) {
        try { timeUsed = Math.max(0, chosenMinutes * 60 - timeLeft); } catch (e) { timeUsed = null; }
        expBtn.style.display = '';
        loadSolutions().then(function () { try { render(); } catch (e) {} });
      }
    };
    if (chk) chk.onclick = window.doCheck;
  }
  if (rst) rst.addEventListener('click', function () { expBtn.style.display = 'none'; timeUsed = null; });

  // ── report ──
  function buildReport() {
    var title = (document.querySelector('header h1') || {}).textContent || page;
    var sub = (document.querySelector('header p') || {}).textContent || '';
    var n = Q.length, correct = 0, wrong = [];
    var secs = [], secIdx = {};
    var rows = '';
    Q.forEach(function (q, i) {
      var r = ok(q, given[i]);
      var sn = sectionName(i);
      if (!(sn in secIdx)) { secIdx[sn] = secs.length; secs.push({ name: sn, c: 0, t: 0 }); }
      secs[secIdx[sn]].t++;
      if (r) { correct++; secs[secIdx[sn]].c++; } else wrong.push(i);
      var g = given[i];
      var mine = (g === undefined || g === '') ? '—' : (q.open ? esc(g) : esc(g));
      rows += '<tr><td>' + (i + 1) + '</td><td>' + esc(sn) + '</td><td>' + mine + '</td><td>' + esc(q.ans) +
        '</td><td class="' + (r ? 'ok' : 'bad') + '">' + (r ? '✓' : '✗') + '</td></tr>';
    });
    var scoreTxt = (document.getElementById('score') || {}).textContent || '';
    var who = studentName();
    var mins = timeUsed != null ? Math.floor(timeUsed / 60) + ' min ' + String(timeUsed % 60).padStart(2, '0') + ' s' : '';
    var h = '';
    h += '<h1>' + esc(title) + ' — Results report</h1>';
    h += '<p class="meta">' + esc(sub) + '</p>';
    h += '<p class="meta">' + (who ? 'Student: <b>' + esc(who) + '</b> · ' : '') + 'Date: ' + esc(new Date().toLocaleString('en-GB')) + (mins ? ' · Time used: ' + mins : '') + '</p>';
    h += '<div class="big">' + esc(scoreTxt) + ' &nbsp;·&nbsp; ' + correct + ' / ' + n + ' correct (' + Math.round(100 * correct / n) + '%)</div>';
    h += '<h2>By topic</h2><table><tr><th>Topic</th><th>Correct</th><th>Total</th><th>%</th></tr>' +
      secs.map(function (s) { return '<tr><td>' + esc(s.name) + '</td><td>' + s.c + '</td><td>' + s.t + '</td><td>' + Math.round(100 * s.c / s.t) + '%</td></tr>'; }).join('') + '</table>';
    h += '<h2>All questions</h2><table><tr><th>#</th><th>Topic</th><th>Your answer</th><th>Correct answer</th><th>Result</th></tr>' + rows + '</table>';
    h += '<h2>Mistakes and solutions' + (wrong.length ? ' (' + wrong.length + ')' : '') + '</h2>';
    if (!wrong.length) {
      h += '<p>No mistakes in this module. Well done!</p>';
    } else {
      wrong.forEach(function (i) {
        var q = Q[i], g = given[i];
        h += '<div class="mq"><div class="n">Question ' + (i + 1) + ' · ' + esc(sectionName(i)) + '</div><div class="txt">' + q.q + '</div>';
        if (!q.opts || q.open) {
          h += '<div class="ans">Your answer: <b>' + givenText(q, g) + '</b></div><div class="ans">Correct answer: <b>' + correctText(q) + '</b></div>';
        } else {
          q.opts.forEach(function (o, k) {
            var L = 'ABCD'[k];
            var cls = 'mo' + (q.ans === L ? ' key' : '') + (g === L && g !== q.ans ? ' mine' : '');
            var tag = (q.ans === L ? ' ✓ correct' : '') + (g === L && g !== q.ans ? ' ✗ your answer' : '');
            h += '<div class="' + cls + '"><b>' + L + ')</b> ' + o + '<i>' + tag + '</i></div>';
          });
          if (g === undefined || g === '') h += '<div class="ans">Your answer: <b>— (no answer)</b></div>';
        }
        var sh = solHtml(i);
        h += '<div class="solbox"><b>Solution</b>' + (sh || '<div class="st">Solution not available.</div>') + '</div></div>';
      });
    }
    h += '<div class="foot">CLC SAT · Greek SAT platform — generated ' + esc(new Date().toLocaleString('en-GB')) + '</div>';
    return h;
  }

  function doExport() {
    expBtn.disabled = true;
    loadSolutions().then(function () {
      var old = document.getElementById('clc-report');
      if (old) old.remove();
      var box = document.createElement('div');
      box.id = 'clc-report';
      box.innerHTML = buildReport();
      document.body.appendChild(box);
      return typeset(box).catch(function () {}).then(function () { return box; });
    }).then(function (box) {
      var done = function () {
        document.body.classList.remove('clc-printing');
        if (box && box.parentNode) box.parentNode.removeChild(box);
        expBtn.disabled = false;
        window.removeEventListener('afterprint', done);
      };
      window.addEventListener('afterprint', done);
      document.body.classList.add('clc-printing');
      setTimeout(function () { window.print(); }, 50);
    }).catch(function () { expBtn.disabled = false; });
  }
  expBtn.addEventListener('click', doExport);
})();
