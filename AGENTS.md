# AGENTS.md — AI Agent Guidance & Operating Invariants

This file provides non-negotiable architectural rules, domain patterns, and operational guardrails for autonomous AI coding agents (and human engineers) working in this repository.

---

## 1. Prime Invariants (Never Violate)

### 1.1 Strict Ground Truth & Zero Hallucination
* **NEVER invent or fabricate database records, IDs, endpoints, or environment variables.** If a record, table, or document does not exist, explicitly state: *"This does not exist in the database/codebase."*
* Never treat citations in comments (e.g. references to uncommitted `.md` specs) as proof of approved business rules unless the actual document exists in the git tree.

### 1.2 Exact Money Handling (No Floating-Point Math)
* **Never use IEEE-754 floating-point numbers (`Number.parseFloat`, `Math.round`, etc.) for financial calculations.**
* Money columns in PostgreSQL must be **`NUMERIC(14,2)`**.
* In JavaScript, monetary values are validated and passed as **exact string decimals** matching `/^\d+(\.\d{1,2})?$/`.
* Always preserve the original transaction currency (e.g. `USD`, `EUR`, `SAR`). Do not invent conversion rates.

### 1.3 Atomic, Immutable Audit Logging
* Every state-changing action (create, update, submit, decide, deactivate, role assign) **must write an audit event in the same transaction as the change**.
* Use `src/audit.js` &rarr; `audit(client, { action, entityType, entityId, previousState, newState, ... })`.
* The `audit_event` table is physically append-only in PostgreSQL via triggers rejecting `UPDATE` and `DELETE`.

### 1.4 Centralized, Deny-by-Default Server Authorization
* Handlers **never** perform bespoke inline role checks (e.g. `if (user.role === 'admin')`).
* All operations must be declared in [`src/authz/permissions.js`](src/authz/permissions.js) and checked via `authorize()` in [`src/authz/guard.js`](src/authz/guard.js).
* **Opaque Denial**: Out-of-scope reads on individual IDs must return **`404 Not Found`**, byte-identical to a non-existent ID, preventing ID enumeration.
* **Self-Forbidden**: Users cannot approve their own requests or escalate their own roles (`selfForbidden: true`).

### 1.5 Reporting Tree Scoping
* Approvals and team visibility follow the **transitive reporting hierarchy** resolved via recursive CTE, not department codes or office locations.
* Submissions must fail with `422 Unprocessable Entity` (`code: "no_approval_route"`) if the employee has no active reporting manager.

### 1.6 Forward-Only Migrations
* Applied migrations (`migrations/001` through `006`) are **immutable**.
* Schema modifications must be written as new forward migrations (e.g. `migrations/007_...`).
* Never run integration tests on the production/staging Neon database. Test databases must end in `_test`.

### 1.7 Zero-Framework Philosophy
* Stack is strictly **Node.js (>=20)** and **`pg` (node-postgres)**.
* Do not introduce ORMs (Prisma, Drizzle, TypeORM), HTTP frameworks (Express, Fastify, Nest), or frontend build toolchains (Webpack, Vite). The frontend is pure vanilla JavaScript (`public/app.js`), semantic HTML, and CSS.

---

## 2. Project Layout & Architecture Map

```text
├── api/
│   └── index.js              # Vercel serverless entry point
├── docs/                     # Comprehensive architectural & API documentation
│   ├── ARCHITECTURE.md       # Runtime topology and execution lifecycle
│   ├── DATA_MODEL.md         # PostgreSQL tables, ER diagram, constraints
│   ├── API_REFERENCE.md      # REST endpoint reference & error dictionaries
│   ├── AUTHORIZATION_AND_SECURITY.md # Permission matrix & scoping rules
│   └── DEVELOPMENT_AND_TESTING.md    # Local setup and test guides
├── migrations/               # Sequential forward-only SQL migrations (001 - 006)
├── public/                   # Vanilla frontend client (no build step)
│   ├── app.js                # Single-page UI application logic & views
│   ├── index.html            # Application shell
│   └── styles.css            # Responsive styles & design system tokens
├── scripts/                  # Administrative and deployment scripts
│   ├── migrate.js            # Transactional migration runner
│   ├── issue-password-link.js# One-time password token generator
│   └── check-no-auth-bypass.sh # Security scanning script
├── src/                      # Backend application source
│   ├── audit.js              # Immutable audit writer & vocabulary
│   ├── config.js             # Validated boot-time configuration
│   ├── db.js                 # PostgreSQL connection pool & tx() helper
│   ├── auth/                 # Scrypt hashing, sessions, passwords
│   ├── authz/                # Centralized permission guard & matrix
│   ├── employees/            # Employee directory & reporting services
│   ├── trips/                # Trips domain service & validation
│   ├── expenses/             # Expenses domain service & validation
│   └── http/                 # Route handlers & HTTP server
│       ├── app.js            # Dispatcher, routing table & error handler
│       ├── server.js         # Standalone HTTP server for local/containers
│       ├── routes.auth.js    # Authentication endpoints
│       ├── routes.admin.js   # Employee/department admin endpoints
│       ├── routes.trips.js   # Trips CRUD, submit & decide routes
│       └── routes.expenses.js# Expenses CRUD, submit & decide routes
└── test/                     # Node native test runner test suites
    ├── audit.immutability.test.js
    ├── authz.matrix.test.js  # Adversarial authorization tests
    ├── employees.test.js
    ├── password.test.js
    ├── trips.expenses.test.js# Domain & negative tests
    └── trips.http.test.js    # Real HTTP network integration tests
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
1. Name next sequential file (e.g. `migrations/007_feature_name.sql`).
2. Write idempotent SQL.
3. Apply locally: `npm run migrate`.
4. Check status: `npm run migrate:status`.

### 3.4 Running Verification
Before declaring a task done:
```bash
# 1. Security scan
npm run check:no-bypass

# 2. Run full test suite (requires local Postgres database ending in _test)
DATABASE_URL=postgres://localhost:5432/trek_test DATABASE_SSL_MODE=disable APP_ENV=dev APP_BASE_URL=http://localhost:3000 npm test
```
