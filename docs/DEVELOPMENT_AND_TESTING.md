# Trek Development & Testing Guide

## 1. Prerequisites & Environment Setup

* **Node.js**: Version 20.x or higher (uses native ES modules, `node:test`, and `node:crypto`).
* **PostgreSQL**: Version 14 or higher (v16 recommended).

### 1.1 Environment Variables
Create a local `.env` file or export variables in your shell. **Never commit `.env` or check in production database credentials.**

```bash
# Application Environment (dev | staging | prod)
APP_ENV=dev

# Base URL for session cookies and link generation
APP_BASE_URL=http://localhost:3000

# Server Port
PORT=3000

# PostgreSQL Connection String
DATABASE_URL=postgres://localhost:5432/trek_test

# Database SSL Mode ('disable' for local Postgres, 'require' for Neon/Cloud)
DATABASE_SSL_MODE=disable

# Email Driver ('console' in dev; 'resend', 'postmark', or 'disabled' in staging/prod)
MAIL_DRIVER=console

# Allowed Corporate Domains for Sign-in
# garageplug.test holds test fixtures only — never a deployment.
LOGIN_EMAIL_DOMAINS=garageplug.com,garageplug.test
```

---

## 2. Database Migrations

Trek uses a lightweight, transactional, forward-only migration runner (`scripts/migrate.js`).

### 2.1 Applying Migrations
```bash
# Apply all pending migrations inside a transaction
npm run migrate

# Check migration status
npm run migrate:status
```

### 2.2 Adding a New Migration
1. Create a sequentially numbered SQL file in `migrations/` (e.g. `migrations/007_new_feature.sql`).
2. Write raw, idempotent SQL.
3. If creating new tables, ensure:
   * Triggers for `updated_at` use `set_updated_at()`.
   * Explicit grants are provided for restricted runtime roles (e.g. `trek_app`).
4. **Never edit a migration that has already been applied to staging or production.** Add forward migrations only.

---

## 3. Running the Test Suite

Trek uses Node.js's native test runner (`node:test`). Tests run fast without compilation or heavy testing harnesses.

### 3.1 Critical Safety Guard
> [!CAUTION]
> Integration tests connect to PostgreSQL and execute transactional rollbacks and resets. Tests **strictly refuse to run** unless the database name ends in **`_test`** (e.g. `trek_test`). Never configure a staging or production database URL when running tests.

### 3.2 Executing Checks & Tests
```bash
# 1. Verify code against authentication bypasses and credential leaks
npm run check:no-bypass

# 2. Run the full test suite against local test database
DATABASE_URL=postgres://localhost:5432/trek_test DATABASE_SSL_MODE=disable APP_ENV=dev APP_BASE_URL=http://localhost:3000 LOGIN_EMAIL_DOMAINS=garageplug.com,garageplug.test npm test

# 3. Run both checks together
npm run check
```

### 3.3 The Test Fixtures
`scripts/seed-test.js` loads the fixtures the suite needs: a manager, a finance user, a travel desk and five travellers, so reporting lines and approvals can be exercised.

They are fixtures, not people. The names say so, and the addresses sit in the reserved `garageplug.test` domain (RFC 2606), which can never belong to a colleague and can never sign in to a production deployment — the production allowlist is `garageplug.com` alone, while development and test environments configure `LOGIN_EMAIL_DOMAINS=garageplug.com,garageplug.test`. The script refuses to run against any database whose name does not end in `_test`, so it can never touch company data.

### 3.4 Test Structure
Thirteen files, 231 tests. What each one actually asserts:
* [`test/trips.expenses.test.js`](../test/trips.expenses.test.js): the trip and expense state machines, the reporting tree, self-approval, decimal precision, and the guards that refuse a decision from outside the tree.
* [`test/trips.http.test.js`](../test/trips.http.test.js): the whole workflow end to end over real HTTP — a real server, real session cookies, real fetches — from a draft trip to a settled reconciliation.
* [`test/authz.matrix.test.js`](../test/authz.matrix.test.js): the authorization matrix against six principals, opaque denial (a record outside the tree and a record that does not exist must be indistinguishable), and the scope parameters.
* [`test/employees.test.js`](../test/employees.test.js): employee master data — the reporting tree, role changes, deactivation, and the bulk import.
* [`test/currency.test.js`](../test/currency.test.js): the money arithmetic — the reciprocal of a rate, the exactness of a conversion, and the refusal to guess a rate nobody has.
* [`test/currency.http.test.js`](../test/currency.http.test.js): the currency registry and the remembered rates over HTTP, including the display-currency conversion on the dashboard.
* [`test/validation.test.js`](../test/validation.test.js): the query-parameter validators and the enum allow-lists, against the schema's own `pg_enum`.
* [`test/password.test.js`](../test/password.test.js): the scrypt hash, the password policy, and the sign-in path.
* [`test/manual.test.js`](../test/manual.test.js): the in-app manual — that it opens, that every section is there, that the screens and endpoints it names exist, and that its role table matches the live matrix.
* [`test/pilot.frontend.test.js`](../test/pilot.frontend.test.js): the client's contract with the server — every route the client calls must exist, the app script must not be cacheable, and the client must carry no inline styles.
* [`test/nav.permissions.test.js`](../test/nav.permissions.test.js): that each role is offered the navigation its permissions allow, and nothing else.
* [`test/audit.immutability.test.js`](../test/audit.immutability.test.js): that PostgreSQL refuses to `UPDATE` or `DELETE` an audit row, by trigger and by grant.
* [`test/seed.cleanliness.test.js`](../test/seed.cleanliness.test.js): that no file in the repository names a person who is not a colleague or a fixture.

---

## 4. Running the Application Locally

```bash
# Run server standalone on port 3000
npm start

# Run with watch mode (auto-reload on code change)
npm run dev
```
Open **`http://localhost:3000`** in your browser.

---

## 5. Helpful Operator Scripts

* **Issue Administrator Password Link**:
  ```bash
  node scripts/issue-password-link.js ashishreddy@garageplug.com
  ```
  Generates a one-time set-password token printed directly to stdout.

* **Reset Staging Database**:
  ```bash
  node scripts/reset-staging.js --confirm
  ```
  Deletes transactional tables on staging and restores approved master seed data. Refuses to run against production databases or databases lacking a `staging.marker` audit row.

* **Rebuild a Development Database from the Migrations**:
  ```bash
  node scripts/recreate-app-db.js trek_dev_test
  ```
  Drops the database and rebuilds it from `migrations/`, carrying the administrators' password hashes across so nobody's password changes. Sessions are not carried across, so everyone signs in again.

  The database name must end in `_test`. Any other name is refused unless it is named a second time, which is the deliberate act of dropping a database:
  ```bash
  node scripts/recreate-app-db.js trek_dev --allow trek_dev
  ```
  The script asks the server which database it is connected to before it drops anything, and refuses if that is not the database named on the command line.

  This is the only way to clear the audit log: `audit_event` is append-only by design, so the seed-era rows cannot be deleted by any role — the database has to be built again to leave one whose every row is real.
