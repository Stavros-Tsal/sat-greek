// The free guest samples (and the scripts/images those pages need) are listed by the build in
// /_public/guest-paths.json. If it cannot be read the set is empty, i.e. fail closed.
let cache = { at: 0, set: null };

export function resetGuestCache() { cache = { at: 0, set: null }; }

export async function guestPaths(env, request) {
  const now = Date.now();
  if (cache.set && now - cache.at < 300000) return cache.set;
  try {
    const u = new URL(request.url);
    u.pathname = '/_public/guest-paths.json';
    u.search = '';
    const res = await env.ASSETS.fetch(new Request(u.toString()));
    if (res.ok) {
      cache = { at: now, set: new Set(await res.json()) };
      return cache.set;
    }
  } catch (e) { /* fall through */ }
  return new Set();
}
