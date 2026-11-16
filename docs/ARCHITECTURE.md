# Trek System Architecture

## 1. High-Level Topology

Trek is designed as a lightweight, zero-framework, serverless-ready web application backed by PostgreSQL. It operates with a minimal runtime footprint while maintaining enterprise-grade transactional and security guarantees.

```mermaid
flowchart TD
    Client["Browser Client\n(HTML5 / Vanilla ES Modules / CSS)"]
    Edge["Platform Edge / Reverse Proxy\n(Vercel or Node HTTP Server)"]
    Router["HTTP Dispatcher\n(src/http/app.js)"]
    AuthGuard["Authentication & Session Layer\n(src/auth/)"]
    AuthzGuard["Authorization & Scope Resolver\n(src/authz/guard.js)"]
    DomainServices["Domain Services\n(Trips, Expenses, Employees, Admin)"]
    DBPool["PostgreSQL Connection Pool\n(src/db.js via pg)"]
    PostgreSQL[("PostgreSQL Database\n(Neon Serverless / Local Postgres)")]

    Client -->|HTTPS / REST| Edge
    Edge --> Router
    Router --> AuthGuard
    AuthGuard --> AuthzGuard
    AuthzGuard --> DomainServices
    DomainServices -->|Transaction tx()| DBPool
    DBPool --> PostgreSQL
```

---

## 2. Architectural Principles

### 2.1 Zero-Framework Philosophy
* **Runtime Simplicity**: Trek relies exclusively on Node.js built-ins (`node:http`, `node:crypto`, `node:fs`, `node:test`) and a single production dependency: **`pg` (node-postgres)**.
* **No ORM**: Raw, parameterized SQL queries are used throughout. This avoids leaky abstractions, N+1 query surprises, and schema migration impedance mismatches.
* **No Frontend Build Step**: The frontend is served directly as vanilla modern JavaScript (`public/app.js`), semantic HTML (`public/index.html`), and scoped CSS (`public/styles.css`). There is no bundler, Webpack, Vite, Babel, or transpilation step.
* **The Design System Is CarbonCN**: `public/styles.css` carries CarbonCN's tokens — the 8px spacing scale, the type scale, the motion curves, the focus behaviour, and zero-radius corners — with Trek's own colours held under Carbon's semantic names (`--interactive`). The typefaces (IBM Plex Sans and IBM Plex Mono) are self-hosted in `public/fonts/`, so the app never calls a third party to render a page. There are no inline styles in the client: every value lives in a class.
* **Overlays are Carbon modals**: each drawer and modal takes the focus, traps it while it is open, and gives it back when it closes. The in-app manual is drawn from the live permission matrix, so its "who can do what" table and its capability catalogue are the matrix itself rather than a copy of it.

### 2.2 Dual Runtime Targets
Trek executes identically in two runtime environments:
1. **Local / Container Standalone**: Runs `src/http/server.js` using Node's standard `http.createServer()`.
2. **Serverless (Vercel)**: Runs via `api/index.js`, which exports an entry handler wrapping `src/http/app.js` with serverless connection pooling rules (`DATABASE_POOL_MAX` tuned low).

---

## 3. Request Lifecycle

```mermaid
sequenceDiagram
    autonumber
    actor User as User / Browser
    participant App as HTTP App (app.js)
    participant Auth as Session (session.js)
    participant Guard as Authz Guard (guard.js)
    participant Svc as Service Layer
    participant DB as PostgreSQL (db.js)

    User->>App: HTTP Request (Method, Path, Cookie)
    App->>Auth: Extract 'trek_session' & lookup principal
    Auth->>DB: Fetch active account & employee record
    DB-->>Auth: Account & Principal details
    Auth-->>App: Authenticated Principal (or null)

    App->>Guard: authorize(operation, target, requestedScope)
    Guard->>DB: Resolve reportingTree CTE (if team scope)
    DB-->>Guard: Transitive team IDs
    Guard-->>App: Authorized (scope, team) or 403/404

    App->>Svc: Invoke domain action with Principal
    Svc->>DB: BEGIN Transaction
    Svc->>DB: Perform SQL queries / mutations
    Svc->>DB: INSERT INTO audit_event (Atomic)
    Svc->>DB: COMMIT Transaction
    DB-->>Svc: Success
    Svc-->>App: Domain Result
    App-->>User: HTTP 200/201 JSON Response
```

---

## 4. Key Subsystems

### 4.1 Database Layer (`src/db.js`)
* **Connection Pooling**: Uses `pg.Pool` with SSL assertions (`DATABASE_SSL_MODE`).
* **Date Parsing**: Date types (PostgreSQL OID `1082`) are intercepted to return exact `YYYY-MM-DD` strings, preventing local server timezone offsets from altering calendar dates.
* **Transaction Helper `tx(callback)`**: Manages `BEGIN`, `COMMIT`, and `ROLLBACK` lifecycles automatically on a single checked-out client.

### 4.2 Security & Authorization Layer (`src/authz/`)
* **Declarative Permission Matrix (`permissions.js`)**: Permissions and operations are defined as pure data structures. Handlers never make ad-hoc authorization checks.
* **Reporting Tree CTE**: Resolves an employee's direct and indirect management reporting hierarchy via a recursive common table expression.
* **Opaque Denial**: When a user attempts to access an out-of-scope resource by guessing or substituting an ID, the system returns `404 Not Found` rather than `403 Forbidden` to prevent object enumeration.

### 4.3 Immutable Audit Engine (`src/audit.js`)
* **Append-Only Guarantees**: The `audit_event` table is physically protected in PostgreSQL by database triggers that reject `UPDATE` and `DELETE` operations.
* **Transactional Atomicity**: Audit writes must execute inside the transaction modifying the entity. If business logic fails, the audit row rolls back; if the audit write fails, the entire transaction rolls back.

### 4.4 Financial Accuracy & Money Types
* **Zero Float Math**: Floating-point conversions (e.g., `Number.parseFloat()`) are prohibited for monetary amounts.
* **Storage**: PostgreSQL `NUMERIC(14,2)` for money, `NUMERIC(20,8)` for exchange rates.
* **Application Representation**: Strict string decimals validated via `/^\d+(\.\d{1,2})?$/`, running on `src/money.js` BigInt minor units.

### 4.5 Multi-Currency & Live Market Synchronization Engine (`src/currency/`)
* **Authoritative Currency Registry**: 50+ world currencies maintained in the `currency` table.
* **Snapshot Immutability**: Historical budget lines, expenses, and advance disbursements retain their locked transaction exchange rate (`rate_to_base`) and converted base amount (`base_amount`). Modifying a remembered rate never rewrites historical money.
* **Automated European Central Bank Sync**: `POST /api/v1/exchange-rates/sync` fetches official ECB reference rates (via open Frankfurter API, requiring zero proprietary API keys), calculates 8-decimal cross rates against company base currency (INR), and calculates exact rates for central-bank pegged GCC currencies (AED, SAR, QAR, OMR, BHD, KWD).
* **Truncation Over Rounding**: Minor unit conversions truncate toward zero rather than rounding up, ensuring money is never artificially inflated.
