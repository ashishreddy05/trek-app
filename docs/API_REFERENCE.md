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
        "employee_code": "TEST-ADMIN",
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
    "category": "transport",
    "amount": "85.50",
    "currency": "USD"
  }
  ```
* **Validation**:
  * `category`: One of `meals`, `lodging`, `transport`, `airfare`, `supplies`, `other`.
  * `amount`: Exact positive decimal string with up to 2 decimal places.
  * `currency`: 3-letter uppercase ISO currency code.
  * Caller must own the referenced trip.
* **Response (201)**: `{ "expense": { ... } }`

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

## 5. Administration Endpoints

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
