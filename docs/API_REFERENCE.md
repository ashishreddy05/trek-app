# Trek REST API Reference

All requests and responses use JSON (`Content-Type: application/json`). Authentication is maintained via HTTP-only session cookies (`trek_session`).

---

## 1. Response Formats & Error Contracts

### 1.1 Success Envelopes
* **List Endpoints**:
  ```json
  {
    "data": [ ... ],
    "nextCursor": "2026-11-20T10:00:00.000Z"
  }
  ```
* **Single Resource Endpoints**:
  ```json
  {
    "trip": { ... }
  }
  ```

### 1.2 Error Envelopes
All non-2xx responses return a consistent error structure:
```json
{
  "error": {
    "code": "validation_failed",
    "message": "Please correct the highlighted fields.",
    "fields": {
      "startDate": "Start date must be in YYYY-MM-DD format"
    }
  }
}
```

### 1.3 HTTP Status Codes
| Code | Meaning & Typical Context |
| :--- | :--- |
| `200 OK` | Request succeeded. |
| `201 Created` | Resource created. |
| `401 Unauthorized` | Missing, invalid, or expired session. |
| `403 Forbidden` | Authenticated, but lacking sufficient role or scope (e.g. self-approval). |
| `404 Not Found` | Resource does not exist, or out-of-scope for the user (**Opaque on deny**). |
| `409 Conflict` | Invalid state transition (e.g., editing an approved trip or deciding an already decided trip). |
| `422 Unprocessable` | Validation error, or workflow rule violation (e.g., `no_approval_route`). |
| `429 Too Many Requests`| Rate limit exceeded (e.g., >5 failed login attempts in 15 minutes). |

---

## 2. Authentication Endpoints

### `POST /api/v1/auth/login`
Authenticates with email and password. Sets `trek_session` HTTP-only cookie.
* **Payload**:
  ```json
  {
    "email": "ashishreddy@garageplug.com",
    "password": "..."
  }
  ```
* **Response (200)**:
  ```json
  {
    "principal": {
      "employeeId": "emp_1000",
      "accountId": "acc_...",
      "name": "Ashish Reddy",
      "email": "ashishreddy@garageplug.com",
      "roles": ["employee", "admin"],
      "permissions": ["trip.create", "trip.read.all", ...],
      "surface": "admin"
    },
    "expiresAt": "2026-11-05T03:00:00.000Z"
  }
  ```

### `POST /api/v1/auth/logout`
Revokes the current session and clears the cookie.
* **Response (200)**: `{ "ok": true }`

### `GET /api/v1/me`
Fetches the currently authenticated principal profile and permissions.

### `PATCH /api/v1/me`
Updates the signed-in person's own contact number. Nothing else is editable here — every other field is an Admin operation.
* **Payload**:
  ```json
  { "mobile": "+91 90000 00000" }
  ```
  `mobile` is the only accepted field. A body without `mobile` is refused with `422`.
* **Response (200)**:
  ```json
  { "employee": { "id": "emp_1000", "mobile": "+91 90000 00000" } }
  ```

### `POST /api/v1/auth/password/forgot`
Asks for a password reset link. The response is the same whether or not the address belongs to an active account, so the endpoint cannot be used to discover who has one.
* **Payload**:
  ```json
  { "email": "ashishreddy@garageplug.com" }
  ```
* **Response (202)**:
  ```json
  { "ok": true, "message": "If that email belongs to an active Trek account, a reset link is on its way." }
  ```

### `POST /api/v1/auth/password/check`
Tells the set-password screen whether a link is still usable.
* **Payload**:
  ```json
  { "token": "<token from the link>" }
  ```
* **Response (200)**:
  ```json
  { "valid": true, "purpose": "reset", "firstName": "Ashish" }
  ```
  An expired or already-used token is refused with `410 link_expired`.

### `POST /api/v1/auth/password/reset`
Sets the password from an invite or reset link. The token is single use: using it voids every other live link for that account and signs out every device.
* **Payload**:
  ```json
  { "token": "<token from the link>", "password": "a strong new password" }
  ```
* **Response (200)**: `{ "ok": true }`

### `POST /api/v1/auth/password/change`
Changes the password of the signed-in person. The current password is required.
* **Payload**:
  ```json
  { "currentPassword": "...", "newPassword": "..." }
  ```
* **Response (200)**: `{ "ok": true }`

---

## 3. Trips Endpoints

### `GET /api/v1/trips`
Lists trips based on the caller's authorized scope.
* **Query Parameters**:
  * `scope` (`own` | `team` | `all`): Defaults to user's highest allowed scope or `own`.
  * `status` (`draft` | `submitted` | `approved` | `active` | `reconciliation_pending` | `reconciled` | `closed` | `changes_requested` | `rejected`): Filter by status.
  * `limit` (default: 50, max: 100).
  * `cursor`: Created-at timestamp for pagination.
* **Response (200)**:
  ```json
  {
    "data": [
      {
        "id": "trp_f24de41cfd5e8c02",
        "employee_id": "emp_1000",
        "employee_name": "Ashish Reddy",
        "employee_code": "EMP-002",
        "destination": "London HQ",
        "purpose": "Executive Strategy Session",
        "start_date": "2026-12-01",
        "end_date": "2026-12-05",
        "status": "draft",
        "expense_count": 2,
        "created_at": "2026-11-04T12:00:00.000Z"
      }
    ],
    "nextCursor": null
  }
  ```

### `POST /api/v1/trips`
Creates a new draft trip.
* **Payload**:
  ```json
  {
    "origin": "Bengaluru, India",
    "destination": "Tokyo",
    "purpose": "Client Q4 Roadmap Review",
    "startDate": "2026-12-10",
    "endDate": "2026-12-15",
    "ownFundsBase": "25000.00",
    "legs": [
      { "from": "Bengaluru, India", "to": "Tokyo", "departDate": "2026-12-10" },
      { "from": "Tokyo", "to": "Osaka", "departDate": "2026-12-13" },
      { "from": "Osaka", "to": "Bengaluru, India", "departDate": "2026-12-15" }
    ]
  }
  ```
* **Validation**:
  * `origin`: Optional departure city, max 200 chars. The server never supplies one — an assumed origin produces a flight search to the wrong airport.
  * `destination`: Non-empty, max 200 chars.
  * `purpose`: Non-empty, max 500 chars.
  * `startDate` & `endDate`: Valid `YYYY-MM-DD` format.
  * `endDate >= startDate`.
  * `ownFundsBase`: Optional non-negative exact decimal string, default `"0.00"` — money the traveller already has for this trip, in the company base currency.
  * `legs`: Optional ordered itinerary, at most 20 legs. Each leg needs `from` and `to` (non-empty, max 200 chars); `departDate` is optional and must be `YYYY-MM-DD`. An empty list means the direct origin → destination journey.
* **Response (201)**: `{ "trip": { ... } }` — the trip row; read `GET /api/v1/trips/:id` for the `legs`.

### `GET /api/v1/trips/:id`
Retrieves a single trip and its attached itemized expenses.
* **Response (200)**:
  ```json
  {
    "trip": {
      "id": "trp_...",
      "origin": "Bengaluru, India",
      "destination": "Tokyo",
      "status": "submitted",
      "own_funds_base": "25000.00",
      "requested_funds_base": "141500.00",
      "legs": [
        { "id": "tlg_...", "seq": 1, "from_city": "Bengaluru, India", "to_city": "Tokyo", "depart_date": "2026-12-10" },
        { "id": "tlg_...", "seq": 2, "from_city": "Tokyo", "to_city": "Bengaluru, India", "depart_date": "2026-12-15" }
      ],
      "expenses": [ ... ]
    }
  }
  ```
  `legs` is the itinerary in `seq` order. `requested_funds_base` is what the company was asked to fund, frozen at submission as `max(0, budget total − own_funds_base)`; it is `null` before submission. The `totals` block repeats `ownFundsBase`, `requestedBase` and `fundsRemainingBase` for the funding summary.
* **Security**: If the caller has no scope to view this trip, returns `404 Not Found`.

### `PATCH /api/v1/trips/:id`
Updates a **draft** trip: `origin`, `destination`, `purpose`, dates, `ownFundsBase`, and `legs`.
* **Payload**: the same fields as create. `origin` and `ownFundsBase` are only replaced when sent, so a PATCH that edits the purpose leaves them untouched. Omitting `legs` keeps the existing itinerary; sending the array replaces it as a set.
* **Response (200)**: `{ "trip": { ... } }` — the trip row; read the trip for `legs`.
* **Security & State**: Returns `409 Conflict` if the trip is not in `draft` status.

### `POST /api/v1/trips/:id/submit`
Submits a draft trip for management approval.
* **Rules**:
  * Verifies employee has an active manager in the organization. If none exists, refuses with `422 Unprocessable Entity` (`code: "no_approval_route"`).
  * Freezes `requested_funds_base` as `max(0, budget total − own_funds_base)` — what the company is being asked to fund.
  * Transitions status: `draft` &rarr; `submitted`.
  * Writes atomic `TRIP_SUBMIT` audit event.

### `POST /api/v1/trips/:id/decide`
Approves or rejects a submitted trip.
* **Payload**:
  ```json
  {
    "decision": "approve" // or "reject"
  }
  ```
  *(If decision is `"reject"`, `"reason"` string is required).*
* **Rules**:
  * Caller must hold `trip.approve` covering the employee (`team` scope or `all` scope).
  * Self-approval is rejected with `403 Forbidden`.
  * Deciding non-submitted trip returns `409 Conflict`.
  * Writes atomic `TRIP_APPROVE` or `TRIP_REJECT` audit event.

---

## 4. Expenses Endpoints

### `GET /api/v1/expenses`
Lists expenses based on caller's authorized scope.
* **Query Parameters**: `scope`, `tripId`, `status`, `limit`, `cursor`.

### `POST /api/v1/expenses`
Attaches an expense entry to an employee's own trip.
* **Payload**:
  ```json
  {
    "tripId": "trp_f24de41cfd5e8c02",
    "date": "2026-12-02",
    "description": "Taxi from Narita Airport to Shinjuku",
    "category": "travel",
    "amount": "85.50",
    "currency": "USD",
    "paymentMethod": "cash"
  }
  ```
* **Validation**:
  * `category`: One of `travel`, `accommodation`, `food`, `visa`, `sim_card`, `other` — the same vocabulary the trip budget uses.
  * `amount`: Exact positive decimal string with up to 2 decimal places.
  * `currency`: 3-letter uppercase ISO currency code. The trip must have a currency plan entry for it.
  * `paymentMethod`: One of `cash`, `forex_card`, `card`, `bank_transfer`. Defaults to `cash`.
  * Caller must own the referenced trip, and the trip must be `approved` or `active` — funds do not have to be issued first. Own-funded spend is reimbursed at reconciliation.
* **Response (201)**: `{ "expense": { ... } }`, including `base_amount` and `rate_to_base`.

### `PATCH /api/v1/expenses/:id`
Edits a draft expense entry. Refuses with `409 Conflict` if already submitted or approved.

### `DELETE /api/v1/expenses/:id`
Deletes a draft expense entry. Refuses with `409 Conflict` if already submitted or approved.

### `POST /api/v1/expenses/:id/submit`
Submits an expense entry for manager approval.
* **Rules**:
  * Verifies employee has an active manager route.
  * Transitions status: `draft` &rarr; `submitted`.
  * Writes atomic `EXPENSE_SUBMIT` audit event.

### `POST /api/v1/expenses/:id/decide`
Approves or rejects an expense entry.
* **Payload**: `{ "decision": "approve" }` or `{ "decision": "reject", "reason": "Missing receipt" }`
* **Rules**:
  * Caller cannot approve their own expense.
  * Rejection requires reason.
  * Writes atomic `EXPENSE_APPROVE` or `EXPENSE_REJECT` audit event.

---

## 5. Budget, Currency Plan & Funds

### `GET /api/v1/trips/:id/budget`
The trip's estimated-expense lines and the frozen approved budget.
* **Response (200)**: `{ "lines": [ ... ], "approvedBudgetBase": "166500.00" }`

### `POST /api/v1/trips/:id/budget`
Adds one estimated-expense line.
* **Payload**: `{ "category": "accommodation", "description": "Hotel, 4 nights", "amount": "2000.00", "currency": "AED" }`
* **Rules**:
  * The traveller owns the trip, and the trip is `draft` or `changes_requested`.
  * The currency must have a rate in the trip's currency plan, or the request is refused with `422` — a currency without a rate cannot be converted, and guessing is worse than refusing.
  * `base_amount` is computed from the plan's rate and stored.
* **Response (201)**: `{ "line": { ... } }`

### `DELETE /api/v1/trips/:id/budget/:lineId`
Removes a budget line. Draft trips only.

### `GET /api/v1/trips/:id/forex`
The trip's currency plan — cash, forex card, rate and charges per currency.

### `PUT /api/v1/trips/:id/forex`
Sets (or replaces) the plan for one currency.
* **Payload**:
  ```json
  {
    "currency": "AED",
    "rateToBase": "83.25000000",
    "cashAmount": "2000.00",
    "cardAmount": "15000.00",
    "gstAmount": "900.00",
    "topupFee": "450.00",
    "serviceFee": "150.00"
  }
  ```
* **Rules**: charges are in the base currency. The rate is how many base-currency units one unit of this currency buys. Amounts of zero are allowed; a rate of zero is not.

### `DELETE /api/v1/trips/:id/forex/:planId`
Removes a currency from the plan. Draft trips only.

### `GET /api/v1/trips/:id/funds`
The funds issued against the trip.

### `POST /api/v1/trips/:id/funds`
Records funds handed over — cash, a forex card, or an additional tranche.
* **Payload**: `{ "kind": "forex_card", "amount": "15000.00", "currency": "AED", "note": "Emirates forex card" }`
* **Rules**:
  * Finance or Admin only. A manager cannot issue funds.
  * The trip must be `approved` or `active`.
  * The FIRST allocation moves the trip to `active`. Expenses may already be recorded while the trip is `approved`; issuing funds is not their precondition.
* **Response (201)**: `{ "fund": { ... } }`

---

## 6. Bills (Receipts)

### `GET /api/v1/expenses/:id/bills`
The receipts attached to an expense.

### `POST /api/v1/expenses/:id/bills`
Uploads a receipt.
* **Payload** (base64 so it travels through the same body path as everything else — no multipart parser):
  ```json
  {
    "filename": "hotel-folio.pdf",
    "contentType": "application/pdf",
    "content": "JVBERi0xLjQK..."
  }
  ```
* **Rules**:
  * The caller owns the expense.
  * `contentType` must be an image type or `application/pdf`.
  * At most 5 MB.
* **From the client**: a photo is downscaled to 1600 pixels and encoded as a JPEG *in the browser* before it is sent, so a 10 MB phone photo becomes a few hundred kilobytes. A receipt can also be captured with the device camera or the in-app scanner. The bytes the server receives are the bytes it stores.
* **Response (201)**: `{ "bill": { ... } }` with the SHA-256 of the bytes.

### `GET /api/v1/bills/:id/content`
The receipt's bytes, with its original content type and filename.

### `DELETE /api/v1/bills/:id`
Deletes a receipt. The caller owns the underlying expense.

---

## 7. Reconciliation & Settlement

### `GET /api/v1/trips/:id/reconciliation`
The reconciliation snapshot, if one exists.

### `POST /api/v1/trips/:id/reconciliation`
The traveller submits the trip for reconciliation.
* **Payload**: `{ "note": "All receipts attached" }`
* **Rules**:
  * The trip must be `active`.
  * No expense may still be awaiting approval: money in flight would make the balance wrong.
  * Computes `funds_base` (sum of funds issued), `expenses_base` (sum of APPROVED expenses) and `balance_base` (the difference), and stores them. A positive balance is money to return; a negative one is money the company owes the traveller.
  * Moves the trip to `reconciliation_pending`.

### `POST /api/v1/trips/:id/reconciliation/decide`
Finance approves or sends back the reconciliation.
* **Payload**: `{ "decision": "approve" }` or `{ "decision": "reject", "reason": "The airport receipt is missing" }`
* **Rules**:
  * Finance or Admin only.
  * Rejection requires a reason and reopens the trip as `active`, so the traveller can fix it and resubmit.

### `POST /api/v1/trips/:id/settle`
Records the settlement and closes the trip.
* **Payload**: `{ "note": "Balance recovered by transfer" }`
* **Rules**: the trip must be `reconciled`. The trip becomes `closed`.

---

## 8. Reporting

### `GET /api/v1/dashboard`
Trip budgets, approvals outstanding, spend, pending settlements and employee-wise totals — scoped to what the caller may see (their own travel, their reporting tree, or the company for Finance and Admin). This is the landing screen for everybody after signing in.
* **Query**: `scope` (`own` | `team` | `all` | `finance`) — optional; the guard resolves the widest scope the caller holds. `display` (a 3-letter currency code) — optional; the currency the money is *shown* in.
* **Response (200)**:
  ```json
  {
    "scope": "all",
    "display": {
      "currency": "USD",
      "baseCurrency": "INR",
      "rate": "0.01201201",
      "effectiveOn": "2026-11-01",
      "known": true
    },
    "totals": {
      "trips": 5, "awaiting_approval": 1,
      "spent_base": "330502.50", "spent_display": "3970.00",
      "funds_base": "333000.00", "funds_display": "4000.00"
    },
    "trips": [ ... ],
    "employees": [ ... ],
    "settlements": [ ... ]
  }
  ```
* **Rules**:
  * The `_base` figures are what is stored. The `_display` figures are the same money shown in the requested currency, at the remembered rate — the stored amounts are never changed by a conversion.
  * A currency with no remembered rate produces no number: `display.known` is `false`, the `_display` figures are `null`, and the base figures are still there. A converted figure nobody can account for is worse than no figure.

### `GET /api/v1/reports/export.csv?kind=employees|trips`
The report as CSV — RFC 4180 quoting, so it opens in Excel and Numbers without a converter.
* **Query**: `kind` (`employees` | `trips`), `scope`, and `display` — a currency code. The base columns are always present; the display columns are added only when a currency other than the base was asked for.

---

## 9. Currencies & Rates

### `GET /api/v1/currencies`
The currency registry, and the company's base currency. Open to any signed-in user — a currency is not a secret, and the pickers need the list to draw one.
* **Response (200)**:
  ```json
  {
    "currencies": [
      { "code": "INR", "name": "Indian Rupee", "symbol": "₹", "minor_units": 2 }
    ],
    "baseCurrency": "INR"
  }
  ```

### `GET /api/v1/exchange-rates`
The rates the company has remembered, newest first.

### `GET /api/v1/exchange-rates/:code`
The latest remembered rate for one currency against the base, in both directions.
* **Response (200)**:
  ```json
  {
    "currency": "USD",
    "baseCurrency": "INR",
    "rateToBase": "83.25000000",
    "rateToBaseEffectiveOn": "2026-11-01",
    "rateFromBase": "0.01201201",
    "rateFromBaseEffectiveOn": "2026-11-01"
  }
  ```
* **Rules**: `rateToBase` is what a trip stores — how many base units one unit of this currency buys. `rateFromBase` is the inverse — how many of this currency one base unit buys. A currency with no remembered rate returns `null` for both.

### `POST /api/v1/exchange-rates`
Records a rate. Finance and Admin only (`rate.manage`).
* **Payload**: `{ "fromCode": "USD", "toCode": "INR", "rate": "83.25000000", "effectiveOn": "2026-11-01", "note": null }`
* **Rules**:
  * The rate is how many units of `toCode` one unit of `fromCode` buys. It must be positive, with at most eight decimal places, and small enough to fit `NUMERIC(20,8)` — twelve integer digits. Anything else is a `422`, never a `500`.
  * `effectiveOn` is a calendar date written `YYYY-MM-DD`. It defaults to today. An unparseable date is a `422`.
  * One row per pair per day: re-recording today's rate updates it in place; last week's row is untouched.
  * Recording a rate changes no booked money. It is a default to offer on a trip's currency plan.
  * The rate and its audit event are written **in the same transaction**. A rate that exists with no audit trail is an unauditable write.

### `POST /api/v1/exchange-rates/sync`
Synchronizes live official reference exchange rates directly from the European Central Bank (via public Frankfurter open API) for all active currencies against base currency (INR), including pegged GCC currencies (AED, SAR, QAR, OMR, BHD, KWD). Finance and Admin only (`rate.manage`).
* **Payload**: `{}` (optional note)
* **Response (200)**:
  ```json
  {
    "syncedCount": 35,
    "effectiveOn": "2026-11-13",
    "baseCurrency": "INR",
    "rates": [ ... ]
  }
  ```
* **Rules**:
  * Free, open-source European Central Bank feed requiring no proprietary API keys.
  * Calculates exact 8-decimal conversion rates using BigInt minor-unit arithmetic.
  * Records an atomic `rate.record` audit event in the same transaction.

---

## 10. The Manual

### `GET /api/v1/permissions/matrix`
The permission matrix, role by role. The in-app manual draws its "who can do what" table from this, so the table is the real matrix rather than a copy somebody has to remember to update.
* **Response (200)**:
  ```json
  {
    "roles": [
      { "code": "employee", "name": "Traveller", "permissions": ["trip.create", "..."] }
    ],
    "permissions": ["advance.manage", "..."]
  }
  ```
* **Rules**: open to any signed-in user. Permission names are not a secret — the interface already shows each person which screens they have — and nothing here grants anything.

---

## 11. Administration Endpoints

### `GET /api/v1/employees`
Lists employees with optional filters (`departmentId`, `status`, `search`).

### `POST /api/v1/employees`
Creates an employee in a designated department and cost center.

### `PATCH /api/v1/employees/:id`
Updates employee profile fields (name, location, designation, managerId, grade).

### `PATCH /api/v1/employees/:id/roles`
Assigns roles (`roles: ['employee', 'manager', 'admin', ...]`). Self-assignment is prohibited.

### `PATCH /api/v1/employees/:id/status`
Deactivates or reactivates an employee (`{ "status": "active" | "inactive" }`). Deactivating an employee revokes their active sessions and invalidates reporting routes.

### `POST /api/v1/employees/:id/invite`
Issues a one-time password invitation link and sends it to the employee's work email.

### `POST /api/v1/employees/import`
Bulk imports employee rows in tab-separated or comma-separated format. Supports dry run verification (`{ "text": "...", "dryRun": true }`).

### `GET /api/v1/departments`
Lists all active departments and their child cost centers.

### `POST /api/v1/departments`
Creates a department (`{ "code": "MKT", "name": "Marketing", "headId": "emp_..." }`).

### `PATCH /api/v1/departments/:id`
Updates department details (`code`, `name`, `headId`).

### `GET /api/v1/cost-centers`
Lists active cost centers with their associated departments.

### `GET /api/v1/audit`
Returns the append-only audit trail with actor details and state transitions. Restricted to users with `audit.read` (Admin).
