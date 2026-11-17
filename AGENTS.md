# AGENTS.md — AI Agent Guidance & Operating Invariants

This file provides non-negotiable architectural rules, domain patterns, and operational guardrails for autonomous AI coding agents (and human engineers) working in this repository.

---

## 1. Prime Invariants (Never Violate)

### 1.1 Strict Ground Truth & Zero Hallucination
* **NEVER invent or fabricate database records, IDs, endpoints, or environment variables.** If a record, table, or document does not exist, explicitly state: *"This does not exist in the database/codebase."*
* Never treat citations in comments (e.g. references to uncommitted `.md` specs) as proof of approved business rules unless the actual document exists in the git tree.

### 1.2 Exact Money Handling (No Floating-Point Math)
* **Never use IEEE-754 floating-point numbers (`Number.parseFloat`, `Math.round`, etc.) for financial calculations.**
* Money columns in PostgreSQL must be **`NUMERIC(14,2)`**. Exchange rates are `NUMERIC(20,8)`.
* In JavaScript, monetary values are validated and passed as **exact string decimals** matching `/^\d+(\.\d{1,2})?$/`.
* Use **`src/money.js`** for every money operation. It works in BigInt minor units, rounds half-up like Postgres `NUMERIC`, and is the only place arithmetic on money belongs.
* Always preserve the original transaction currency (e.g. `USD`, `EUR`, `AED`). **Rates are remembered in `exchange_rate` snapshots, never auto-fetched during spending transactions.** Reference rates can be synchronized on demand from the European Central Bank feed (`POST /api/v1/exchange-rates/sync`) or recorded manually by Finance, and a rate must never be applied twice.
* **Every conversion is a snapshot.** Store `rate_to_base` and `base_amount` with the row. A later rate change must never rewrite money that was already budgeted, spent or issued.
* **The base currency is a setting, not a constant.** It is `company.base_currency`, read from the database (`src/currency/service.js`). It was once a hardcoded `'INR'` in two files and a dead `'SAR'` in the database — a constant in two places is how they drift apart.
* **A remembered rate is a default to offer, never a rewrite.** `exchange_rate` holds one rate per pair per day. Recording a rate changes no booked money.
* **Conversion truncates, never rounds.** A converted amount must never exceed the money it came from.
* **Showing money in another currency changes nothing.** A report asked for a display currency produces a second number beside each stored one, with the rate and its effective date. The stored amounts do not move. A currency with no remembered rate produces **no number**, and says why.

### 1.3 Atomic, Immutable Audit Logging
* Every state-changing action (create, update, submit, decide, deactivate, role assign) **must write an audit event in the same transaction as the change**.
* Use `src/audit.js` &rarr; `audit(client, { action, entityType, entityId, previousState, newState, ... })`.
* The `audit_event` table is physically append-only in PostgreSQL via triggers rejecting `UPDATE` and `DELETE`.

### 1.4 Centralized, Deny-by-Default Server Authorization
* Handlers **never** perform bespoke inline role checks (e.g. `if (user.role === 'admin')`).
* All operations must be declared in [`src/authz/permissions.js`](src/authz/permissions.js) and checked via `authorize()` in [`src/authz/guard.js`](src/authz/guard.js).
* **The team tier and the company tier are different permissions.** If a scope map names the same permission for `team` and `all`, every holder of it gets company-wide authority — a manager ends up approving anyone. `trip.approve` vs `trip.approve.all`, `expense.approve` vs `expense.approve.all`. See `docs/AUTHORIZATION_AND_SECURITY.md` §2.2.
* **Opaque Denial**: Out-of-scope reads on individual IDs must return **`404 Not Found`**, byte-identical to a non-existent ID, preventing ID enumeration.
* **Self-Forbidden**: Users cannot approve their own requests or escalate their own roles (`selfForbidden: true`).
* **The UI is not a control.** Hiding a button is a convenience; the API must refuse independently.

### 1.5 Reporting Tree Scoping
* Approvals and team visibility follow the **transitive reporting hierarchy** resolved via recursive CTE, not department codes or office locations.
* Submissions must fail with `422 Unprocessable Entity` (`code: "no_approval_route"`) if the employee has no active reporting manager.

### 1.6 Forward-Only Migrations
* Applied migrations (`migrations/001` through `013`) are **immutable**.
* Schema modifications must be written as new forward migrations (e.g. `migrations/014_...`).
* Never run integration tests on the production/staging Neon database. Test databases must end in `_test`.

### 1.7 Zero-Framework Philosophy
* Stack is strictly **Node.js (>=20)** and **`pg` (node-postgres)**.
* Do not introduce ORMs (Prisma, Drizzle, TypeORM), HTTP frameworks (Express, Fastify, Nest), or frontend build toolchains (Webpack, Vite). The frontend is pure vanilla JavaScript (`public/app.js`), semantic HTML, and CSS.

### 1.8 The Workflow Is Enforced Server-Side
* The state machine lives in **one table** in `src/trips/service.js`, not spread across routes: `draft → submitted → approved → active → reconciliation_pending → reconciled → closed`, with `changes_requested` and `rejected` branches.
* An out-of-order transition is refused with `409 invalid_transition` no matter what the client offers.
* Money may be recorded against an `approved` or `active` trip — funds need not be issued first — and a reconciliation may only be computed when nothing is still awaiting approval.

### 1.9 The Frontend Is Not Allowed to Go Stale
* `public/app.js` and `public/styles.css` are **not fingerprinted**, so they are served `no-cache, must-revalidate`. A cached script outlives the deploy that replaced it and runs against a newer API.
* Never add a manual `?v=2` cache-buster to the HTML — it is forgotten at the next deploy. The header does the job.
* `test/pilot.frontend.test.js` asserts both.

### 1.10 The Manual Is Part of the Product
* `public/manual.js` is a classic script (no `export`, no `import`) — it is loaded with a plain `<script>` tag before `app.js`. An ES module export there is a syntax error that takes the whole app down.
* It is **kept true by a test**, not by discipline: `test/manual.test.js` asserts that every error message the manual quotes is really produced by the code, that every state it lists exists in the schema, that every screen it names exists in the app, and that every permission named in its capability table is real — and that no permission in the matrix is missing from it.
* **The "who can do what" table and the capability catalogue are drawn from the matrix at run time**, from `GET /api/v1/permissions/matrix` — which reads the same `src/authz/permissions.js` the guard reads. They are not copies somebody has to remember to update.
* **The catalogue is COMPLETE, and the test proves it.** Every operation the server enforces must be named by a capability, and every permission that reaches nothing must be listed as reserved. A new endpoint without a manual entry, or a permission that quietly reaches nothing, fails the build.
* **So: if you change a message, a state, a screen, a permission or an endpoint, the manual changes with it, or the build fails.** That is the point — a help system that drifts is worse than none, because people trust it.

### 1.11 No Demo People, Anywhere
* The seed (`migrations/003_seed_master_data.sql`) contains **master data and the two real administrators. Nothing else.** No roster of illustrative employees — not even obviously-fictional ones. A name in a seed file is a name the team may later meet in production.
* Test fixtures live in `scripts/seed-test.js`, never in a migration, and use the reserved `garageplug.test` domain. The runtime allowlist is `garageplug.com` alone, so a fixture account cannot sign in to a deployment even if a row were copied across.
* `scripts/seed-test.js` refuses any database whose name does not end in `_test`. Keep that guard.
* **To clear a database that already carries demo rows, rebuild it** (`scripts/recreate-app-db.js`): `audit_event` is append-only, so the seed-era rows cannot be deleted by any role.

### 1.12 The Nav Offers What The Permissions Allow
* The client decides which screens to exist by checking permission strings; the server decides what those strings grant. **When they disagree the failure is silent** — the API answers 403 while the person is told the screen does not exist.
* `trip.approve` (a manager's team tier) and `trip.approve.all` (the company tier) are different permissions on purpose. A nav gate must check **both**, or it hides Approvals from exactly the admins and finance users who can use it. That was a real bug: the Approvals screen was missing for anyone who was not a direct manager.
* `test/nav.permissions.test.js` reads the real client and the real matrix and fails if the two drift apart. It is why the Approvals screen is offered to admin, finance and manager — and to nobody else.
* `scripts/ui-smoke.mjs` renders the real client against a running deployment and walks every screen for every role. It needs happy-dom, which is deliberately **not** a dependency of this project; install it separately and point `TREK_UI_HARNESS` at it.

### 1.13 The Currency Registry Is The One List
* The currencies Trek knows about live in the `currency` table and are served by `GET /api/v1/currencies`. **Both currency pickers in the client are drawn from that list** — a list typed into a dropdown is a list that drifts.
* `src/currency/service.js` owns the registry, the remembered rates, and conversion. `rateFor`, `reciprocalRate`, `convertForDisplay` and `sumAcrossBases` live there and nowhere else.
* A rate row says how many units of `to_code` one unit of `from_code` buys. The trip's currency plan stores the inverse. `rateFor` reads either way round and inverts exactly, in minor units — a reciprocal of an 8-decimal rate is not an 8-decimal number.
* Only Finance and Admin may record a rate (`rate.manage`). Everybody may read the rates that are known.

### 1.14 The Dashboard Is The Front Door
* Everyone lands on the dashboard after signing in, and everybody can see it: **every role holds `trip.read.own`**, which resolves `dashboard.read` to the `own` scope for someone with no wider grant, and to the wider scope for someone who has one.
* The dashboard is three things in order: the headline numbers, **what needs you now**, and the recent trips. The task counts come from the same rows as the tiles — never a second, disagreeing count.
* The scope is the server's decision. The client never asks for a wider scope than it was granted.

### 1.15 The Design System Is CarbonCN
* Trek's interface is built on **CarbonCN** — the design system used across GaragePlug's products. `public/styles.css` carries its tokens: the spacing scale (`--carbon-01` … `--carbon-10`, the 8px grid), the type scale, the motion curves (`--motion-productive`, `--motion-expressive`), and the focus behaviour.
* **The colours are Trek's own and they do not change.** They are carried by Carbon's semantic token names (`--interactive`, `--text-primary`, `--border-subtle-01`, `--support-error`), so every colour is named once and referred to by role.
* **Zero radius.** Carbon has no rounded corners (`--radius: 0px`). Only true circles (avatars, status dots) use `50%` or `var(--radius-full)`.
* **No inline styles.** Every value lives in a class — a utility named after its token (`.mt-carbon-06`, `.type-body-01`, `.text-secondary`). A style attribute is a value that bypasses the design system, and there are none left in `public/app.js`.
* The typefaces are IBM Plex Sans (weights 300, 400, 500, 600) and IBM Plex Mono, self-hosted in `public/fonts/` — the app must not call a third party to render a page.
* A utility class name always reads back onto the grid: `.mb-carbon-07` is 32px, because that is what `--carbon-07` is.
* **Every class the client uses must exist in the stylesheet.** `test/pilot.frontend.test.js` checks every `class="…"` in the client against the CSS. A class that does not exist is not an error — the browser drops the declaration and the element quietly looks wrong, which is how `.font-mono` and `.py-carbon-02` shipped.

### 1.16 A Dialog Is A Dialog
* Every overlay — drawer, modal, the manual, the camera scanner — carries `role="dialog" aria-modal="true"` and **must** do all three of Carbon's modal things: the focus moves in, it is trapped while the overlay is open, and it returns to the trigger when the overlay closes.
* `trapFocus(dialog)` in `public/app.js` does all three and returns a `release` function. Call it when the overlay closes — otherwise the focus is stranded on a button that no longer exists.
* Escape closes the topmost overlay. It must go through that overlay's own close, never `element.remove()` — removing the node skips the listener cleanup and the focus release.
* The camera scanner holds a real device stream. It is stopped when the scanner closes **and** when a 401 ends the session. A scanner left running keeps the camera light on, and the person never learns why.

### 1.17 The Principal Cache Is Bounded and Swept
* The server caches resolved principal records in memory (`src/auth/session.js`) with a 15-second TTL and a hard cap of 500 entries (sweeping expired and oldest entries when full).
* **Invalidation is strictly mandatory on reporting-line changes.** The manager role is implicit (granted dynamically to anyone with ≥1 active direct report). Any change to an employee's `manager_id` or active status in `src/employees/service.js` must call `invalidatePrincipalCache()` on both the old and new manager — otherwise approval rights remain frozen for up to 15 seconds. Invalidation must also fire on logout, role changes, and password changes.

### 1.18 The Client Request Cache Is Bounded by Mutations and Sign-in
* The frontend client (`public/app.js`) caches GET requests in-memory for 10 seconds and deduplicates concurrent in-flight requests.
* **Every mutation (POST, PATCH, PUT, DELETE) clears the client request cache immediately.**
* **Every "Refresh" button must call `api.clearCache()` before reloading.** A refresh button that only invokes `load()` is a no-op within the 10-second cache window.
* The login POST clears the cache so data never crosses a user boundary.

### 1.19 Never Hold a Database Connection Across an External Network Call
* External HTTP fetches (such as European Central Bank exchange-rate feeds) must happen **outside** database transactions.
* On serverless platforms (e.g. Vercel), connection pools are tightly constrained (`DATABASE_POOL_MAX` defaults to 3). Holding an open connection or transaction while awaiting third-party HTTP responses starves the pool and leads to 500 errors across concurrent requests. Always fetch and validate payloads first, then open a minimal `tx()` only for the database writes.

---

## 2. Project Layout & Architecture Map

```text
├── api/
│   └── [...path].js            # Vercel serverless entry point
├── docs/                     # Comprehensive architectural & API documentation
│   ├── ARCHITECTURE.md       # Runtime topology and execution lifecycle
│   ├── DATA_MODEL.md         # PostgreSQL tables, ER diagram, constraints
│   ├── API_REFERENCE.md      # REST endpoint reference & error dictionaries
│   ├── AUTHORIZATION_AND_SECURITY.md # Permission matrix & scoping rules
│   └── DEVELOPMENT_AND_TESTING.md    # Local setup and test guides
├── migrations/               # Sequential forward-only SQL migrations (001 - 013)
├── public/                   # Vanilla frontend client (no build step)
│   ├── app.js                # Single-page UI application logic & views
│   ├── manual.js             # The in-app manual (workflow, capabilities, screens, messages)
│   ├── index.html            # Application shell
│   ├── fonts/                # IBM Plex Sans & Mono (self-hosted)
│   └── styles.css            # CarbonCN tokens, the 8px grid, type, motion, components
├── scripts/                  # Administrative and deployment scripts
│   ├── migrate.js            # Transactional migration runner
│   ├── seed-test.js          # Test-only fixture loader (refuses a non-_test DB)
│   ├── recreate-app-db.js    # Rebuilds a database from migrations, keeping password hashes
│   ├── issue-password-link.js# One-time password token generator
│   ├── ui-smoke.mjs          # Renders the real client against a running deployment
│   └── check-no-auth-bypass.sh # Security scanning script
├── src/                      # Backend application source
│   ├── audit.js              # Immutable audit writer & vocabulary
│   ├── config.js             # Validated boot-time configuration
│   ├── db.js                 # PostgreSQL connection pool & tx() helper
│   ├── money.js              # Exact decimal money arithmetic (BigInt minor units)
│   ├── auth/                 # Scrypt hashing, sessions, passwords
│   ├── authz/                # Centralized permission guard & matrix
│   ├── currency/             # Currency registry, remembered rates, conversion
│   ├── employees/            # Employee directory & reporting services
│   ├── trips/                # Trips, budget, currency plan, funds, reconciliation
│   ├── expenses/             # Expenses domain service & validation
│   ├── bills/                # Receipt upload & retrieval
│   ├── reports/              # Dashboard aggregation & CSV export
│   └── http/                 # Route handlers & HTTP server
│       ├── app.js            # Dispatcher, routing table & error handler
│       ├── server.js         # Standalone HTTP server for local/containers
│       ├── routes.auth.js    # Authentication endpoints
│       ├── routes.admin.js   # Employee/department admin endpoints
│       ├── routes.trips.js   # Trips CRUD, submit & decide routes
│       ├── routes.expenses.js# Expenses CRUD, submit & decide routes
│       ├── routes.currency.js# Currency registry & remembered rates
│       ├── routes.permissions.js # The matrix the manual is drawn from
│       └── routes.pilot.js   # Budget, funds, bills, reconciliation, reporting
└── test/                     # Node native test runner test suites
    ├── audit.immutability.test.js
    ├── authz.matrix.test.js  # Adversarial authorization tests
    ├── currency.test.js      # Rates, reciprocals and conversion
    ├── currency.http.test.js # The registry & reading a report in another currency
    ├── employees.test.js
    ├── manual.test.js        # The manual must stay true
    ├── nav.permissions.test.js# The nav must offer what the matrix allows
    ├── password.test.js
    ├── seed.cleanliness.test.js # No demo people in the seed
    ├── trips.expenses.test.js# Domain & negative tests
    ├── trips.http.test.js    # Real HTTP network integration tests
    └── pilot.frontend.test.js # The client's contract with the server
```

---

## 3. Recipe Guide for Common Changes

### 3.1 Adding an HTTP Endpoint
1. Define route and method in `src/http/app.js` (`ROUTES` array).
2. Create handler in relevant `src/http/routes.*.js`.
3. Register the operation in [`src/authz/permissions.js`](src/authz/permissions.js) under `OPERATIONS` with required scopes and permissions.
4. Authorize in handler:
   ```javascript
   const { scope, team } = await authorize(ctx.db, ctx.principal, 'operation.name', target, ctx.requestId);
   ```
5. If accepting client payload, filter client-derived values using `rejectServerDerived(ctx.body, exceptList)`.
6. **Resolve the scope target to the record's OWNER** (the trip's `employee_id`, the expense's `employee_id`), not to `undefined`. A target of `undefined` never matches the `own` branch, so the person the operation is *for* is refused their own operation.
7. Add the client call to `public/app.js` and let `test/pilot.frontend.test.js` prove the route exists.

### 3.2 Performing Database Mutations
Always wrap mutations and their corresponding audit events in a transaction:
```javascript
import { tx } from '../db.js';
import { audit, ACTIONS } from '../audit.js';

return tx(async (client) => {
  const row = await client.one('UPDATE ... RETURNING *', [...]);

  await audit(client, {
    actorId: actor.employeeId,
    actorLabel: actor.name,
    action: ACTIONS.SOME_ACTION,
    entityType: 'entity',
    entityId: row.id,
    previousState: oldState,
    newState: newState,
    detail: 'Human readable explanation',
    requestId,
  });

  return row;
});
```

### 3.3 Adding a Migration
1. Name next sequential file (e.g. `migrations/014_feature_name.sql`).
2. Write idempotent SQL.
3. Apply locally: `npm run migrate`.
4. Check status: `npm run migrate:status`.
5. **Grant the runtime role** on any new table (see `scripts/create-app-role.sql`), or the app will fail with `permission denied` in production while working locally as the owner.

### 3.4 Running Verification
Before declaring a task done:
```bash
# 1. Security scan
npm run check:no-bypass

# 2. Run full test suite (requires local Postgres database ending in _test)
DATABASE_URL=postgres://localhost:5432/trek_test DATABASE_SSL_MODE=disable APP_ENV=dev APP_BASE_URL=http://localhost:3000 LOGIN_EMAIL_DOMAINS=garageplug.com,garageplug.test npm test
```

### 3.5 Verifying in the browser
A green suite is necessary, not sufficient. **Click the flow yourself** — the tests cannot see a stale cached script, a button the API would refuse, or a modal with the wrong label. Every defect in §1.9 and §4.5 of the authorization doc was found by clicking, not by reading.
