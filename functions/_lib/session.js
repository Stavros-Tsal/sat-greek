// Signed, short-lived session cookie. Issued only after the server has repeated the
// Google sign-in + "students" check (see _lib/firebase.js). Format: v1.<payload>.<hmac>
const enc = new TextEncoder();
const dec = new TextDecoder();

export const COOKIE = 'clc_session';

export const b64u = {
  enc(bytes) {
    const a = new Uint8Array(bytes);
    let s = '';
    for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(str) {
    let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
  text(str) { return dec.decode(b64u.dec(str)); },
};

function hmacKey(secret, usages) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}

export async function signSession(secret, email, ttlSeconds, now = Date.now()) {
  const payload = b64u.enc(enc.encode(JSON.stringify({ e: email, x: Math.floor(now / 1000) + ttlSeconds })));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret, ['sign']), enc.encode('v1.' + payload));
  return 'v1.' + payload + '.' + b64u.enc(sig);
}

// Returns { email, exp } or null. Never throws.
export async function verifySession(secret, token, now = Date.now()) {
  try {
    if (!secret || !token) return null;
    const parts = String(token).split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') return null;
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret, ['verify']), b64u.dec(parts[2]), enc.encode('v1.' + parts[1]));
    if (!ok) return null;
    const p = JSON.parse(b64u.text(parts[1]));
    if (!p || typeof p.e !== 'string' || typeof p.x !== 'number') return null;
    if (p.x <= Math.floor(now / 1000)) return null;
    return { email: p.e, exp: p.x };
  } catch (e) {
    return null;
  }
}

export function readCookie(request, name = COOKIE) {
  const h = request.headers.get('Cookie') || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function setCookieHeader(value, maxAgeSeconds) {
  return COOKIE + '=' + value + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + maxAgeSeconds;
}

export function clearCookieHeader() {
  return setCookieHeader('', 0);
}
