#!/usr/bin/env node
// Build for Cloudflare Pages:  node scripts/build_gated.mjs [srcDir=.] [outDir=dist]
//
// index.html stays the single source of truth (edit only that file, as before). From it this
// script produces two variants that the middleware chooses between at "/":
//   dist/_private/app.html  - the full app (identical to index.html)
//   dist/_public/shell.html - login + guest screens only: no question banks, no answers,
//                             no member-only links, and the non-guest screens emptied
// plus dist/_public/guest-paths.json: the exact files the guest screens link to (the free
// "Homework-30" College Board samples) and what those pages need (scripts, images).
// Everything else in the repo is copied to dist/ unchanged and is served only to members.
// There is deliberately NO dist/index.html, so nothing can be served by accident.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const SRC = path.resolve(process.argv[2] || '.');
const OUT = path.resolve(process.argv[3] || 'dist');

const DATA_MIN_BYTES = 1000;                    // top-level const arrays/objects larger than this are data
const SHELL_MAX_BYTES = 600 * 1024;
const EMPTY_FOR = {                             // keep the nesting the page code expects
  QUESTIONS: '[[],[],[],[]]',
  ANSWERS: '[{},{},{},{}]',
};

// ---------- 1. strip embedded data constants ----------
function matchBracket(s, open) {
  const openCh = s[open];
  const closeCh = openCh === '[' ? ']' : '}';
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < s.length && s[i] !== q) { if (s[i] === '\\') i++; i++; }
      continue;
    }
    if (c === openCh) depth++;
    else if (c === closeCh) { depth--; if (depth === 0) return i; }
  }
  throw new Error('unbalanced bracket starting at offset ' + open);
}

function stripData(html) {
  const re = /^(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([\[{])/gm;
  const edits = [];
  let m;
  while ((m = re.exec(html))) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(html, open);
    if (close - open + 1 < DATA_MIN_BYTES) { re.lastIndex = close; continue; }
    const name = m[2];
    edits.push({ start: open, end: close + 1, text: EMPTY_FOR[name] || (m[3] === '[' ? '[]' : '{}'), name, bytes: close - open + 1 });
    re.lastIndex = close;
  }
  let out = html;
  for (let i = edits.length - 1; i >= 0; i--) out = out.slice(0, edits[i].start) + edits[i].text + out.slice(edits[i].end);
  return { html: out, stripped: edits };
}

// ---------- 2. balanced element helpers ----------
// End offset (exclusive) of the element whose start tag begins at `at`.
function elementEnd(html, at, tag) {
  const startTag = new RegExp('<' + tag + '\\b[^>]*>', 'y');
  startTag.lastIndex = at;
  const first = startTag.exec(html);
  if (!first) throw new Error('no <' + tag + '> at ' + at);
  const tokenRe = new RegExp('<(/?)' + tag + '\\b[^>]*?(/?)>', 'g');
  tokenRe.lastIndex = at + first[0].length;
  let depth = 1, t;
  while ((t = tokenRe.exec(html))) {
    if (t[2] === '/') continue;                 // self-closing
    depth += t[1] ? -1 : 1;
    if (depth === 0) return { end: t.index + t[0].length, innerStart: at + first[0].length, innerEnd: t.index };
  }
  throw new Error('unbalanced <' + tag + '> at ' + at);
}

function removeMemberOnly(html) {
  const startRe = /<(div|a|button|span|section|li)\b[^>]*\bclass="[^"]*\bmember-only\b[^"]*"[^>]*>/;
  let removed = 0;
  for (;;) {
    const m = startRe.exec(html);
    if (!m) break;
    const e = elementEnd(html, m.index, m[1]);
    html = html.slice(0, m.index) + html.slice(e.end);
    removed++;
  }
  return { html, removed };
}

// Empty every <div id="screen-..." class="screen"> the guest cannot reach (see GUEST_SCREENS in the page script).
function emptyNonGuestScreens(html) {
  const g = /GUEST_SCREENS\s*=\s*\/(.+?)\/\s*;/.exec(html);
  if (!g) throw new Error('GUEST_SCREENS regex not found in index.html');
  const guestRe = new RegExp(g[1]);
  const startRe = /<div id="(screen-[\w-]+)" class="screen[^"]*">/g;
  const edits = [];
  let m, emptied = 0;
  while ((m = startRe.exec(html))) {
    if (guestRe.test(m[1])) continue;
    const e = elementEnd(html, m.index, 'div');
    edits.push({ from: e.innerStart, to: e.innerEnd });
    startRe.lastIndex = e.end;
    emptied++;
  }
  for (let i = edits.length - 1; i >= 0; i--) html = html.slice(0, edits[i].from) + html.slice(edits[i].to);
  return { html, emptied };
}

function markupOnly(html) { return html.replace(/<script\b[\s\S]*?<\/script>/gi, ''); }
function countTag(s, tag, close) { return (s.match(new RegExp('<' + (close ? '/' : '') + tag + '\\b', 'gi')) || []).length; }

function inlineScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) if (!/\bsrc\s*=/.test(m[1])) out.push(m[2]);
  return out;
}

// ---------- 3. what the guest may fetch ----------
const IMG_EXT = '(?:jpg|jpeg|png|gif|svg|webp|pdf)';

function isLocalRef(u) { return u && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(u); }

function resolveRel(fromFile, ref) {
  const clean = ref.split('#')[0].split('?')[0];
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), clean));
}

function guestPaths(shellMarkup) {
  const set = new Set();
  const warnings = [];
  const pages = new Set();
  for (const m of shellMarkup.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
    const ref = m[1].replace(/&amp;/g, '&');
    if (!isLocalRef(ref)) continue;
    const p = resolveRel('index.html', ref);
    set.add('/' + p);
    if (p.endsWith('.html')) pages.add(p);
  }
  for (const page of pages) {
    const file = path.join(SRC, page);
    if (!fs.existsSync(file)) { warnings.push('guest page missing on disk: ' + page); continue; }
    const text = fs.readFileSync(file, 'utf8');
    const prefix = (/"assetPrefix"\s*:\s*"([^"]*)"/.exec(text) || [])[1] || '';
    // static script/link/img references
    for (const m of text.matchAll(/<(?:script|link|img)\b[^>]*?\b(?:src|href)="([^"]+)"/g)) {
      if (isLocalRef(m[1])) set.add('/' + resolveRel(page, m[1]));
    }
    // image/pdf string literals (resolved with and without the page's assetPrefix)
    let hit = 0, miss = 0;
    const seen = new Set();
    for (const m of text.matchAll(new RegExp('"([A-Za-z0-9_./-]+\\.' + IMG_EXT + ')"', 'g'))) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      const cands = [resolveRel(page, m[1]), resolveRel(page, prefix + m[1])];
      const found = cands.find(function (c) { return fs.existsSync(path.join(SRC, c)); });
      if (found) { set.add('/' + found); hit++; } else miss++;
    }
    if (miss) warnings.push(page + ': ' + miss + ' image-like string(s) did not resolve to a file (' + hit + ' did)');
  }
  return { list: [...set].filter(function (p) { return fs.existsSync(path.join(SRC, p.slice(1))); }).sort(), warnings };
}

// ---------- 4. the shell ----------
function makeShell(source) {
  const s1 = stripData(source);
  const s2 = removeMemberOnly(s1.html);
  const s3 = emptyNonGuestScreens(s2.html);
  let shell = s3.html.replace(/<head>/i, '<head>\n<script>window.__PUBLIC_SHELL = true;</script>');
  // goScreen() writes to #mode-badge, which lives inside an emptied screen: keep a hidden stand-in.
  if (!/id="mode-badge"/.test(markupOnly(shell))) {
    const at = shell.lastIndexOf('</body>');          // the last one: earlier ones sit inside JS string templates
    if (at < 0) throw new Error('no </body> found in index.html');
    shell = shell.slice(0, at) + '<span id="mode-badge" hidden></span>\n' + shell.slice(at);
  }

  // The page pre-renders the first drill question of every tab at load time; with the question
  // bank stripped that would throw and stop the rest of the app script. Skip it in the shell only.
  const preRender = /^\[0,1,2,3\]\.forEach\(\s*i\s*=>\s*renderQuestion\(i\)\s*\);/m;
  if (preRender.test(shell)) shell = shell.replace(preRender, '/* shell: no question data to pre-render */');
  else console.warn('WARNING: the load-time renderQuestion loop was not found; run tests/shell-smoke.mjs to check the shell still loads cleanly');
  const mk = markupOnly(shell);
  const gp = guestPaths(mk);

  // ----- hard checks: fail the build rather than ship a leaky or broken shell -----
  const problems = [];
  if (Buffer.byteLength(shell) > SHELL_MAX_BYTES) problems.push('shell is ' + Buffer.byteLength(shell) + ' bytes (limit ' + SHELL_MAX_BYTES + ')');
  const forbidden = [/Review-\d+/, /Extra-Homework/, /past-sat-papers\//, /solved-exercises\//, /module[12]_part\d+/,
    /specific-practice-[\w-]+\.html/, /memento-math/, /hardest-math/, /(?:^|["'\/])full-practice-test(?:-\d+)?\.html/,
    /SAT-Full-Practice-Test-(?:0[1-9]|1[01])\b/, /"1": "B"/];
  for (const f of forbidden) if (f.test(mk) || f.test(shell)) problems.push('shell still matches ' + f);
  if (/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]{100000,}/.test(shell)) problems.push('shell contains a very large inline base64 image');
  for (const tag of ['div', 'a', 'button']) {
    const o = countTag(mk, tag, false), c = countTag(mk, tag, true);
    if (o !== c) problems.push('unbalanced <' + tag + '> in shell markup: ' + o + ' open / ' + c + ' close');
  }
  for (const [i, code] of inlineScripts(shell).entries()) {
    try { new vm.Script(code, { filename: 'shell-inline-' + i + '.js' }); }
    catch (e) { problems.push('inline script #' + i + ' no longer parses: ' + e.message); }
  }
  for (const p of gp.list) if (/Review-\d+|Extra-Homework/.test(p)) problems.push('guest path list includes member material: ' + p);
  if (problems.length) throw new Error('Shell check failed:\n - ' + problems.join('\n - '));
  return { shell, stripped: s1.stripped, removedMemberOnly: s2.removed, emptiedScreens: s3.emptied, guest: gp };
}

// ---------- 5. assemble dist/ ----------
const SKIP_TOP = new Set(['.git', '.github', '.gitignore', '.nojekyll', 'node_modules', 'scripts', 'functions', 'tests', 'docs',
  'dist', 'index.html', 'auth-config.js', 'package.json', 'package-lock.json', 'wrangler.toml']);

function copyTree() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  for (const name of fs.readdirSync(SRC)) {
    if (SKIP_TOP.has(name) || name.endsWith('.py') || name === 'requirements.txt') continue;
    fs.cpSync(path.join(SRC, name), path.join(OUT, name), { recursive: true });
  }
}

function main() {
  const source = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  const r = makeShell(source);

  copyTree();
  fs.mkdirSync(path.join(OUT, '_public'), { recursive: true });
  fs.mkdirSync(path.join(OUT, '_private'), { recursive: true });
  fs.writeFileSync(path.join(OUT, '_public', 'shell.html'), r.shell);
  fs.writeFileSync(path.join(OUT, '_public', 'guest-paths.json'), JSON.stringify(r.guest.list));
  fs.writeFileSync(path.join(OUT, '_private', 'app.html'), source);
  fs.writeFileSync(path.join(OUT, '_routes.json'), JSON.stringify({ version: 1, include: ['/*'], exclude: [] }));

  if (fs.existsSync(path.join(OUT, 'index.html'))) throw new Error('dist/index.html must not exist');

  const names = r.stripped.map(function (e) { return e.name; });
  console.log('shell.html: ' + Buffer.byteLength(r.shell) + ' bytes (app.html: ' + Buffer.byteLength(source) + ' bytes)');
  console.log('stripped ' + r.stripped.length + ' data constants (' + r.stripped.reduce(function (a, e) { return a + e.bytes; }, 0) + ' bytes)');
  console.log('removed ' + r.removedMemberOnly + ' member-only elements; emptied ' + r.emptiedScreens + ' non-guest screens');
  console.log('guest-paths.json: ' + r.guest.list.length + ' public files');
  for (const w of r.guest.warnings) console.warn('WARNING: ' + w);
  for (const must of ['QUESTIONS', 'ANSWERS']) if (!names.includes(must)) throw new Error(must + ' was not stripped from the shell');
}

main();
