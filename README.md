# AI Workshop Growth Hub — Growth Intelligence Platform

Simulation for the NxtWave Growth Intern Challenge. Campaign: **Build Your First AI Project in 60 Minutes** · audience: final-year engineering students · target: **500 registrations in 7 days** · budget cap: **₹2,000**.

> **Data honesty.** Every number is labelled by origin: *Recorded/Actual* (events and entries this installation really stored), *Target* (500 / ₹2,000 / 7 days), *Model estimate* (projections, what-if), and *Simulated* (seeded demo data). Demo and live data live in separate datasets (`dataset: "demo" | "live"`) and are never mixed. Nothing in this repository is real registrations, conversions or AI usage.

## What is implemented

| # | Feature | Where |
|---|---|---|
| 1 | AI Growth Copilot (Gemini server-side + labelled rule-based fallback, human accept/reject) | `server/src/ai/copilot.js`, `gemini.js`, page *AI Copilot* |
| 2 | UTM / referral attribution, consent-aware funnel, channel report | `routes/public.js`, `domain/metrics.js`, `client/src/lib/tracking.js` |
| 3 | Run-rate forecast with conservative/base/optimistic scenarios, formulas, insufficient-data guard | `domain/forecast.js` |
| 4 | A/B experiments: sticky server-side assignment, CI, z-test, sample guards | `domain/experiments.js` |
| 5 | Employees/ambassadors: unique codes, **1 point per counted registration (configurable `pointsPerReferral`)**, code via link or typed on the form, points leaderboard, self-referral / duplicate / network-limit rules, counts-only reports | `domain/referrals.js` |
| 6 | Budget: plan vs actual, ₹2,000 ceiling, evidence-gated recommendations, what-if simulator | `domain/budget.js` |
| 7 | Content Studio: templates + optional Gemini, character counts, UTM tagging, content lint, approval | `ai/content.js` |
| 8 | Alerts (on refresh) + chronological audit log with human reasons | `domain/alerts.js`, `domain/audit.js` |

Dashboard: Overview, Registrations, Attribution, Forecasts, Experiments, Referrals, Budget, AI Copilot, Content Studio, Activity Log; date + channel filters, INR formatting, CSV export, demo banner with load/reset, responsive, light/dark.

**Starting point:** the repository you referred to was not available in this session (empty working directory, no GitHub link), so this is a **fresh build** on your preferred stack shape (React + Node, MongoDB optional). It does not preserve any previous code.

## Architecture choices (and why)

- **Client:** React 19, bundled with esbuild (`client/build.mjs`). Hand-written SVG charts (no chart library).
- **Server:** Node 20+ with **zero required runtime dependencies** (own router, validation, JWT, scrypt, rate limiter). This was deliberate: the build sandbox blocked the npm registry, so everything had to be verifiable offline. Trade-off: you maintain more of your own security-critical code than if you used Express/Helmet/Zod/jsonwebtoken; swapping those in is straightforward.
- **Storage:** an adapter interface with `MemoryStore` (tests, local demo) and a **MongoDB/Mongoose adapter** (`store/mongo.js`). ⚠️ The Mongo adapter has **not been run** — no MongoDB or `mongoose` was available. Treat it as unverified until you run the flows against a real instance.
- **Forecasting is in Node, not FastAPI.** The model is ~100 lines of arithmetic (mean, standard error, scenarios). A separate Python service would add deployment surface without adding validity. It is explicitly labelled *not* validated machine learning.
- **No background jobs.** Alerts are computed when the dashboard/API is refreshed.

## Run it

```bash
cp .env.example .env            # fill JWT_SECRET, ANALYTICS_SALT, ADMIN_EMAIL, ADMIN_PASSWORD
npm run install:all             # installs server (optional mongoose) and client deps
npm run build                   # builds client/dist
npm start                       # http://localhost:4000  (serves API + built client)
```

- Public page: `/` · Dashboard: `/admin` (sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`).
- Without `MONGODB_URI` the in-memory store is used (data lost on restart). In production set `MONGODB_URI` (required when `NODE_ENV=production`).
- Dev: `npm run dev:server` and `npm run dev:client` (watch build).
- Admin and analyst users are created/updated from the environment at startup (no seed script needed).

### Environment variables
See `.env.example`. Required: `JWT_SECRET` (≥32), `ANALYTICS_SALT` (≥16), `ADMIN_EMAIL`, `ADMIN_PASSWORD` (≥10). Optional: `ANALYST_EMAIL/PASSWORD`, `MONGODB_URI`, `GEMINI_API_KEY` (+`GEMINI_MODEL`, `GEMINI_TIMEOUT_MS`), `PORT`, `PUBLIC_BASE_URL`, `CORS_ORIGINS`, `TRUST_PROXY`, `JWT_TTL_SECONDS`, `TZ_OFFSET_MIN`. The server validates these at boot and never prints secret values.

## Tests

```bash
npm test            # server (node:test) + client (node:test)
```
Covers registration + attribution, funnel maths, forecast maths and insufficient-data handling, A/B assignment and statistics, referral rules and dedupe, budget maths and the ₹2,000 ceiling, filtering, CSV export (incl. formula injection), access control (401/403, forged/expired JWT), rate limiting, CORS, demo/live isolation, Gemini success/failure/secret-leak paths, content rules, alerts and audit.

## Security & privacy notes

- JWT (HS256, algorithm fixed server-side), scrypt password hashing, constant-time compare, uniform login errors, login/register/API/AI rate limits (**in-process, reset on restart and not shared across instances** — use a shared limiter or an edge limiter when scaling out).
- Roles: `admin` (write) and `analyst` (read-only). Every write requires a human reason and is audit-logged.
- Emails, IPs and visitor IDs are stored only as HMAC hashes for analytics/dedupe; raw email is kept on the registration record for organisers but is **masked in every API response and export**. Analytics events contain no personal data. Visitor IDs are stored in the browser only after consent.
- Gemini key lives only in server env, is sent in a header, never logged or returned; only aggregate metrics go to the model; LLM output is schema-validated and clamped; any failure falls back to a labelled rule-based result without echoing error details.
- Security headers + CSP, 100 KB body limit, strict input validation, CSV formula neutralisation, CORS allow-list (same-origin always allowed).
- Not implemented: email verification of registrants, CAPTCHA, account lockout beyond rate limiting, refresh tokens/revocation, data-deletion endpoint. Consider these before real use.

## Attribution rules
1. First-touch within a browser session: UTM + `ref` from the first tagged landing URL are kept (sessionStorage; no ID without consent).
2. `channel` = normalised `utm_source` (`wa`→whatsapp, `ig`→instagram…); else `referral` if a *known* referral code is present; else `direct`.
3. Registrations are created server-side only; the client cannot forge `reg_success`.
4. Consented visitors are deduplicated per event type per day; visitors who decline are counted per event (cannot be deduplicated) — a documented over-count risk.
5. Limits: no cross-device stitching, untagged shares become "direct", association ≠ causation.

## API (all JSON; dashboard routes need `Authorization: Bearer <jwt>`; add `?dataset=live|demo&from=&to=&channel=`)

Public: `GET /api/health` · `GET /api/public/config` · `POST /api/public/assign` · `POST /api/public/events` (`page_view|cta_click|reg_start`) · `POST /api/public/register`

Auth: `POST /api/auth/login` · `GET /api/auth/me`

Read (admin+analyst): `GET /api/overview|registrations|attribution|forecast|experiments|referrals|budget|alerts|audit|settings|demo/status` · `GET …/export.csv` (registrations, attribution[`?report=funnel`], forecast, experiments, referrals, budget, audit) · `GET /api/referrals/ambassadors/:id/report` · `POST /api/budget/whatif` · `POST /api/copilot/analyze` · `GET /api/content/options|drafts` · `POST /api/content/generate` · `GET /api/copilot/decisions`

Write (admin only, each requires `reason`): `PUT /api/settings` · `POST /api/experiments` · `PUT /api/experiments/:key/status` · `POST /api/referrals/ambassadors` · `PUT /api/referrals/ambassadors/:id/status` · `POST /api/budget/spend` · `DELETE /api/budget/spend/:id` · `PUT /api/budget/plan` · `POST /api/copilot/decisions` · `POST/PUT /api/content/drafts` · `POST /api/content/drafts/:id/approve` · `POST /api/alerts/ack` · `POST /api/demo/load|reset`

Errors: `{ "error": code, "message": text, "details"?: … }` with 400/401/403/404/409/413/415/422/429.

## Manual demo script (≈5 minutes)
1. Sign in at `/admin` → note the green **Live data** banner and empty states.
2. **Load demo data** → purple dashed **SIMULATED** banner on every page.
3. Overview: required/day vs average, funnel, channel table. Filter to `whatsapp` → every number changes; **Export CSV**.
4. Forecasts: three scenarios, formulas, “not validated ML” notice; Live dataset shows the insufficient-data warning.
5. Experiments: simulated variants with CI; no winner declared until samples/significance are met.
6. Referrals: leaderboard, rule list, ambassador report (counts only), pause a code (reason required).
7. Budget: planned vs actual, try recording spend above ₹2,000 (blocked), use the what-if simulator.
8. AI Copilot: *Analyse* → “Rule-based (not AI)” label; reject one with a reason, accept another.
9. Content Studio: generate drafts; see character counts, UTM tags, date placeholder; try to approve with the placeholder (blocked).
10. Activity Log: referral-burst and decline alerts (on-refresh notice), acknowledge one, review the audit trail. **Reset demo** — live data remains.
11. Open `/?utm_source=wa&utm_campaign=ai60`, decline/accept analytics, register → appears in **Live** only.

## Known limitations
- MongoDB adapter unverified (see above). No deployment was performed.
- Gemini path is tested with a mocked `fetch` only; it has not been called against the real API.
- Forecast is a simple run-rate model; early-campaign data makes it unreliable.
- Experiments: single running experiment at a time; copy edits mid-run are not supported (create a new experiment).
- Registration emails are stored in clear text on the server record (needed for organiser contact); encrypt at rest/DB-level if required.
- Rate limiting is per-process memory.
