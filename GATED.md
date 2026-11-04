# Gated areas — do not implement

Each area below is blocked on a named unsigned decision in `TREK-BUSINESS-DECISION-REGISTER.md`. **Do not guess, do not stub with a placeholder column, do not "decide provisionally and fix later."** Two of these are irreversible once data exists.

Anything not listed here and not present in the repo is simply a later stage, not gated.

---

## Blocked on ST-03 — money type

**Every monetary column in the system.**

`NUMERIC(14,2)` vs integer minor units is **effectively irreversible after data exists.** No table in this repo carries a money column, which is why the identity and auth stage could proceed at all.

Blocks: `trip.estimate_base`, all of `expense`, all of `advance`, all of `settlement`, `policy.limit`.

**When signed:** add the type to `src/db/types.js` as a single named helper used by every migration. One definition, referenced everywhere — never repeated per column.

## Blocked on ST-04 — tenancy

**Whether every table carries `company_id`.**

Near-free now, very expensive later — it touches every table, every query and every authorization check. This is a product question (is Trek ever sold externally?), not an engineering one.

Current state: `001_core_identity.sql` creates a single `company` row and every table already carries `company_id` **as a nullable column with no scoping enforced.** That is the cheap hedge: if single-tenant is signed, the column drops in one migration; if multi-tenant is signed, it becomes `NOT NULL` and the guard gains a tenant clause. Neither path requires a rewrite.

## Blocked on ST-01 / ST-02 — host and ORM

Not blocking code, but blocking decisions that shape the deploy. `pg` + raw SQL was chosen precisely so this stays open: no ORM to migrate off. If an ORM is signed later, the SQL in `src/**/queries.js` is the specification to port.

## Blocked on ST-05 — auth build vs buy

`src/auth/` implements the password flow directly (AUTH-01), because the flow was fully specified and provider-agnostic. If a provider is signed instead, `src/auth/password.js` and `src/auth/session.js` are replaced; `src/auth/principal.js` survives unchanged — the employee record stays the source of identity either way.

## Blocked on ST-06 — session strategy

Implemented as **opaque token + server-side session, PROVISIONAL**. Reason on the record: the permissions spec requires that deactivating an employee revokes sessions immediately, and JWT cannot do that without a denylist that reintroduces the lookup JWT exists to avoid.

If JWT is signed instead, `src/auth/session.js` changes and the deactivation cascade in `src/employees/deactivate.js` must gain a denylist. **Multi-device is also unsigned (D-08)** — the current implementation allows multiple concurrent sessions per employee, all revoked together on deactivation, which is the spec's requirement rather than the prototype's one-session behaviour.

---

## Blocked on BD-08 — expense category & payment mode vocabulary

**The entire `expense` table.**

The mobile and console prototypes use different vocabularies. Reporting rolls up by category, so the two would produce different numbers from the same data. This is not a naming preference — it is the enum on the highest-volume table in the system.

Also blocks: BD-05's final sub-item (which category value "metro and taxi" maps to for the SAR 25 receipt waiver).

## Blocked on BD-06 / BD-07 — band master data & `trip.country_code`

**`destination_band`, `country_band`, `trip.band_id`, `trip.country_code`.**

Server-side band resolution is a stated requirement and has no key to join on: `country` is currently `destination.split(', ')[1]`, a string fragment that cannot be reliably joined. Until signed, the policy engine cannot select which limits apply.

`DATA-MODEL.md` carries this as a clearly-marked *pending correction* section. **The model itself has not been edited.**

## Blocked on BD-02 / BD-09 — fallback approver & `department_head` resolution

**Approval chain construction, and `has_approval_route` validation.**

Six of sixteen seeded employees have no manager, **including Vikram Shetty (GP-0007) — the Sales pilot's own approver and also a traveller.** Once the route guard exists, his own trip is correctly refused at submission.

BD-01 (the `422 no_approval_route` guard) needs no business signature and **will be built regardless** of which route BD-02 picks — it is the property that prevents a chain stalling silently. It cannot be *tested* end to end until BD-02 gives at least one null-manager employee a route.

## Blocked on BD-03 — Europe policy limits

**Policy records for the `EUROPE` band.**

The band itself is directed and agreed; the three limit values (airfare return, hotel per night, local+meals per trip), the grades they apply to, and the unmatched-scope fallback (D-45) are open. They are Finance numbers and cannot be inferred — the seeded Paris trip's SAR 7,400 says what was spent, not what was permitted.

## Blocked on BD-04 — Dubai meal cap

**Whether a per-meal policy record exists.**

The mobile UI displays "SAR 90 meal cap" with no rule behind it. Advisory-guidance vs real-limit is unsigned. The fixed constraint either way: **the UI must not display a limit with no underlying rule.**

---

## Signed and implemented

**BD-05 — SAR 25 receipt waiver.** The receipt requirement is waived; the financial treatment is not. `spent_base` will be the plain sum of every filed expense's base amount, with no exclusion set, and **no `excluded_from_envelope` column is to be added — not adding it is part of the decision.** Recorded in `src/policy/RULES.md` for the stage that implements it.

---

## PROVISIONAL choices

Implemented because the code could not exist without a choice. Each is marked in the file itself with its blocking reference; confirm or override on signature.

| Choice | Blocking decision | Reasoning |
|---|---|---|
| Opaque token + server-side session | **ST-06** | The permissions spec requires that deactivating an employee revokes sessions immediately. JWT cannot do that without a denylist that reintroduces the lookup JWT exists to avoid. `src/auth/session.js` |
| Multiple concurrent sessions per employee, all revoked together | **D-08** | The spec requires travellers to use a phone and a laptop; the prototype allowed one session. `src/auth/session.js` |
| Plain JS + plain CSS frontend, no build step | **Slot 1** | Same reasoning as raw SQL for ST-02: nothing to migrate off. `public/app.js`, `public/styles.css` are the visual specification to port if React/Next is signed |
| `node:crypto` scrypt for password hashing | — | No business content. Avoided a native argon2 module that risked failing `npm install` on a platform prebuild |
| Random `emp_NNNN` internal ids | — | Matches the approved dataset's shape. Business refs (`TRK-`, `EXP-`) need gapless sequences — that is **D-07**, and belongs to tables that do not exist yet |

---

## Blocked on infrastructure, not decisions

| Item | Decision |
|---|---|
| Mail relay live | **D-01** — the pilot's hard gate at step 1. `src/mail/` has the adapter; no provider credential exists |
| Object storage | **D-20** — region, encryption, access logging and retention for passports and receipts are undefined. No storage code committed |
| FX rate source | **D-18** — provider, and *which date's* rate applies. Blocks every base-amount computation |
| OCR provider | **D-24** |
| Scheduled jobs | **D-35** — no runner. Pilot step 7 (trip goes active on its start date) is untestable without one |
| Payroll export | **D-19** |


---

## AUTH-01 — 23 September 2026

Passwordless OTP has been removed. Sign-in is work email + password, directed by the product owner (see the register). OTP files deleted: `src/auth/otp.js`, `src/auth/code-hash.js`, `src/http/rate-limit.js`. Schema change is in forward migration `004_password_auth.sql`; 001–003 are untouched.

| PROVISIONAL | Blocking decision | Where |
|---|---|---|
| Password rules, lockout, reset-link lifetime | **BD-10** | `src/auth/password-policy.js`, `src/auth/password.js` (LOCKOUT, LINK_TTL_MINUTES) |
| First password via an emailed single-use invite (3 days); CLI fallback | **BD-11** | `src/auth/password.js` sendInvite, `scripts/issue-password-link.js` |
| Email provider: Resend / Postmark | **Slot 5** | `src/mail/index.js` |
| Database host: Neon | **ST-01** | `DEPLOY.md` |
| Lockout counters in Postgres, not Redis | none: serverless has no shared memory | `login_attempt` |

**Not built, pending BD-11:** showing an invite link to the Admin on screen, and temporary passwords typed by an Admin.

**D-01 (mail relay) is no longer a sign-in blocker.** It is still needed for self-service password reset and invite emails. With `MAIL_DRIVER=disabled`, operators issue links from the command line.
