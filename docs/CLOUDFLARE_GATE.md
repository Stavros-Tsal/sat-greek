# Server-side access gate (Cloudflare Pages)

Branch `cf-gate`. Nothing here touches the live GitHub Pages site (`main`).

## What it does

The Google sign-in and the Firestore `students` check are **unchanged**. The page still signs the
visitor in with Google and still checks `students`. This branch adds a second layer on top: after
that check passes, the page asks the server to repeat it, and only then does the server hand out the files.

1. Visitor signs in with Google (Firebase Auth) and passes `isAllowed()` in `index.html`, as before.
2. The page POSTs the Firebase ID token to `/api/session`.
3. The server verifies the token (Google signature, project, expiry, Google provider, verified email),
   then repeats the students check **with the visitor's own token** against the Firestore REST API, so
   the existing Firestore rules decide. The admin email is accepted as in `index.html`.
4. If it passes, the server sets a signed, HttpOnly, Secure, SameSite=Lax cookie (12 h by default).
5. A middleware serves every file only with a valid cookie. Without one: pages redirect to `/`, other requests get 401.

`/` is served differently: members get the full app, everyone else gets a small shell (login + guest
screens) that contains **no question banks, no answers and no member-only links**.

Public without login: the shell, `assets/`, `progress.html` (+ `progress.js`, `results.js`; it has its own
Google login and Firestore rules protect the data), `/api/*`, and exactly the free guest samples
(College Board `Homework-30` pages plus the scripts/images they need). That list is generated from
`index.html` into `dist/_public/guest-paths.json` at build time.

## Files

| Path | Role |
|---|---|
| `functions/_middleware.js` | default-deny gate, picks shell vs. app at `/` |
| `functions/api/session.js`, `logout.js` | create / clear the cookie |
| `functions/_lib/*.js` | cookie signing, Firebase token + students check, guest path list |
| `scripts/build_gated.mjs` | builds `dist/` from the unchanged `index.html` (stays the only file you edit) |
| `tests/gate.test.mjs` | unit tests (`node --test tests/gate.test.mjs`) |
| `tests/shell-smoke.mjs` | loads shell/app in jsdom (`npm i --no-save jsdom`, then `node tests/shell-smoke.mjs dist`) |

`index.html` got two small additions (`establishSession()` and a changed `signOutUser()`); when there is
no server layer (e.g. today's GitHub Pages) they do nothing and the page behaves exactly as before.

## Setup (one time)

1. **Cloudflare dashboard** → Workers & Pages → Create → Pages → Connect to Git → `sat-greek`.
   - Production branch: leave `main` for now. The `cf-gate` branch gets a preview deployment automatically.
   - Build command: `node scripts/build_gated.mjs`
   - Build output directory: `dist`
2. **Environment variables** (Settings → Variables, both Production and Preview):
   - `SESSION_SECRET` – required, at least 32 random characters (e.g. `openssl rand -base64 48`). Keep it secret.
   - Optional: `SESSION_TTL_HOURS` (default 12), `ADMIN_EMAIL` (default `stavrostsalapatis@gmail.com`).
3. **Firebase console** → Authentication → Settings → Authorized domains: add the `*.pages.dev` hostname
   you will use (the preview hostname for `cf-gate` first, the production one later). Without this the
   Google popup fails with `auth/unauthorized-domain`. If the Firebase API key has HTTP-referrer
   restrictions in Google Cloud Console, add the same hostnames there.

## Test on the preview URL before switching anything

- Not signed in: `/` shows the login/guest shell; `/module1_part1.html` redirects to `/`; a guest sample
  (College Board `Homework-30`) opens; a `Review-15` page redirects.
- Sign in with a student account: the page reloads once and the full app appears; drills, practice tests
  and `progress.html` work; Test results are still recorded.
- Sign in with a Google account that is not in `students`: "no access" message, no cookie.
- Remove a test student from `students`: after the cookie expires (≤ 12 h) they are locked out.
- Logout returns to the shell.

## Switching over

1. Merge `cf-gate` into `main` only after the preview passes (refactor rule: test first).
2. Make the repo **private** and turn off GitHub Pages. While the repo is public or Pages is on, the
   files stay downloadable from GitHub regardless of this gate. (Private repos cannot use GitHub Pages
   on a free plan; Cloudflare Pages can build private repos.)
3. Give students the new URL; the old github.io address stops working.

## Known limits

- The 12 full practice tests live in a separate public repo/site (`sat-full-practice-tests`). They are
  **not** protected by this gate. Moving them into this project (under a gated folder) is the follow-up.
- Free Workers plan: 100,000 function requests/day. Every gated file and image goes through the
  middleware and counts. If that is exceeded, use the Workers Paid plan or exclude image folders in `_routes.json`.
- A signed-in student can still read and copy what they are shown (answers are in the page). Hiding
  answers from students would need server-side grading.
- Revocation delay = cookie lifetime (12 h by default).
- No Content-Security-Policy yet (the page relies on inline scripts and CDN libraries); basic security
  headers (`nosniff`, `X-Frame-Options`, `Referrer-Policy`) are set.
- Opening a gated link without a cookie lands on `/` (the deep link is not remembered).
- Tested locally with `wrangler pages dev` against mock Firebase endpoints, not against the live Firebase project.
