// POST /api/session  { idToken }
// The page calls this right after its normal Google sign-in + students check succeeded.
// The server repeats both checks and, only if they pass, sets the cookie that unlocks the files.
import { verifyIdToken, isAllowedStudent } from '../_lib/firebase.js';
import { signSession, setCookieHeader, clearCookieHeader } from '../_lib/session.js';

function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, extra || {}),
  });
}

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return json({ error: 'origin' }, 403);

  if (!env.SESSION_SECRET || String(env.SESSION_SECRET).length < 32) return json({ error: 'server_not_configured' }, 500);

  let body;
  try {
    const text = await request.text();
    if (text.length > 10000) return json({ error: 'too_large' }, 413);
    body = JSON.parse(text);
  } catch (e) {
    return json({ error: 'bad_request' }, 400);
  }

  let who;
  try { who = await verifyIdToken(body && body.idToken, env); }
  catch (e) { return json({ error: 'invalid_token' }, 401, { 'Set-Cookie': clearCookieHeader() }); }

  let allowed;
  try { allowed = await isAllowedStudent(who.email, body.idToken, env); }
  catch (e) { return json({ error: 'check_failed' }, 502); }
  if (!allowed) return json({ error: 'not_allowed' }, 403, { 'Set-Cookie': clearCookieHeader() });

  const ttl = Math.round((Number(env.SESSION_TTL_HOURS) || 12) * 3600);
  const token = await signSession(env.SESSION_SECRET, who.email, ttl);
  return json({ ok: true }, 200, { 'Set-Cookie': setCookieHeader(token, ttl) });
}
