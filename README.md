# Trek

Trek is an employee travel planning and expense management platform built for employees traveling abroad, their managers, and administrators.

The application is deployed serverless on **Vercel** and backed by **Neon PostgreSQL**. It follows a **zero-framework, lightweight architecture** utilizing pure Node.js (>=20) and raw parameterized SQL via `pg` (node-postgres), with zero build step on the frontend.

---

## The Workflow

```
Trip Creation → Budget Preparation → Approval → Fund Allocation
  → Daily Expense Tracking & Bill Upload → Final Reconciliation
  → Finance Approval → Settlement & Trip Closure
```

| Stage | Who | What happens |
| :--- | :--- | :--- |
| Trip creation | Employee | Destination, purpose, dates, destination currency. |
| Budget preparation | Employee | Estimated-expense lines (travel, accommodation, food, visa, SIM card, other) and the **currency plan**: cash to carry, forex card to load, the exchange rate, GST, top-up and service fees. |
| Approval | Manager (or Finance) | Approve, reject with a reason, or **request changes** — which sends the trip back to the traveller, who edits and resubmits. |
| Fund allocation | Finance | Cash, a forex card, or an additional tranche. The first allocation activates the trip. |
| Daily expenses | Employee | Expenses with date, category, description, amount, currency and **payment method**, each with receipts attached. |
| Reconciliation | Employee → Finance | The system computes funds received, actual spend, and the balance: money to return, or money the company owes. |
| Settlement | Finance | Records the settlement and closes the trip. |

---

## Key Features

1. **Budget & currency planning**:
   * Estimated-expense lines per trip, in any currency, converted at the trip's own rate.
   * Cash and forex-card requirements, exchange rate, GST, forex top-up charges and other service fees, per currency.
   * **Entered rates, not fetched ones**: no FX provider is integrated, and no rate is ever applied twice.

2. **Exact decimal money, everywhere**:
   * **Zero Floating-Point Arithmetic**: amounts are `NUMERIC(14,2)` in PostgreSQL and exact decimal strings in JavaScript, using BigInt minor units.
   * Every conversion is a **snapshot** — the rate used is stored with the row, so changing a rate later never rewrites money that was already budgeted, spent or issued.
   * One category vocabulary shared by budget and expenses, so budget-versus-actual compares like with like.

3. **Hierarchical approval & Finance control**:
   * The review queue is scoped to the reporting hierarchy, resolved per request by recursive CTE.
   * **Company-wide authority is a different permission from team authority.** A manager approves within their reporting tree; only Finance and Admin can approve company-wide. This split is what stops one manager approving another manager's report.
   * Self-approval and out-of-scope decisions are forbidden. Rejections and change requests carry a mandatory reason.

4. **Receipts, reconciliation & settlement**:
   * Receipts (photo or PDF) attach to an expense and are listed per trip.
   * Reconciliation snapshots the funds issued against the approved spend, so a decision is made against fixed numbers.
   * The balance tells you who owes whom.

5. **Security, scoping & immutability**:
   * Role and scope-based server-side authorization (`own`, `team`, `all`), resolved by one guard.
   * **Opaque denial**: out-of-scope reads return `404 Not Found`, byte-identical to a nonexistent record, so ids cannot be enumerated.
   * Append-only `audit_event`, protected by PostgreSQL triggers refusing `UPDATE` and `DELETE`.
   * The app runs against a least-privilege database role that cannot rewrite history.

6. **Reporting**:
   * A dashboard of trip budgets, approvals outstanding, spend, pending settlements and employee-wise totals.
   * CSV export of the same figures, for Excel.

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

# Run full test suite (151 tests)
npm test

# Run both together
npm run check
```

The suite covers the money arithmetic, the whole workflow end to end over real HTTP, the authorization matrix adversarially, and the frontend's contract with the server (every route the client calls must exist; the app script must not be cacheable).
