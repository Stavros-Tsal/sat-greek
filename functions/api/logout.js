// POST /api/logout — clears the access cookie (the Google/Firebase sign-out is done by the page).
import { clearCookieHeader } from '../_lib/session.js';

export async function onRequestPost({ request }) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return new Response('{"error":"origin"}', { status: 403, headers: { 'Content-Type': 'application/json' } });
  return new Response('{"ok":true}', {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': clearCookieHeader() },
  });
}
