> **Updated 23 September 2026 — AUTH-01.** Sign-in is now **work email + password**. The emailed-code flow described in older versions of this file no longer exists. Vercel setup, first-admin creation, invites and reset: see **`DEPLOY.md`**.

# Trek — operations runbook

Everything needed to run Trek locally, stand up staging, and deploy production.

**Verified 25 September 2026:** migrations apply cleanly and the full suite passes 77/77 against a real PostgreSQL database. Two defects found by static review are already fixed: the bypass-check script matched the word "bypass" inside the comments promising there is no bypass (it now strips comments and matches identifiers), and password hashing uses built-in `node:crypto` scrypt so `npm install` cannot fail on a platform prebuild. `pg` is the only dependency.

---

## 1 · Local setup

```bash
cd trek-app
cp .env.example .env          # fill in values; .env is gitignored and never committed
```

Minimum `.env` for local work:

```
APP_ENV=dev
APP_BASE_URL=http://localhost:3000
DATABASE_URL=postgres://localhost:5432/trek_dev
DATABASE_SSL_MODE=disable
MAIL_DRIVER=console
LOGIN_EMAIL_DOMAINS=garageplug.com
```

```bash
createdb trek_dev
npm install
npm run migrate               # applies 001–004
npm run check                 # bypass gate, then the test suites
npm run seed                  # verifies seed state; prints the no-manager employees
npm run dev
```

Verify:

```bash
curl localhost:3000/healthz   # {"ok":true}
curl localhost:3000/readyz    # {"db":true,"migrations":true}

curl -X POST localhost:3000/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"ashishreddy@garageplug.com","password":"..."}'
```

Seeded accounts have no password until one is issued — use `npm run issue-password-link -- <email>` locally (prints the single-use set-password link to your terminal).

`MAIL_DRIVER=console` prints outgoing password-link emails to **server stdout** — not to the API response, not to a browser. It exists so local development does not need a relay. `config.js` refuses to boot with it when `APP_ENV` is staging or prod, and it cannot deliver to a real inbox, so **it cannot be used for the pilot test.**

Expected troubleshooting on first run: a missing `pgcrypto` extension (migration 001 creates it, but the database role needs permission), and `npm run check` needing a migrated database because both suites run against real tables.

---

## 2 · Environment variables

Names and purposes. **No values in source, ever.** Secrets come from the platform's secret store into the process environment; `src/config.js` reads them once at boot and throws on a missing required key rather than starting half-configured.

| Variable | Required | Notes |
|---|---|---|
| `APP_ENV` | no | `dev` (default) · `staging` · `prod` |
| `APP_BASE_URL` | yes | must be `https://` outside dev (enforced at boot) |
| `PORT` | no | default 3000; ignored on Vercel |
| `DATABASE_URL` | yes | pooled connection string; on Vercel use the **`trek_app`** role (see `scripts/create-app-role.sql`) |
| `DATABASE_URL_UNPOOLED` | for migrate | direct URL, migrations only — the runner prefers it over `DATABASE_URL` |
| `DATABASE_SSL_MODE` | no | default `require`; `disable` refused in prod |
| `DATABASE_POOL_MAX` | no | default 3 on Vercel, 10 elsewhere |
| `SESSION_COOKIE_NAME` | no | default `trek_session` |
| `SESSION_TTL_HOURS` | no | 12; may not exceed 12 in prod |
| `MAIL_DRIVER` | no | `resend` · `postmark` · `console` (dev only, refused otherwise) · `disabled` (default outside dev; warns at boot) |
| `MAIL_API_KEY` | if resend/postmark | **secret**; boot refuses without it when a real driver is selected |
| `MAIL_FROM_ADDRESS` | if resend/postmark | on the verified sending domain |
| `MAIL_FROM_NAME` | no | default `Trek` |
| `MAIL_STREAM` | no | Postmark stream |
| `LOG_LEVEL` | no | default `info` |
| `ERROR_LOGGING_DSN` | no | **secret**. Not audit logging — audit is a product feature in Postgres |
| `LOGIN_EMAIL_DOMAINS` | no | default `garageplug.com` (comma-separated) |
| `TREK_ALLOW_STAGING_RESET` | staging only | `yes` on staging. **Never set in production** |

Source of truth: `.env.example` and the validation in `src/config.js` — not this table.

Client-safe subset is exactly `APP_BASE_URL` and `APP_ENV`, exported explicitly from `config.js` as `publicConfig`. Nothing else can reach a browser.

**Gated — do not add until signed:** `STORAGE_*` (D-20), `OCR_PROVIDER_API_KEY` (D-24), `FX_RATE_*` (D-18).

---

## 3 · Database and migrations

Forward-only, versioned, applied by CI. Never by hand against production.

```bash
npm run migrate           # apply pending
npm run migrate:status    # applied / pending / modified-after-applied
```

Each file runs once inside a transaction and is recorded in `schema_migrations` with a checksum. **An already-applied file whose contents changed halts the run** — the database and the repository would otherwise disagree about history. Correct a mistake with a new forward migration; there is no down-migration, the same rule the settlement spec applies to posted records.

| File | Contents |
|---|---|
| `001_core_identity.sql` | company, department, cost_center, employee, account, account_identity, otp_challenge (dropped by 004), session |
| `002_audit.sql` | audit_event, **with `REVOKE UPDATE, DELETE` and refusing triggers in the same migration** |
| `003_seed_master_data.sql` | approved master data + pilot employees + accounts |
| `004_password_auth.sql` | drops otp_challenge; adds password_credential, password_reset_token, login_attempt |

No money columns exist yet — ST-03 is unsigned and irreversible once data exists, so identity and auth, which need no money, went first by design.

---

## 4 · Staging deployment

Requirements: HTTPS, PostgreSQL, real email (invite/reset links), secrets outside source, migrations, logging, health/readiness, no bypass, no mock login.

```bash
# 1 · Provision Postgres (e.g. Neon) and configure the least-privilege app role:
#     run scripts/create-app-role.sql as the owner in the SQL editor
# 2 · Provision app hosting (Vercel — see DEPLOY.md)
# 3 · Set the environment in the platform's secret store:
APP_ENV=staging
APP_BASE_URL=https://trek-staging.<your-domain>
DATABASE_URL=<staging connection string, trek_app role>
DATABASE_SSL_MODE=require
MAIL_DRIVER=resend            # or postmark
MAIL_API_KEY=<secret>
MAIL_FROM_ADDRESS=trek@<verified-sending-domain>
ERROR_LOGGING_DSN=<secret>
TREK_ALLOW_STAGING_RESET=yes

# 4 · Build and deploy
docker build -t trek:staging .
# push and deploy per the chosen platform

# 5 · Migrate, then seed  (owner/direct URL, run from a machine — the app never migrates)
npm run migrate
npm run seed:staging

# 6 · Verify
curl https://trek-staging.<your-domain>/healthz
curl https://trek-staging.<your-domain>/readyz
```

**Private access.** Staging must not be publicly reachable. Put it behind the platform's access control, an IP allowlist, or a VPN. The application's own domain allowlist (`LOGIN_EMAIL_DOMAINS`) means only `garageplug.com` addresses can sign in, but that is a second line, not the first.

**HTTPS** terminates at the platform edge. `src/http/server.js` asserts HSTS outside dev and refuses to issue a session cookie without `Secure`, so a misconfigured edge is visible rather than silent.

**Staging holds no real PII.** The seeded pilot employees are real colleagues with real work emails — that is necessary for sign-in testing and is the only real personal data staging should ever contain. No passports, no receipts, no documents.

### Staging URL

**Not provisioned.** I have no shell, no cloud account and no host, so I cannot deploy or issue a URL. The steps above are what someone with platform access runs. The blocking input is ST-01 and ST-07 — the database host and hosting platform are unsigned, so there is no platform to deploy *to* yet.

---

## 5 · Staging reset

```bash
npm run reset:staging -- --confirm
npm run seed:staging            # restore the standard dataset without touching the DB by hand
```

`reset:staging` has **five independent guards**, all of which must pass:

1. `APP_ENV` is exactly `staging`
2. `TREK_ALLOW_STAGING_RESET=yes`
3. `DATABASE_URL` does not contain `prod`, `production` or `live` — refused on the name alone
4. The database carries a `staging.marker` audit row, planted by `seed:staging`. **A production database will never have one, so this guard holds even if `APP_ENV` is set wrongly**
5. `--confirm` passed explicitly

What it does: deletes from an **explicit allowlist** of transactional tables, then rebuilds master data and pilot employees from `seed-staging.js` — one definition of the approved dataset, not a duplicate.

What it never does: drop or truncate a table · touch `schema_migrations` · touch `audit_event` (append-only and permanent; the immutability triggers would refuse it anyway) · operate on a table not in the allowlist.

The allowlist names tables that do not exist yet (trip, expense, settlement…) because they are gated. Listing them now means a reset does not silently skip one the moment it ships — an unlisted new table would survive a reset and poison the next test run. Missing tables are reported and skipped, not an error.

**There is deliberately no production equivalent of this command.** See §7.

---

## 6 · Pilot employees

Seeded by migration 003 and by `seed:staging`. Nine accounts; only Sales plus the four function roles are active.

| Code | Name | Dept | Grade | Manager | Roles |
|---|---|---|---|---|---|
| GP-0231 | Suresh Kumar | Sales | G4 | GP-0007 | employee |
| GP-0232 | Nadia Haddad | Sales | G3 | GP-0007 | employee |
| GP-0233 | Omar Farouk | Sales | G3 | GP-0007 | employee |
| GP-0234 | Meera Iyer | Sales | G4 | GP-0007 | employee |
| GP-0235 | Tom Whitfield | Sales | G3 | GP-0007 | employee |
| GP-0007 | Vikram Shetty | Sales | G6 | **none** | employee, manager |
| GP-0002 | Ravi Nambiar | Finance | G6 | none | employee, finance |
| GP-0004 | Sara Mansour | HR / Travel | G4 | none | employee, hr_travel |
| TEST-ADMIN | Ashish Reddy | Admin | G1 (test placeholder) | none | employee, admin (temporary) |

All on `CC-SLS-01` for Sales. Department head `head_id` = GP-0007, active.

**Login instructions for the pilot team:** open the staging URL, enter your `@garageplug.com` work email and your password. No password yet? Use the invite link your administrator sends (or ask them to run `npm run issue-password-link`). 5 failed attempts in 15 minutes locks the email temporarily — wait it out or reset your password. If you see *"Your account hasn't been activated yet"*, your account is not in the pilot; tell the administrator.

**Four employees have no manager**, Vikram Shetty among them. Once the approval-route guard is built, their own travel requests are correctly refused with `422 no_approval_route`. That is BD-02, unsigned.

---

## 7 · Production

Separate database, separate environment, separate secret store. No shared credentials with staging.

```bash
APP_ENV=prod
APP_BASE_URL=https://trek.<your-domain>
DATABASE_URL=<production connection string, trek_app role>   # must NOT contain 'staging'
DATABASE_URL_UNPOOLED=<owner/direct URL — migrate only, never set in Vercel>
DATABASE_SSL_MODE=require
MAIL_DRIVER=resend              # or postmark; 'disabled' works but every link needs the CLI
MAIL_API_KEY=<secret>
MAIL_FROM_ADDRESS=trek@<verified-sending-domain>
# TREK_ALLOW_STAGING_RESET is NOT SET. Ever.
```

```bash
npm run migrate     # migrations only
```

Production is seeded **once, by migration**, with approved master data and real employee accounts. `seed:staging` refuses to run when `APP_ENV=prod`, and refuses again if `DATABASE_URL` looks like production.

### Production safety controls

1. **No reset or wipe command exists for production.** `reset:staging` requires `APP_ENV=staging`, an opt-in variable production never sets, a non-production connection string, and a staging marker row production will never have.
2. **Build production without the reset scripts at all.** Add to the runtime stage of a production image, so the code is not merely guarded but absent:
   ```dockerfile
   RUN rm -f scripts/reset-staging.js scripts/seed-staging.js
   ```
3. **Audit is immutable at the database level** — `REVOKE UPDATE, DELETE` plus refusing triggers. There is no audit write endpoint at any privilege level, and no update or delete function in `src/audit.js`.
4. **Migrations are immutable once applied** — a changed checksum halts the run.
5. **An Admin cannot change their own roles** — no self-escalation. Enforced in the guard, tested in the suite.
6. **Deactivation is immediate and total** — employee inactive → account suspended → all sessions revoked. This requirement is why sessions are opaque and server-side rather than JWT.
7. **Boot-time refusals**: console mail driver outside dev, `sslmode=disable` in prod, non-HTTPS base URL outside dev, session TTL above 12h in prod, missing required variables.
8. **The bypass gate runs in CI before tests**, standalone, so a bypass cannot reach a deployable artifact even if the suite is green.
9. **Least-privilege database role** — the app connects as `trek_app`, created by `scripts/create-app-role.sql` (no `DELETE` beyond session/token/attempt tables, no `UPDATE` on `audit_event`), not as owner or superuser. The owner URL is for migrations only.
10. **Separate secret stores** per environment; no `.env` committed (CI has a check).

---

## 8 · End-to-end pilot test checklist

Run in order, on staging, with no developer intervention. **If a step fails, it is a blocker — do not simulate success.**

**Buildable and testable now:**

- [ ] Invite/reset link arrives **by email**, real inbox, under 15 seconds
- [ ] Link token is not in the API response, not in any log, not on any screen
- [ ] Unknown email, unset password and wrong password all return the **identical** 401
- [ ] 5 failures in 15 minutes lock the email; the message names the wait; a reset unlocks
- [ ] Expired or already-used link is refused
- [ ] Login lands on the right screen — Admin on Employees, everyone else on their profile
- [ ] Inactive employee with the correct password gets the activation notice (403), not a session
- [ ] Profile shows name, department, cost center, manager, grade, roles
- [ ] Profile saves a contact number; department/grade/roles are not editable there
- [ ] An employee with no manager sees the BD-02 notice on their profile
- [ ] Admin → Employees lists, searches and filters by department and status
- [ ] Admin adds an employee; every validation message fires inline
- [ ] Duplicate employee code reads *"Already used by Suresh Kumar"*
- [ ] Self-reporting reads *"An employee cannot report to themselves"*
- [ ] Role chips save through their own endpoint and audit as `role.assign`
- [ ] Bulk import validate-first reports per row; a bad row does not block a good one
- [ ] Unknown department reads *"create it first"*; unknown manager *"import them first"*
- [ ] Admin → Departments lists cost centers, heads and active employee counts
- [ ] Creating a department creates its cost center in the same action
- [ ] Deactivating a department with active employees reads *"Move its active employees first"*
- [ ] Nav shows gated screens as **gated**, each naming its blocking decision — no fake data
- [ ] Suresh cannot read Nadia's record by substituting her id — **404, not 403**
- [ ] A nonexistent id and an out-of-scope id return byte-identical errors
- [ ] Vikram can read his five reports; cannot read Ashish
- [ ] Requesting `scope=all` without the permission is 403, not an empty list
- [ ] An Admin cannot change their own roles
- [ ] Deactivating an employee revokes their sessions immediately
- [ ] Audit log shows every action with actor, timestamp, previous state, new state
- [ ] `UPDATE`/`DELETE` on `audit_event` is refused by the database
- [ ] `npm run reset:staging -- --confirm` → clean state; migrations and audit intact
- [ ] The same command refuses with `APP_ENV=prod`, and refuses without the marker

**Blocked — cannot be tested until the named decision is signed:**

- [ ] Create travel request — **BD-06, BD-07** (no band master data, no country code to resolve it from)
- [ ] Server-side policy evaluation — **BD-03, BD-04, ST-03**
- [ ] Submit request → manager approval / send back — **BD-02, BD-09**
- [ ] Booking / travel status — depends on trip
- [ ] Expense creation, receipt upload, submission — **BD-08, ST-03, D-20**
- [ ] Finance review — depends on expense
- [ ] Advance / settlement — **ST-03**

---

## 9 · Exact remaining blockers

**Signatures — nothing downstream can start without these:**

| Decision | Blocks | Owner |
|---|---|---|
| **BD-08** category & payment-mode vocabulary | the entire expense table | Finance Controller |
| **BD-06 / BD-07** band master data, `trip.country_code` | trip creation, all policy evaluation | Eng lead + Finance |
| **BD-02** fallback approver | approval chain; Vikram cannot file a trip | CEO / Head of People |
| **BD-09** `department_head` resolution | approval chain step 2 | Head of People |
| **BD-03** Europe policy limits | policy engine | Finance Controller |
| **BD-04** Dubai meal cap | policy engine, capture UX | Finance Controller |
| **ST-03** money type | every monetary column. **Irreversible after data exists** | Eng lead + Finance |
| **ST-04** tenancy | every table and query. Near-free now | Business |
| **ST-01 / ST-02** DB host, ORM | nothing in code — `pg` + raw SQL keeps both open | Eng lead |
| **ST-05 / ST-06** auth build-vs-buy, session strategy | already implemented provisionally; confirm or override | Eng lead |

**Infrastructure — needs someone with platform access:**

| Item | Blocks |
|---|---|
| **D-01** mail relay | the pilot's hard gate at step 1. No provider credential exists |
| Hosting platform + database instance | the staging URL |
| **D-20** object storage: region, encryption, access logging, retention | receipt upload, document upload |
| **D-18** FX rate source and which date's rate applies | every base-amount computation |
| **D-24** OCR provider | receipt scanning |
| **D-35** scheduled jobs runner | trip goes active on its start date; hold expiry; SLA escalation |

**On the 20 September target.** Login, profile, authorization and audit are written and can be running on staging as soon as a platform and a relay exist — that part is days of work, not weeks. Everything else on the pilot list is blocked behind six unsigned decisions, and four of them shape the database schema. The signature page is the critical path, not the code.
