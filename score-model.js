// ═══════════════════════════════════════════════════════════════════
// CLC SAT — Math score model (v1)
//
// Turns "which questions did the student get right" into an ESTIMATED
// SAT Math section score (200–800) with a 95% confidence interval.
//
// Rule behind the model (teacher's observation of the real scoring):
//   a mistake in Algebra / Advanced Math costs about HALF of what the same
//   mistake costs in Geometry-Trigonometry or Problem-Solving & Data Analysis
//   (stats / probability).   =>  weights  A = 1, AM = 1, GT = 2, PSDA = 2.
//
// How it works
//   1. Every question is worth its domain weight (1 or 2 points).
//         A_w = (weight earned) / (weight available)          — a value in [0,1]
//   2. Score = 200 + 600 · A_w^1.15, rounded to 10.  (Same mildly S-shaped
//      curve the full-test pages already used.)
//   3. 95% CI = score ± 1.96 · √(SE_sampling² + SE_model²)
//        SE_sampling : uncertainty of the student's true accuracy in each
//                      domain given only n questions (Beta posterior, uniform
//                      prior), combined with the weights and pushed through
//                      the curve.  Large when few questions were answered.
//        SE_model    : fixed 20 points for curve / test-form uncertainty.
//
// It is an approximation, NOT an official College Board conversion.
//
// Usage:  CLCScore.estimateMath({A:{c,n}, AM:{c,n}, PSDA:{c,n}, GT:{c,n}})
//         CLCScore.tally(items, getDomain, isCorrect)   → counts object
//         CLCScore.panelHTML(est)                         → results panel (HTML string)
// ═══════════════════════════════════════════════════════════════════
(function (root) {
  'use strict';

  var ORDER = ['A', 'AM', 'PSDA', 'GT'];
  var DOMAINS = {
    A:    { key: 'A',    name: 'Algebra',                         weight: 1 },
    AM:   { key: 'AM',   name: 'Advanced Math',                   weight: 1 },
    PSDA: { key: 'PSDA', name: 'Problem-Solving & Data Analysis', weight: 2 },
    GT:   { key: 'GT',   name: 'Geometry & Trigonometry',         weight: 2 }
  };
  var SIGMA_MODEL = 20;  // score points of curve / form uncertainty
  var EXPONENT = 1.15;   // curve shape
  var Z95 = 1.96;
  var THIN_N = 4;        // fewer answered questions than this ⇒ domain flagged as thin

  // ── domain lookup: accepts 'A'|'AM'|'PSDA'|'GT', domain names, or College Board skill names ──
  var SKILLS = {
    A: ['linear equations in one variable', 'linear functions', 'systems of two linear equations in two variables',
        'linear inequalities in one or two variables'],
    AM: ['equivalent expressions', 'nonlinear equations in one variable and systems of equations in two variables',
         'nonlinear functions'],
    PSDA: ['ratios, rates, proportional relationships, and units', 'percentages',
           'one-variable data: distributions and measures of center and spread',
           'two-variable data: models and scatterplots', 'probability and conditional probability',
           'inference from sample statistics and margin of error',
           'evaluating statistical claims: observational studies and experiments'],
    GT: ['area and volume', 'lines, angles, and triangles', 'right triangles and trigonometry', 'circles']
  };
  var LOOKUP = {};
  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim(); }
  ORDER.forEach(function (k) {
    LOOKUP[norm(k)] = k;
    LOOKUP[norm(DOMAINS[k].name)] = k;
    SKILLS[k].forEach(function (s) { LOOKUP[norm(s)] = k; });
  });
  LOOKUP['problem solving and data analysis'] = 'PSDA';
  LOOKUP['geometry and trig'] = 'GT';

  function domainOf(x) { return LOOKUP[norm(x)] || null; }

  function emptyCounts() {
    var o = {};
    ORDER.forEach(function (k) { o[k] = { c: 0, n: 0 }; });
    return o;
  }

  // items: array; getDomain(item) → domain-ish value; isCorrect(item) → boolean.
  // Items whose domain cannot be resolved are skipped.
  function tally(items, getDomain, isCorrect) {
    var counts = emptyCounts();
    (items || []).forEach(function (it) {
      var k = domainOf(getDomain(it));
      if (!k) return;
      counts[k].n++;
      if (isCorrect(it)) counts[k].c++;
    });
    return counts;
  }

  function round10(x) { return Math.round(x / 10) * 10; }
  function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

  function estimateMath(counts) {
    var W = 0, E = 0, tc = 0, tn = 0;
    ORDER.forEach(function (k) {
      var x = (counts && counts[k]) || { c: 0, n: 0 };
      W += DOMAINS[k].weight * x.n;
      E += DOMAINS[k].weight * x.c;
      tc += x.c; tn += x.n;
    });
    if (!tn) return null;

    var Aw = E / W, varA = 0, rows = [], thin = [];
    ORDER.forEach(function (k) {
      var D = DOMAINS[k];
      var x = (counts && counts[k]) || { c: 0, n: 0 };
      var u = D.weight * x.n / W;                  // this domain's share of the weighted score
      var a = x.c + 1, b = x.n - x.c + 1, t = a + b;
      varA += u * u * (a * b / (t * t * (t + 1)));  // Beta(c+1, n-c+1) variance of the domain accuracy
      if (x.n < THIN_N) thin.push(k);
      rows.push({ key: k, name: D.name, c: x.c, n: x.n, pct: x.n ? 100 * x.c / x.n : null, weight: D.weight });
    });

    var raw = 200 + 600 * Math.pow(Aw, EXPONENT);
    var slope = 600 * EXPONENT * Math.pow(Math.max(Aw, 0.05), EXPONENT - 1);   // points per unit of A_w
    var seSampling = slope * Math.sqrt(varA);
    var se = Math.sqrt(seSampling * seSampling + SIGMA_MODEL * SIGMA_MODEL);

    var score = clamp(round10(raw), 200, 800);
    var lo = clamp(round10(raw - Z95 * se), 200, 800);
    var hi = clamp(round10(raw + Z95 * se), 200, 800);
    if (lo > score) lo = score;
    if (hi < score) hi = score;

    rows.forEach(function (r) { r.costPerMiss = slope * r.weight / W; });

    return {
      score: score, lo: lo, hi: hi, rawScore: raw, se: se,
      weighted: Aw, plain: tc / tn, correct: tc, total: tn, weightTotal: W,
      domains: rows, thin: thin,
      costLight: slope / W,        // points lost for one mistake in Algebra / Advanced Math
      costHeavy: 2 * slope / W     // points lost for one mistake in Geometry-Trig / Stats-Probability
    };
  }

  function format(est) {
    return est ? est.score + ' (95% CI ' + est.lo + '–' + est.hi + ')' : '—';
  }

  // ── small results panel (English, theme-neutral inline styles) ──
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function panelHTML(est) {
    if (!est) return '';
    var left = (est.lo - 200) / 6, width = Math.max(1.2, (est.hi - est.lo) / 6), mark = (est.score - 200) / 6;
    var th = 'padding:4px 8px;font-weight:600';
    var rowsHtml = est.domains.map(function (r) {
      return '<tr>'
        + '<td style="padding:5px 8px;text-align:left">' + esc(r.name) + '</td>'
        + '<td style="padding:5px 8px;text-align:center">' + r.c + '/' + r.n + '</td>'
        + '<td style="padding:5px 8px;text-align:center">' + (r.pct == null ? '—' : Math.round(r.pct) + '%') + '</td>'
        + '<td style="padding:5px 8px;text-align:center">×' + r.weight + '</td>'
        + '<td style="padding:5px 8px;text-align:center">' + (r.n ? '−' + Math.round(r.costPerMiss) + ' pts' : '—') + '</td>'
        + '</tr>';
    }).join('');
    var thinNames = est.thin.map(function (k) { return DOMAINS[k].name; });
    var thinNote = thinNames.length
      ? '<p style="margin:8px 0 0;font-size:12px;opacity:.85">⚠ This test has very few ' + esc(thinNames.join(' / '))
        + ' questions, so the interval is less reliable for that area.</p>'
      : '';
    return ''
      + '<div class="clc-score-model" style="margin:18px auto;max-width:640px;text-align:left;border:1px solid rgba(128,128,128,.35);border-radius:10px;padding:14px 16px;font-size:13.5px;line-height:1.45">'
      + '<div style="font-size:12px;letter-spacing:.05em;text-transform:uppercase;opacity:.75">Estimated Math section score</div>'
      + '<div style="font-size:26px;font-weight:700;margin:2px 0">' + est.score
      + ' <span style="font-size:14px;font-weight:500;opacity:.8">95% CI: ' + est.lo + ' – ' + est.hi + '</span></div>'
      + '<div style="position:relative;height:10px;border-radius:5px;background:rgba(128,128,128,.25);margin:10px 0 4px">'
      + '<div style="position:absolute;top:0;bottom:0;left:' + left + '%;width:' + width + '%;border-radius:5px;background:rgba(80,130,200,.55)"></div>'
      + '<div style="position:absolute;top:-3px;bottom:-3px;left:calc(' + mark + '% - 1.5px);width:3px;border-radius:2px;background:currentColor"></div>'
      + '</div>'
      + '<div style="display:flex;justify-content:space-between;font-size:11px;opacity:.7"><span>200</span><span>500</span><span>800</span></div>'
      + '<table style="width:100%;border-collapse:collapse;margin-top:10px;font-size:12.5px">'
      + '<tr style="opacity:.7"><th style="' + th + ';text-align:left">Domain</th><th style="' + th + '">Correct</th><th style="' + th + '">Accuracy</th><th style="' + th + '">Weight</th><th style="' + th + '">Per mistake</th></tr>'
      + rowsHtml + '</table>'
      + '<p style="margin:8px 0 0;font-size:12px;opacity:.85">On this test a mistake in Algebra or Advanced Math costs about <b>'
      + Math.round(est.costLight) + '</b> points, one in Geometry-Trig or Stats-Probability about <b>' + Math.round(est.costHeavy) + '</b>.</p>'
      + thinNote
      + '<p style="margin:8px 0 0;font-size:11.5px;opacity:.7">Approximate model, not an official College Board score. The interval widens when fewer questions are answered and includes ±20 points of conversion uncertainty.</p>'
      + '</div>';
  }

  root.CLCScore = {
    DOMAINS: DOMAINS, ORDER: ORDER, WEIGHTS: { A: 1, AM: 1, PSDA: 2, GT: 2 },
    domainOf: domainOf, emptyCounts: emptyCounts, tally: tally,
    estimateMath: estimateMath, format: format, panelHTML: panelHTML
  };
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
