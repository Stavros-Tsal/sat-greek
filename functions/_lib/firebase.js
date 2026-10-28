// Server-side repeat of the site's existing access rule:
//   1. the visitor signed in with Google (Firebase Auth ID token, verified here), and
//   2. their email is the admin, or exists in the Firestore "students" collection.
// Step 2 uses the visitor's OWN ID token against the Firestore REST API, so the existing
// Firestore security rules decide (no service account, no extra secret).
import { b64u } from './session.js';

const enc = new TextEncoder();
const DEFAULT_PROJECT = 'sat-greek-quiz-stavros';
const DEFAULT_ADMIN = 'stavrostsalapatis@gmail.com';
const DEFAULT_JWKS = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const DEFAULT_FIRESTORE = 'https://firestore.googleapis.com/v1';

let jwksCache = { url: null, keys: null, exp: 0 };

export function resetJwksCache() { jwksCache = { url: null, keys: null, exp: 0 }; }

async function getJwks(env, force) {
  const url = env.JWKS_URL || DEFAULT_JWKS;
  const now = Date.now();
  if (!force && jwksCache.url === url && jwksCache.keys && jwksCache.exp > now) return jwksCache.keys;
  const r = await fetch(url);
  if (!r.ok) throw new Error('jwks_' + r.status);
  const j = await r.json();
  const m = /max-age=(\d+)/.exec(r.headers.get('cache-control') || '');
  const ttl = m ? Math.min(Number(m[1]), 3600) : 3600;
  jwksCache = { url, keys: j.keys || [], exp: now + ttl * 1000 };
  return jwksCache.keys;
}

// Throws on any problem. Returns { email } (lower-cased) for a valid Google-provider token.
export async function verifyIdToken(idToken, env, now = Date.now()) {
  const projectId = env.FIREBASE_PROJECT_ID || DEFAULT_PROJECT;
  if (typeof idToken !== 'string' || idToken.length > 8192) throw new Error('malformed');
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('malformed');
  const header = JSON.parse(b64u.text(parts[0]));
  if (header.alg !== 'RS256' || !header.kid) throw new Error('alg');

  let jwk = (await getJwks(env, false)).find(function (k) { return k.kid === header.kid; });
  if (!jwk) jwk = (await getJwks(env, true)).find(function (k) { return k.kid === header.kid; });
  if (!jwk) throw new Error('kid');

  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64u.dec(parts[2]), enc.encode(parts[0] + '.' + parts[1]));
  if (!ok) throw new Error('signature');

  const c = JSON.parse(b64u.text(parts[1]));
  const t = Math.floor(now / 1000);
  if (c.aud !== projectId || c.iss !== 'https://securetoken.google.com/' + projectId) throw new Error('claims');
  if (!(c.exp > t) || !(c.iat <= t + 60) || typeof c.sub !== 'string' || !c.sub) throw new Error('time');
  if (typeof c.email !== 'string' || !c.email || c.email_verified !== true) throw new Error('email');
  // Google sign-in only: keeps the "verified through Google" guarantee of the current site.
  if (!c.firebase || c.firebase.sign_in_provider !== 'google.com') throw new Error('provider');
  return { email: c.email.trim().toLowerCase() };
}

// Same rule as isAllowed() in index.html. Throws on infrastructure errors (so the caller
// can tell "not a student" apart from "could not check").
export async function isAllowedStudent(email, idToken, env) {
  const admin = String(env.ADMIN_EMAIL || DEFAULT_ADMIN).trim().toLowerCase();
  if (email === admin) return true;
  const projectId = env.FIREBASE_PROJECT_ID || DEFAULT_PROJECT;
  const base = env.FIRESTORE_BASE || DEFAULT_FIRESTORE;
  const r = await fetch(base + '/projects/' + projectId + '/databases/(default)/documents:runQuery', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + idToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'students' }],
        where: { fieldFilter: { field: { fieldPath: 'email' }, op: 'EQUAL', value: { stringValue: email } } },
        limit: 1,
      },
    }),
  });
  if (!r.ok) throw new Error('firestore_' + r.status);
  const rows = await r.json();
  return Array.isArray(rows) && rows.some(function (x) { return x && x.document; });
}
