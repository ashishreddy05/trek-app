> **Updated 23 September 2026 — AUTH-01.** Sign-in is now **work email + password**. The emailed-code flow described in older documents no longer exists. Setup, deployment (Neon + Vercel), first-admin creation, invites and reset: see **`DEPLOY.md`**.

# Trek — application repository

First live vertical slice for the Sales pilot. **Stages 0–1 only:** repository, PostgreSQL, migrations, authentication (work email + password), session management, server-side authorization, email relay, environments, logging, deployment foundation.

**Verified 25 September 2026:** `npm run migrate` applies all four migrations and the full suite passes 77/77 against a real PostgreSQL database (Neon). Local setup, staging, production, reset, pilot test checklist, blockers: **`RUNBOOK.md`**. Deployment: **`DEPLOY.md`**.

Two defects found by static review are fixed: the bypass-check script matched the word "bypass" inside the comments promising there is no bypass, so a clean tree failed the build (it now strips comments and matches identifiers); and password hashing uses built-in `node:crypto` scrypt, so `npm install` cannot fail on a platform prebuild. `pg` is the only dependency.

## What is deliberately NOT here

See `GATED.md`. Every gated area is blocked on a named unsigned decision from `TREK-BUSINESS-DECISION-REGISTER.md`. No placeholder, no guess, no "we'll fix it later" column.

**No money columns exist in this repo yet.** ST-03 (exact decimal type) is unsigned and effectively irreversible once data exists, so the identity and auth tables — which need no money — come first by design.

## Stack position

| Slot | Status here |
|---|---|
| Database | **PostgreSQL** — directed, signed |
| Password hashing | `node:crypto` scrypt. No native module, so no prebuild to fail on install |
| Authentication | **Work email + password** (AUTH-01) — directed, signed |
| ORM (ST-02) | **Avoided.** Raw SQL through `pg`. No ORM chosen, so no ORM to unpick |
| Backend framework (ST-02) | **Avoided.** Handlers are `(ctx) => response` plain functions; `src/http/server.js` is a ~60-line `node:http` adapter. Swap it for Fastify/Nest/Next route handlers without touching a handler |
| Session strategy (ST-06) | **Opaque token + server-side session — PROVISIONAL.** Implemented because auth cannot be built without a choice, and because JWT cannot satisfy the spec's instant-revocation-on-deactivation requirement. Confirm or override on signature |
| Frontend (Slot 1) | **Avoided.** Plain JS + plain CSS in `public/`, no build step — nothing to migrate off. PROVISIONAL; the files are the visual specification to port if React/Next is signed |
| Hosting, mail provider, storage | Env-var driven; no provider SDK committed. `src/mail/` has one adapter interface and one HTTP implementation that works with any REST relay |

## What is built

| Area | State |
|---|---|
| Password authentication (scrypt, single-use invite/reset links) | built |
| Sessions, principal resolution, deactivation cascade | built |
| Server-side authorization (matrix + single guard) | built |
| Audit — append-only, DB-enforced | built |
| Employee CRUD, roles, status, bulk import | built |
| Department + cost center master data | built |
| Frontend: login, profile, employees, departments, audit log | built |
| Everything else | gated — see `GATED.md` |

The frontend lives in `public/` and is served by the API server itself: no bundler, no CDN, no build step. `Content-Security-Policy` is `'self'` throughout, which is why there is no inline script.

Gated screens appear in the nav marked **gated** and, when opened, name the exact decision blocking them. They are never stubbed with placeholder data — a plausible-looking empty trip list would imply the feature works.

## Setup

```bash
cp .env.example .env      # fill in real values — never commit .env
npm install
createdb trek_dev         # or point DATABASE_URL at an existing instance
npm run migrate
npm run check             # bypass gate, then the test suites
npm run seed              # verifies seed state; prints the no-manager employees
npm run dev               # http://localhost:3000
```

## Migrations

Forward-only, versioned, applied by CI — never by hand against production.

```bash
npm run migrate           # apply all pending
npm run migrate:status    # what has run
```

Each file in `migrations/` runs once, inside a transaction, recorded in `schema_migrations`. There is no down-migration: a mistake in production is corrected by a new forward migration, the same rule the settlement spec applies to posted records.

Applied so far:

| File | Contents |
|---|---|
| `001_core_identity.sql` | `company`, `department`, `cost_center`, `employee`, `account`, `otp_challenge` (dropped by 004), `session` |
| `002_audit.sql` | `audit_event` — **with `REVOKE UPDATE, DELETE` and refusing triggers in the same migration** |
| `003_seed_master_data.sql` | Company, six departments + cost centers, pilot employees, accounts |
| `004_password_auth.sql` | Drops `otp_challenge`; adds `password_credential`, `password_reset_token`, `login_attempt` |

## Auth flow as implemented

```
POST /api/v1/auth/login               { email, password }
  → lockout checks (5 / email / 15 min, 50 / IP — stored in login_attempt, in Postgres)
  → resolve employee by lowercased work email
  → employee active AND account active?  no → 403 not_activated (identical message either way)
  → scrypt verify against password_credential.hash; mismatch → 401, attempt recorded
  → create session, 12h, opaque 256-bit token; store SHA-256 of token only
  → 200 { principal, expiresAt } + HttpOnly Secure SameSite=Lax cookie

POST /api/v1/auth/password/forgot     { email }
  → same response whether or not the account exists (no enumeration)
  → single-use link (SHA-256-hashed token, TTL'd) emailed via the mail driver,
    or printed by `npm run issue-password-link` when no driver is configured

POST /api/v1/auth/password/reset      { token, password }   ← invite or reset
POST /api/v1/auth/password/change     { currentPassword, newPassword }  ← signed in
POST /api/v1/auth/logout
```

The plaintext password and link token are never returned, logged, or persisted. `src/logging.js` redacts `code`, `token`, `password`, `secret`, `apiKey` and `authorization` from every log payload at the serializer, so it cannot leak through a stray `log.info(req.body)`.

## Authorization

`src/authz/permissions.js` is the permission matrix **as data** — one table, transcribed from `TREK-PERMISSIONS-SPEC.md`. `src/authz/guard.js` is the only place a decision is made.

Five rules, enforced there and nowhere else:

1. **Deny by default** — no grant, no access.
2. **Two-part check** — holds the permission *and* target is in scope.
3. **`team` = the reporting tree**, resolved by recursive CTE per request, never `department_id`.
4. **Out-of-scope returns 404, not 403** — so ids are not an enumeration oracle.
5. **A filter parameter is not authorization** — requesting a scope you lack is 403, never an empty list.

`test/authz.matrix.test.js` is table-driven and adversarial: for every protected operation it asserts employee A cannot reach employee B's record by id substitution.

## The no-bypass gate

```bash
npm run check:no-bypass
```

Fails the build on `devCode`, `bypass`, `skipAuth`, `mockUser`, `__dev`, `TEST_OTP`, `MASTER_CODE` or any hardcoded six-digit literal in `src/`. Wired into `.github/workflows/ci.yml` as a required check — it runs before tests, so a bypass cannot reach a deployable artifact even if someone adds one under time pressure.

`trek-data.js` in the design project contains `devCode` because the prototype had no relay. It is prototype-only and must never be imported here.

## Environments

`dev` · `staging` · `prod`. **Staging holds no real PII.** Secrets come from the platform's secret store into the process environment; `src/config.js` reads them once at boot, validates presence, and throws on a missing required key rather than starting half-configured. No secret is ever sent to a client — there is no client in this repo yet, and when there is, the only variables it may see are `APP_BASE_URL` and `APP_ENV`.

## Deployment foundation

`Dockerfile` is a two-stage build running as a non-root user, with `/healthz` (liveness, no DB) and `/readyz` (readiness, checks DB + migration state) for the platform to probe. HTTPS terminates at the platform edge; `src/http/server.js` sets HSTS and refuses to issue a session cookie without `Secure` unless `APP_ENV=dev`.

## Next

Stage 2 is complete for master data — employees, departments, cost centers, roles, status, bulk import, and the Admin UI over all of it.

Everything remaining is gated. Trip creation needs BD-06/BD-07, the policy engine needs BD-03/BD-04, approval needs BD-02/BD-09, expenses need BD-08, and every monetary column needs ST-03. See `GATED.md` for the mapping and `RUNBOOK.md` for the pilot test checklist.
