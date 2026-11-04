# Trek

Trek is an employee travel planning and expense management platform built for employees traveling abroad, their managers, and administrators.

The application is deployed serverless on **Vercel** and backed by **Neon PostgreSQL**. It follows a **zero-framework, lightweight architecture** utilizing pure Node.js (>=20) and raw parameterized SQL via `pg` (node-postgres), with zero build step on the frontend.

---

## Key Features

1. **Travel & Multi-Currency Trip Planning**:
   * Create, manage, and edit draft trips with destination, business purpose, date validation, and destination currency selection (USD, EUR, GBP, SAR, AED, INR, SGD, JPY, etc.).
   * Submit trips for manager review with automatic approval route verification.

2. **Exact Decimal Expense Tracking**:
   * Itemize expenses per trip with date, description, category (`meals`, `lodging`, `transport`, `airfare`, `supplies`, `other`), and exact transaction currency.
   * **Zero Floating-Point Arithmetic**: Stored as exact `NUMERIC(14,2)` in PostgreSQL and handled as exact decimal strings in JavaScript using minor units.
   * Multi-currency expense aggregation per trip without artificial exchange conversions.

3. **Hierarchical Manager & Admin Review**:
   * Review queue scoped strictly to an employee's management hierarchy resolved dynamically via recursive CTE.
   * Self-approval and out-of-scope decisions are strictly forbidden.
   * Decision audit trails with mandatory rejection reasons.

4. **Security, Scoping & Immutability**:
   * Role and scope-based server-side authorization (`own`, `team`, `all`).
   * **Opaque Denial**: Unauthorized access to another user's record returns `404 Not Found` (byte-identical to non-existent records) to prevent ID enumeration.
   * Append-only `audit_event` table protected by PostgreSQL triggers refusing `UPDATE` and `DELETE`.

---

## Documentation

Comprehensive documentation is maintained in the [`docs/`](docs/) directory:

| Document | Focus |
| :--- | :--- |
| **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** | System topology, runtime lifecycle, and zero-framework design philosophy. |
| **[`docs/DATA_MODEL.md`](docs/DATA_MODEL.md)** | PostgreSQL database schema, ER diagrams, check constraints, and migrations. |
| **[`docs/API_REFERENCE.md`](docs/API_REFERENCE.md)** | REST endpoint reference, payloads, validation contracts, and error dictionaries. |
| **[`docs/AUTHORIZATION_AND_SECURITY.md`](docs/AUTHORIZATION_AND_SECURITY.md)** | Centralized permission matrix, reporting tree CTE scoping, and security invariants. |
| **[`docs/DEVELOPMENT_AND_TESTING.md`](docs/DEVELOPMENT_AND_TESTING.md)** | Local setup, environment configuration, migration commands, and test suites. |
| **[`AGENTS.md`](AGENTS.md)** | Root-level architectural rules and operating invariants for AI agents and LLMs. |

---

## Quick Start (Local Development)

### 1. Requirements
* Node.js >= 20.x
* PostgreSQL >= 14.x

### 2. Environment Setup
Configure your `.env` file (see `.env.example` for details):
```bash
APP_ENV=dev
APP_BASE_URL=http://localhost:3000
DATABASE_URL=postgres://localhost:5432/trek_dev
DATABASE_SSL_MODE=disable
MAIL_DRIVER=console
LOGIN_EMAIL_DOMAINS=garageplug.com
```

### 3. Run Migrations
```bash
npm run migrate
```

### 4. Start the Application
```bash
# Start standalone local server
npm start

# Or with live auto-reload
npm run dev
```
Open **`http://localhost:3000`** in your browser.

---

## Verification & Tests

Trek uses Node.js's native test runner (`node:test`) against an isolated test database ending in `_test`:

```bash
# Run security scanning
npm run check:no-bypass

# Run full test suite (118 tests across 25 suites)
npm test

# Run both together
npm run check
```
