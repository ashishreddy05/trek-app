# Trek Product Architecture & Field Operations Playbook (`docs/prepare.md`)

This document provides a comprehensive, end-to-end operational guide and technical architectural reference for Trek — GaragePlug's employee travel, budget planning, multi-currency forex management, and expense reconciliation system.

---

## 1. The Executive Problem & Solution

### 1.1 The Legacy Problem
Historically, customer success representatives, sales executives, and field engineers travelling for client implementations (such as automotive workshops, multi-brand service centers, and enterprise dealerships across the UAE, Saudi Arabia, the US, and Europe) were burdened by manual, fragmented processes:
- Budget estimates were prepared on unstructured CSV spreadsheets.
- Currency conversions were guessed or pulled from inconsistent sources, creating arithmetic disputes.
- Manager approvals were scattered across emails and chat messages with no audit trail.
- Advance disbursement (physical cash in hand and corporate forex cards) lacked clear ledger visibility.
- On-the-road paper receipts were lost, faded, or submitted weeks after travel concluded.
- Post-trip financial reconciliation — calculating whether an employee had surplus advance cash to return or needed reimbursement for personal out-of-pocket expenses — took weeks of accounting back-and-forth.

### 1.2 The Trek Digital Solution
Trek completely digitalizes this workflow into a unified, zero-framework web platform built with strict financial invariants:
1. **Contextual Itinerary & Hub Planning**: Direct integration with Google Flights, Skyscanner, and Google Maps automotive client clusters (e.g. Al Quoz & Ras Al Khor in Dubai, Riyadh Industrial City, Detroit Metro).
2. **Centralized Multi-Currency Registry & Live ECB Sync**: Supports 50+ global currencies with automated, zero-key synchronization from the European Central Bank (ECB) reference rates, plus exact derivations for pegged currencies (AED, SAR, QAR, OMR, BHD, KWD).
3. **Deterministic 8-Stage Lifecycle**: Enforced strictly server-side with transitive reporting manager approvals resolved via PostgreSQL recursive CTEs.
4. **Active Command Center**: Live dashboard fuel gauge tracking advance consumption and cash remaining in hand during travel.
5. **In-App Receipt Digitization**: Camera photo scanner and file uploader that downsizes high-resolution receipts client-side in browser memory before transmission.
6. **3-Column Reconciliation Settlement Ledger**: Instant mathematical clarity: `Advance Received` vs `Approved Spend` = `Net Balance` (Surplus Return vs Corporate Reimbursement).
7. **Immutable Audit Trail**: Append-only PostgreSQL audit events recorded atomically in the same database transaction as the state change.

---

## 2. End-to-End Operational Lifecycle

```
[ 1. Draft Plan ] ──> [ 2. Manager Review ] ──> [ 3. Treasury Funding ]
        │                       │                         │
  Itinerary, Flights,     Recursive CTE             Disburse Cash
  Budget, Forex Plan       Approval / Changes        & Load Forex Card
                                                          │
                                                          ▼
[ 5. Settlement & Close ] <── [ 4. Reconciliation ] <── [ Active Travel ]
        │                               │                         │
  Surplus Return /             3-Column Ledger:             Log Daily Claims,
  Personal Reimbursement        Advance vs Spend             Scan Receipts
```

### Stage 1: Trip Creation & Smart Planning
- **Actor**: Traveller (Customer Success, Sales, Field Engineer).
- **Actions**:
  - Open `My trips` → `New trip`.
  - Enter Destination, Purpose, Travel Dates, and primary spending Currency.
  - Utilize the **Travel & Automotive Field Assistant** card to inspect:
    - Pre-filled Google Flights search from home base (Bengaluru / BLR) for travel dates.
    - Skyscanner fare comparison across airline carriers.
    - Destination-specific automotive industry clusters on Google Maps (Al Quoz & Ras Al Khor in Dubai; Sanaiya in Riyadh; Detroit Metro OEM centers).
    - Real-time Google Finance currency comparison.
  - Add itemized budget estimates (Travel, Accommodation, Meals, Local Taxi, Visa, SIM Card, Client Hospitality).
  - Configure the foreign currency plan: cash advance requested, forex card load requested, and exchange rate to base currency.

### Stage 2: Managerial Approval Hierarchy
- **Actor**: Direct Reporting Manager (or Admin).
- **Authority**: Scoped strictly to the manager's transitive reporting tree resolved via recursive CTE.
- **Actions**:
  - Review under `Approvals` → `Submitted Trips`.
  - Decisions:
    - **Approve**: Locks the budget and advances the trip to `approved`.
    - **Request Changes**: Unlocks the draft and returns it to the traveller with a mandatory explanatory comment.
    - **Reject**: Formally terminates the request with a documented reason.

### Stage 3: Treasury Fund Disbursement
- **Actor**: Finance or HR / Travel Desk.
- **Actions**:
  - Inspect approved trip under `Funds issued`.
  - Issue funds: physical cash in hand, corporate forex card allocations, or intermediate travel tranches.
  - Recording the first fund allocation automatically transitions the trip to **Active**.

### Stage 4: On-The-Road Expense Logging & Receipt Scanning
- **Actor**: Traveller.
- **Actions**:
  - Check the **Active Trip Command Center** on the Dashboard: observe the live progress fuel gauge (% spent of advance) and cash in hand.
  - Log expenses in real time: Date, Category, Description, Exact Amount, Currency, and Payment Method (`Cash`, `Forex Card`, `Personal Card`).
  - Capture paper receipts immediately via the **In-App Camera Scanner** (utilizing device camera stream) or drag-and-drop file uploader. Receipts are downscaled client-side to 1600px max before upload to save bandwidth.
  - Submit each expense to the reporting manager for verification.

### Stage 5: Final Reconciliation Calculation
- **Actor**: Traveller upon returning from travel.
- **Prerequisite**: Every logged expense must be decided (`approved` or `rejected`) by management.
- **Computation**:
  $$\text{Balance} = \text{Total Funds Disbursed} - \text{Total Approved Spend}$$
  - **Positive Balance ($> 0$)**: Traveller holds unspent company cash and must return the surplus to treasury.
  - **Negative Balance ($< 0$)**: Traveller spent personal funds on company business; company owes reimbursement.
- **Submission**: Traveller submits reconciliation for final Finance audit.

### Stage 6: Finance Audit, Settlement & Immutable Closure
- **Actor**: Finance & Treasury.
- **Actions**:
  - Finance audits the 3-column reconciliation ledger, inspects receipts, and approves the reconciliation.
  - Execute settlement: record bank transfer reference for employee reimbursement, or verify cash deposit for returned surplus.
  - Trip is marked **Closed**. Once closed, no further expenses, budget modifications, or funding adjustments can ever be made.

---

## 3. Financial Engineering & Currency Engine

### 3.1 Strict Financial Invariants
Trek implements absolute zero-tolerance guards against monetary inaccuracies:
- **No Floating-Point Financial Math**: JavaScript IEEE-754 numbers (`Number.parseFloat`, `Math.round`) are completely banned from money and exchange rate calculations. All stored and converted monetary amounts strictly use BigInt minor units and PostgreSQL `NUMERIC` (non-monetary UI gauges, such as the advance-utilisation progress bar, compute visual percentages only).
- **BigInt Minor Units**: All financial operations (`src/money.js`) execute using integer minor units (paise, cents, fils) held in native JavaScript `BigInt`.
- **Database Precision**: Amounts are stored in PostgreSQL as `NUMERIC(14,2)` and exchange rates as `NUMERIC(20,8)`.
- **Exact Decimal Strings**: Validated against `/^\d+(\.\d{1,2})?$/` on input and output.
- **Snapshot Immutability**: Every transaction records `rate_to_base` and `base_amount`. Changing an exchange rate tomorrow never retroactively rewrites historical booked expenditures.
- **Truncation Over Rounding**: Currency conversions truncate minor units toward zero rather than rounding up, guaranteeing a converted figure never invents money out of thin air.

### 3.2 Automated Live European Central Bank (ECB) Forex Sync
- **Endpoint**: `POST /api/v1/exchange-rates/sync` (gated on permission `rate.manage`).
- **Data Source**: European Central Bank reference exchange rates via open public Frankfurter API (`https://api.frankfurter.dev/v1/latest?base=EUR`).
- **Zero Proprietary Keys**: 100% open-source, public data feed requiring no API keys.
- **Computation**:
  - Computes EUR/INR rate.
  - Calculates cross rates against INR for 30+ ECB global currencies:
    $$\text{Rate}(C \to \text{INR}) = \frac{\text{Rate}(\text{EUR} \to \text{INR})}{\text{Rate}(\text{EUR} \to C)}$$
  - Derives exact rates for official US Dollar pegged currencies:
    - **UAE Dirham (AED)**: $\frac{\text{USD/INR}}{3.6725}$
    - **Saudi Riyal (SAR)**: $\frac{\text{USD/INR}}{3.7500}$
    - **Qatari Riyal (QAR)**: $\frac{\text{USD/INR}}{3.6400}$
    - **Omani Rial (OMR)**: $\frac{\text{USD/INR}}{0.2723}$
    - **Bahraini Dinar (BHD)**: $\frac{\text{USD/INR}}{0.3845}$
    - **Kuwaiti Dinar (KWD)**: $\frac{\text{USD/INR}}{0.3080}$
    - **Jordanian Dinar (JOD)**: $\frac{\text{USD/INR}}{0.7090}$
- **Audit Logging**: Emits an atomic `rate.record` audit event logging total currencies updated and effective date.

---

## 4. UI/UX Design System (CarbonCN)

Trek is built strictly on **CarbonCN** — GaragePlug's design system:
- **Tokens**: Spacing scale (`--carbon-01` through `--carbon-10`, based on an 8px grid), motion curves (`--motion-productive`, `--motion-expressive`), and semantic colors (`--interactive`, `--support-error`, `--border-subtle-01`).
- **Zero Radius**: Carbon components maintain square corners (`--radius: 0px`). True circles (`50%`) are used only for status dots and avatars.
- **Zero Inline Styles**: Enforced by Content Security Policy (`style-src-attr 'none'`). All styling is applied via semantic utility classes defined in `public/styles.css`.
- **Self-Hosted Typography**: IBM Plex Sans (weights 300, 400, 500, 600) and IBM Plex Mono served locally from `public/fonts/` with zero third-party dependencies.
- **Accessible Dialogs**: All modals and drawers (`role="dialog" aria-modal="true"`) trap focus on open, release focus on close, and handle Escape cleanly.

---

## 5. In-App Operations Handbook (`public/manual.js`)

The in-app manual is an integrated, offline-capable handbook:
- Opens from the `?` icon in the sidebar and provides full instant search across all topics.
- Data-driven and verified by automated tests (`test/manual.test.js`).
- Contains 12 dedicated sections:
  1. **Getting started**: Complete onboarding and travel lifecycle overview.
  2. **Capabilities**: Full matrix table drawn live from `GET /api/v1/permissions/matrix`.
  3. **The workflow**: 8-stage lifecycle detailing roles, inputs, and outputs.
  4. **Who can do what**: Role responsibilities, permission scoping, and opaque denials.
  5. **States**: Complete state machine reference for trips and expenses.
  6. **Money**: Exact decimal rules, BigInt minor units, and snapshot immutability.
  7. **Currencies & rates**: Registry, ECB live sync, and pegged currency math.
  8. **How do I… (Recipes)**: 16+ step-by-step guides for everyday tasks.
  9. **When something goes wrong**: Verbatim quoted error messages and exact resolutions.
  10. **The screens**: Comprehensive overview of all application views and drawers.
  11. **Words**: Domain glossary and financial definitions.
  12. **Reference**: Architecture rules, security principles, and system invariants.

---

## 6. Verification & Security Invariants

Before releasing or deploying changes:
1. **Security Scan**:
   ```bash
   npm run check:no-bypass
   ```
   Ensures zero authentication bypasses, zero credential leaks in response bodies, and valid staging protections.
2. **Frontend & Design System Invariant Suite**:
   ```bash
   node --env-file-if-exists=.env --test --test-name-pattern="static assets" test/pilot.frontend.test.js
   ```
   Asserts zero inline styles, 100% defined CSS classes, Carbon tokens, and cache header correctness.
3. **Manual & Navigation Verification**:
   ```bash
   node --env-file-if-exists=.env --test test/manual.test.js test/nav.permissions.test.js test/currency.test.js
   ```
   Asserts that the manual matches 100% of the permission matrix, quoting only real error messages, states, and endpoints.
