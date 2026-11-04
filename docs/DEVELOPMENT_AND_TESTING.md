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
LOGIN_EMAIL_DOMAINS=garageplug.com
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
DATABASE_URL=postgres://localhost:5432/trek_test DATABASE_SSL_MODE=disable APP_ENV=dev APP_BASE_URL=http://localhost:3000 npm test

# 3. Run both checks together
npm run check
```

### 3.3 Test Structure
* [`test/trips.expenses.test.js`](../test/trips.expenses.test.js): Domain test suite covering trip/expense validation, reporting tree routing, self-approval prevention, decimal precision, and rollback on failure.
* [`test/trips.http.test.js`](../test/trips.http.test.js): End-to-end HTTP integration tests running against an ephemeral HTTP server with real session cookies and network fetch calls.
* [`test/authz.matrix.test.js`](../test/authz.matrix.test.js): Adversarial security test suite verifying every cell of the authorization matrix, opaque denial, and scope parameters.
* [`test/password.test.js`](../test/password.test.js): Brute-force rate limiting, password hashing, and reset token validity.
* [`test/audit.immutability.test.js`](../test/audit.immutability.test.js): Verifies PostgreSQL database triggers reject `UPDATE` and `DELETE` on `audit_event`.

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
