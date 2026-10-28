// Default-deny gate for the whole site (Cloudflare Pages Functions middleware).
//  - Public: the login shell ("/"), the shared assets, the progress page, and /api/*.
//  - Everything else needs a valid signed session cookie (issued by /api/session after the
//    Google sign-in + students check). Without it: redirect to "/" (pages) or 401 (other).
//  - "/" serves the full app to members and a data-free shell to everyone else.
// Never uses passThroughOnException(): any error here means the request fails, not that it leaks.
import { verifySession, readCookie, COOKIE } from './_lib/session.js';
import { guestPaths } from './_lib/guest.js';

const PUBLIC_EXACT = new Set([
  '/', '/index.html', '/index',
  '/progress.html', '/progress', '/progress.js', '/results.js',
  '/favicon.ico', '/robots.txt',
]);
const PUBLIC_PREFIX = ['/assets/', '/_public/'];

const SHELL = '/_public/shell.html';
const APP = '/_private/app.html';

function isRoot(p) { return p === '/' || p === '/index.html' || p === '/index'; }

async function isPublic(p, env, request) {
  if (PUBLIC_EXACT.has(p)) return true;
  for (const pre of PUBLIC_PREFIX) if (p.startsWith(pre)) return true;
  return (await guestPaths(env, request)).has(p);
}

function withHeaders(res, extra) {
  const r = new Response(res.body, res);
  r.headers.set('X-Content-Type-Options', 'nosniff');
  r.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  r.headers.set('X-Frame-Options', 'SAMEORIGIN');
  r.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (extra) for (const k of Object.keys(extra)) r.headers.set(k, extra[k]);
  return r;
}

// Fetch a static asset. Pages answers "/x.html" with a redirect to "/x" ("pretty URLs");
// follow that internally so the browser keeps the .html address (results.js reads it).
async function fetchAsset(env, request, pathname, depth) {
  const u = new URL(request.url);
  u.pathname = pathname;
  const res = await env.ASSETS.fetch(new Request(u.toString(), { method: request.method, headers: request.headers }));
  if (res.status >= 300 && res.status < 400 && (depth || 0) < 2) {
    const loc = res.headers.get('Location');
    if (loc) {
      const next = new URL(loc, u);
      if (next.origin === u.origin) return fetchAsset(env, request, next.pathname, (depth || 0) + 1);
    }
  }
  return res;
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  let path;
  try { path = decodeURIComponent(url.pathname); }
  catch (e) { return withHeaders(new Response('Bad request', { status: 400 })); }
  if (/[\u0000-\u001f\\]/.test(path) || path.includes('..') || path.includes('//')) {
    return withHeaders(new Response('Bad request', { status: 400 }));
  }

  // API endpoints enforce their own checks.
  if (path === '/api/session' || path === '/api/logout') return withHeaders(await context.next(), { 'Cache-Control': 'no-store' });
  if (path.startsWith('/api/')) return withHeaders(new Response('Not found', { status: 404 }));

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return withHeaders(new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } }));
  }

  const session = await verifySession(env.SESSION_SECRET, readCookie(request, COOKIE));

  if (isRoot(path)) {
    const res = await fetchAsset(env, request, session ? APP : SHELL);
    return withHeaders(res, { 'Cache-Control': 'private, no-store', 'Vary': 'Cookie' });
  }

  if (await isPublic(path, env, request)) return withHeaders(await fetchAsset(env, request, url.pathname));

  if (!session) {
    const wantsPage = (request.headers.get('Accept') || '').includes('text/html');
    if (wantsPage) return withHeaders(new Response(null, { status: 302, headers: { Location: '/', 'Cache-Control': 'no-store' } }));
    return withHeaders(new Response('Unauthorized', { status: 401, headers: { 'Cache-Control': 'no-store' } }));
  }

  return withHeaders(await fetchAsset(env, request, url.pathname), { 'Cache-Control': 'private, max-age=0, must-revalidate', 'Vary': 'Cookie' });
}
