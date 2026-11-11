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

---

## 3. Trips Endpoints

### `GET /api/v1/trips`
Lists trips based on the caller's authorized scope.
* **Query Parameters**:
  * `scope` (`own` | `team` | `all`): Defaults to user's highest allowed scope or `own`.
  * `status` (`draft` | `submitted` | `approved` | `rejected`): Filter by status.
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
    "destination": "Tokyo",
    "purpose": "Client Q4 Roadmap Review",
    "startDate": "2026-12-10",
    "endDate": "2026-12-15"
  }
  ```
* **Validation**:
  * `destination`: Non-empty, max 100 chars.
  * `purpose`: Non-empty, max 300 chars.
  * `startDate` & `endDate`: Valid `YYYY-MM-DD` format.
  * `endDate >= startDate`.
* **Response (201)**: `{ "trip": { ... } }`

### `GET /api/v1/trips/:id`
Retrieves a single trip and its attached itemized expenses.
* **Response (200)**:
  ```json
  {
    "trip": {
      "id": "trp_...",
      "destination": "Tokyo",
      "status": "submitted",
      "expenses": [ ... ]
    }
  }
  ```
* **Security**: If the caller has no scope to view this trip, returns `404 Not Found`.

### `PATCH /api/v1/trips/:id`
Updates destination, purpose, or dates on a **draft** trip.
* **Security & State**: Returns `409 Conflict` if the trip is not in `draft` status.

### `POST /api/v1/trips/:id/submit`
Submits a draft trip for management approval.
* **Rules**:
  * Verifies employee has an active manager in the organization. If none exists, refuses with `422 Unprocessable Entity` (`code: "no_approval_route"`).
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
  * Caller must own the referenced trip, and the trip must be `active` — money cannot be claimed against a trip nobody approved and funded.
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
  * The FIRST allocation moves the trip to `active`, which is when expenses may be recorded.
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
Trip budgets, approvals outstanding, spend, pending settlements and employee-wise totals — scoped to what the caller may see (their reporting tree, or the company for Finance and Admin).
* **Response (200)**:
  ```json
  {
    "scope": "all",
    "totals": { "trips": 5, "awaiting_approval": 1, "spent_base": "330502.50", "funds_base": "333000.00" },
    "trips": [ ... ],
    "employees": [ ... ],
    "settlements": [ ... ]
  }
  ```

### `GET /api/v1/reports/export.csv?kind=employees|trips`
The report as CSV — RFC 4180 quoting, so it opens in Excel and Numbers without a converter.

---

## 9. Administration Endpoints

### `GET /api/v1/employees`
Lists employees with optional filters (`departmentId`, `status`, `search`).

### `POST /api/v1/employees`
Creates an employee in a designated department and cost center.

### `PATCH /api/v1/employees/:id`
Updates employee profile fields (name, location, designation, managerId, grade).

### `PATCH /api/v1/employees/:id/roles`
Assigns roles (`roles: ['employee', 'manager', 'admin', ...]`). Self-assignment is prohibited.

### `GET /api/v1/departments`
Lists all active departments and their child cost centers.

### `GET /api/v1/audit`
Returns the append-only audit trail with actor details and state transitions. Restricted to users with `audit.read` (Admin).
