/* The Trek manual.
 *
 * A complete operational handbook and guide inside the app, not a document
 * somebody has to find. It opens from a small icon in the sidebar, works
 * offline, and is fully searchable across every section, recipe, and error.
 *
 * The content is DATA, not markup: the same strings can be checked against the
 * code, and a section that names an endpoint or error message is verified
 * to exist.
 *
 * The roles table is the one part that could drift, so it is NOT prose: it is
 * a list of capabilities and the permissions behind them, and the test suite
 * checks the table against the real permission matrix. If a role gains or
 * loses a permission, the manual fails the build until the table is corrected.
 */

const MANUAL = {
  /* ------------------------------------------------------------------ the
   * first five minutes & onboarding guide. */
  gettingStarted: {
    title: 'Getting started',
    intro: 'Trek is where a business trip and its money are planned, approved, funded, spent, reconciled and settled. Designed specifically for customer success, sales, and field engineering teams conducting on-site client visits, dealership audits, and automotive workshop consultations across the globe.',
    steps: [
      { t: '1. Sign in & authenticate', d: 'Use your company work email and password. Session authentication uses cryptographically secure, HttpOnly cookies with SHA-256 session token hashing. If you have forgotten your password, click “Forgot password?” on the sign-in card — a secure reset link is emailed directly to your work address.' },
      { t: '2. Check your command center', d: 'After signing in, you land on the dashboard. It displays headline metrics (total budget in flight, active spend, issued funds, net pending balances), an Active Trip Command Center with a live fuel gauge and remaining cash in hand, and items waiting on your immediate decision. Everything is strictly scoped to what you are authorized to see — your own travel, your reporting tree, or the entire company.' },
      { t: '3. Set your contact information', d: 'Navigate to My profile → Contact number. This is the only profile field you can modify directly; your department, corporate grade, reporting manager, and system roles are configured by a System Administrator under Employees.' },
      { t: '4. Create a new trip draft', d: 'Go to My trips → New trip. Enter your departure city and destination (e.g. “Dubai, UAE”, “Riyadh, Saudi Arabia”, “Detroit, USA”), business purpose, travel dates, and the primary transaction currency you will spend in. The departure city is never assumed for a trip — check any pre-filled city and correct it. For a trip through more than one city, add each itinerary leg in order, including the return leg, and record any own funds you already have for the trip in company base currency. Trek saves it as an isolated draft visible only to you until you choose to submit it.' },
      { t: '5. Plan travel & automotive hubs', d: 'Use the built-in Travel & Automotive Field Assistant inside your trip. It generates smart pre-filled deep links to Google Flights and Skyscanner (originating from your trip’s departure city for your exact travel dates) and Google Maps links directly to automotive client clusters (such as Al Quoz & Ras Al Khor in Dubai, Riyadh Industrial City, or Detroit Metro automotive service centers).' },
      { t: '6. Build the itemized budget', d: 'Open your trip draft and add estimated budget lines (Travel, Accommodation, Meals, Local Taxi, Visa, SIM card, Other). Every line requires a description, amount, and currency. A trip cannot be submitted without at least one budget estimate, because the budget is the formal expenditure contract your manager reviews and approves.' },
      { t: '7. Set the currency & forex plan', d: 'For each currency you will spend in, specify how much cash you need to carry, how much should be loaded onto a corporate forex card, the exchange rate to base currency, and any associated bank charges (GST, top-up fees, card issuance charges). Trek automatically looks up and offers the latest remembered rate.' },
      { t: '8. Sync live market forex rates', d: 'If today’s live forex rate has moved or the company rate is outdated, Finance and Admin can synchronize live market rates directly from the European Central Bank (ECB) with a single click in the Exchange Rates drawer. You can also compare rates on Google Finance in real time.' },
      { t: '9. Submit for manager approval', d: 'Click “Submit for approval”. Trek checks your reporting hierarchy and routes the trip to your active reporting manager via recursive CTE. The trip is now locked while under review.' },
      { t: '10. Fund disbursement & on-trip tracking', d: 'Once your manager approves the trip, Finance or Admin issues the authorized funds (cash handover and forex card loads). The first fund issuance moves the trip to Active and unlocks expense logging. Expenses can only be recorded once the trip is Active — the approval alone is not enough. As you travel, log each expense in real time, choose whether you paid via Cash, Forex Card or Personal Card, and scan paper receipts using the in-app camera or file uploader. If your own funds cover the full budget, Finance may still issue a nominal allocation to activate the trip.' },
      { t: '11. Final reconciliation & settlement', d: 'Upon returning, submit the trip for final reconciliation. Trek compiles a 3-column ledger: Total Funds Issued vs Total Approved Expenses = Net Settlement Balance. If you spent less than your advance, you return the remaining surplus to company accounts. If you spent personal funds on company business, the company reimburses you. Finance approves the reconciliation, records the settlement, and formally closes the trip.' },
    ],
    notes: [
      'If a trip you submit comes back with a reason, fix it and submit again. The reason is always shown to you.',
      'If nothing you submit can be approved, you do not have an active reporting manager assigned. An Admin sets your reporting line under Employees.',
      'The manual opens from the “?” at the foot of the sidebar, and everything in it is searchable.',
      'Trek enforces strict snapshot immutability: once an expense or budget line is recorded, its exchange rate and base amount are permanently locked and will never be altered by future rate fluctuations.',
    ],
  },

  /* ------------------------------------------------------------------ the
   * complete catalogue: everything the application can do, and who can do
   * it. The marks are drawn from the live permission matrix, so this table
   * cannot say something the server would refuse. */
  catalogue: {
    title: 'Capabilities',
    intro: 'Everything Trek can do, area by area, with the screen it lives on. The marks are read from the live permission matrix — the same one the server enforces — so this table cannot promise something the API would refuse.',
    matrix: [
      { role: 'Traveller', code: 'employee' },
      { role: 'Manager', code: 'manager' },
      { role: 'Travel desk', code: 'hr_travel' },
      { role: 'Finance', code: 'finance' },
      { role: 'Admin', code: 'admin' },
    ],
    areas: [
      {
        area: 'Signing in and your account',
        items: [
          { t: 'Sign in with your work email and password', op: 'auth.login', perms: [], where: 'The sign-in card' },
          { t: 'Ask for a password reset link', op: 'auth.forgotPassword', perms: [], where: 'Sign in → Forgot password?' },
          { t: 'Check that an invite or reset link still works', op: 'auth.checkLink', perms: [], where: 'The link in your email' },
          { t: 'Set a password from an invite or reset link', op: 'auth.resetPassword', perms: [], where: 'The link in your email' },
          { t: 'Change your password', op: 'auth.changePassword', perms: [], where: 'My profile → Change password' },
          { t: 'Read your own record, roles and permissions', op: 'me.read', perms: [], where: 'Every screen — it decides what you see' },
          { t: 'Update your contact number', op: 'me.update', perms: [], where: 'My profile → Contact number' },
          { t: 'Sign out', op: 'auth.logout', perms: [], where: 'The sidebar' },
        ],
      },
      {
        area: 'People and organisation',
        items: [
          { t: 'See the employee directory', op: 'employee.list', perms: ['employee.manage', 'trip.read.team', 'trip.read.all', 'expense.read.all'], where: 'Employees' },
          { t: 'Open one employee’s record', op: 'employee.read', perms: ['employee.manage', 'trip.read.team', 'trip.read.all', 'expense.read.all'], where: 'Employees → a person' },
          { t: 'Add an employee', op: 'employee.create', perms: ['employee.manage'], where: 'Employees → Add' },
          { t: 'Update an employee’s details, reporting line, department or grade', op: 'employee.update', perms: ['employee.manage'], where: 'Employees → Edit' },
          { t: 'Assign or change roles', op: 'employee.updateRoles', perms: ['role.manage'], where: 'Employees → Roles' },
          { t: 'Deactivate or reactivate an account', op: 'employee.updateStatus', perms: ['employee.manage'], where: 'Employees → Deactivate' },
          { t: 'Import employees from a file', op: 'employee.import', perms: ['employee.manage'], where: 'Employees → Import' },
          { t: 'Invite an employee by email', op: 'employee.invite', perms: ['employee.manage'], where: 'Employees → Invite' },
          { t: 'See departments, cost centres and head count', op: 'department.list', perms: [], where: 'Departments' },
          { t: 'Create a department', op: 'department.create', perms: ['department.manage'], where: 'Departments → Add' },
          { t: 'Update a department', op: 'department.update', perms: ['department.manage'], where: 'Departments → Edit' },
          { t: 'See the cost-centre list', op: 'costcenter.list', perms: [], where: 'Departments → a department' },
        ],
      },
      {
        area: 'Trips',
        items: [
          { t: 'See the trips in scope — yours, your team’s or the company’s', op: 'trip.list', perms: ['trip.read.own', 'trip.read.team', 'trip.read.all'], where: 'My trips' },
          { t: 'Open a trip and read everything on it', op: 'trip.read', perms: ['trip.read.own', 'trip.read.team', 'trip.read.all'], where: 'My trips → a trip' },
          { t: 'Create a trip', op: 'trip.create', perms: ['trip.create'], where: 'My trips → New trip' },
          { t: 'Edit a draft trip', op: 'trip.update', perms: ['trip.create'], where: 'A trip → Edit trip' },
          { t: 'Submit a trip for approval', op: 'trip.submit', perms: ['trip.create'], where: 'A trip → Submit for approval' },
          { t: 'Decide a trip — approve, request changes or reject', op: 'trip.decide', perms: ['trip.approve', 'trip.approve.all'], where: 'Approvals → Submitted Trips' },
          { t: 'Read the budget and the budget-versus-actual figures', op: 'trip.budget.read', perms: ['trip.read.own', 'trip.read.team', 'trip.read.all'], where: 'A trip → Budget' },
          { t: 'Add, edit and remove budget lines', op: 'trip.budget.manage', perms: ['trip.budget.manage'], where: 'A trip → Budget → Add line' },
          { t: 'Read the currency plan', op: 'trip.fx.read', perms: ['trip.read.own', 'trip.read.team', 'trip.read.all'], where: 'A trip → Currency & forex plan' },
          { t: 'Set the currency plan — cash, forex card, rate and charges', op: 'trip.fx.manage', perms: ['trip.fx.manage'], where: 'A trip → Currency & forex plan → Add currency' },
          { t: 'Read the funds issued', op: 'trip.fund.list', perms: ['trip.read.own', 'trip.read.team', 'trip.read.all'], where: 'A trip → Funds issued' },
          { t: 'Issue funds — cash, forex card or a further tranche', op: 'trip.fund.create', perms: ['trip.fund.manage'], where: 'A trip → Issue funds' },
        ],
      },
      {
        area: 'Expenses and receipts',
        items: [
          { t: 'See the expenses in scope', op: 'expense.list', perms: ['expense.read.own', 'expense.read.team', 'expense.read.all'], where: 'My expenses' },
          { t: 'Open an expense', op: 'expense.read', perms: ['expense.read.own', 'expense.read.team', 'expense.read.all'], where: 'My expenses → an expense' },
          { t: 'Record an expense', op: 'expense.create', perms: ['expense.create'], where: 'A trip → Add expense' },
          { t: 'Edit an expense', op: 'expense.update', perms: ['expense.create'], where: 'My expenses → Edit' },
          { t: 'Delete a draft expense', op: 'expense.delete', perms: ['expense.create'], where: 'My expenses → Delete' },
          { t: 'Submit an expense for approval', op: 'expense.submit', perms: ['expense.create'], where: 'My expenses → Submit' },
          { t: 'Decide an expense — approve or reject', op: 'expense.decide', perms: ['expense.approve', 'expense.approve.all'], where: 'Approvals → Submitted Expenses' },
          { t: 'Upload a receipt — photo, PDF, or scan one with the camera', op: 'bill.create', perms: ['bill.upload'], where: 'A trip → Bills → Add receipt' },
          { t: 'Read receipts', op: 'bill.read', perms: ['bill.read.own', 'trip.read.team', 'bill.read.all'], where: 'A trip → Bills' },
          { t: 'Delete a receipt', op: 'bill.delete', perms: ['bill.upload'], where: 'A trip → Bills → Delete' },
        ],
      },
      {
        area: 'Closing a trip',
        items: [
          { t: 'Read the reconciliation and the balance', op: 'trip.reconciliation.read', perms: ['trip.read.own', 'trip.read.team', 'trip.read.all'], where: 'A trip → Reconciliation' },
          { t: 'Submit a trip for reconciliation', op: 'trip.reconciliation.submit', perms: ['trip.reconcile.submit'], where: 'A trip → Submit reconciliation' },
          { t: 'Decide the reconciliation — approve or send back', op: 'trip.reconciliation.decide', perms: ['trip.reconcile.decide'], where: 'A trip → Reconciliation → Decide' },
          { t: 'Settle the balance and close the trip', op: 'trip.settle', perms: ['trip.settle'], where: 'A trip → Settle & close' },
        ],
      },
      {
        area: 'Reporting, currencies and the audit trail',
        items: [
          { t: 'Read the dashboard — the figures, what needs you, and recent trips', op: 'dashboard.read', perms: ['trip.read.own', 'report.team', 'report.finance', 'report.all'], where: 'Dashboard' },
          { t: 'Read the dashboard in another currency', op: 'dashboard.read', perms: ['trip.read.own', 'report.team', 'report.finance', 'report.all'], where: 'Dashboard → Show in' },
          { t: 'Export a report to CSV', op: 'report.export', perms: ['trip.read.own', 'report.team', 'report.finance', 'report.all'], where: 'Dashboard → Export' },
          { t: 'See which currencies Trek knows', op: 'currency.list', perms: [], where: 'Any currency picker' },
          { t: 'See the exchange rates the company has remembered', op: 'rate.list', perms: [], where: 'The currency plan drawer' },
          { t: 'Look up the rate for one currency, in both directions', op: 'rate.list', perms: [], where: 'The currency plan drawer' },
          { t: 'Record an exchange rate', op: 'rate.record', perms: ['rate.manage'], where: 'The API — POST /api/v1/exchange-rates' },
          { t: 'Synchronize exchange rates with the European Central Bank', op: 'rate.sync', perms: ['rate.manage'], where: 'Exchange rates drawer → Sync live rates' },
          { t: 'Read the permission matrix', op: 'permission.matrix', perms: [], where: 'The manual’s capability tables' },
          { t: 'Read the full audit log', op: 'audit.read', perms: ['audit.read'], where: 'Audit log' },
          { t: 'Open the manual and search it', op: null, perms: [], where: 'The ? at the foot of the sidebar' },
        ],
      },
    ],
    reserved: {
      title: 'Reserved for later',
      intro: 'These permissions are declared in the matrix but no screen or endpoint reaches them yet. They are listed so the matrix and this manual cannot quietly disagree — if one of them ever becomes a real capability, it moves up into the tables above.',
      items: [
        { t: 'Request an advance (advance.request)' },
        { t: 'Manage advances (advance.manage)' },
        { t: 'Post a settlement directly (settlement.post)' },
        { t: 'Read your own settlements (settlement.read.own)' },
        { t: 'Manage travel documents (document.manage)' },
        { t: 'Read and write your own documents (document.read.own, document.write.own)' },
        { t: 'Manage bookings (booking.manage)' },
        { t: 'Manage delegates (delegate.manage)' },
        { t: 'Review expenses across the company (expense.review)' },
        { t: 'Manage policies (policy.manage)' },
        { t: 'Manage workflows (workflow.manage)' },
        { t: 'Manage cost centres (costcenter.manage)' },
        { t: 'Revoke your other sessions (session.revokeOwn)' },
      ],
    },
  },

  /* ------------------------------------------------------------------ the
   * workflow, stage by stage. Every stage says who acts, what they see, and
   * what unlocks next — the questions a new user actually has. */
  workflow: {
    title: 'The workflow',
    intro: 'A business trip moves through eight deterministic stages. Money only moves forward, every decision creates an immutable audit log, and each stage unlocks exactly one capability.',
    stages: [
      {
        n: 1,
        name: 'Trip creation & smart planning',
        who: 'Traveller (CS Rep, Sales, Field Engineer)',
        what: 'Open My trips and create a new trip draft. Enter the departure city — never assumed by the server — destination, business purpose, travel dates, and primary currency. For a multi-city trip, add each itinerary leg (from city, to city, departure date) in order. Record any own funds you already have for the trip in company base currency. Use the integrated Travel Assistant to search Google Flights, Skyscanner, and map automotive workshop client clusters in destination cities.',
        note: 'Saved strictly as a private draft. Invisible to managers and finance until submitted. The departure city and itinerary drive the flight searches, so the return leg belongs in the itinerary too.',
      },
      {
        n: 2,
        name: 'Budget & multi-currency planning',
        who: 'Traveller',
        what: 'Add itemized expense estimates across categories (Travel, Accommodation, Food, Local Taxi, Visa, SIM Card, Client Hospitality). Configure the currency plan for foreign currencies: cash advance needed, corporate forex card load, exchange rate to base currency, and bank markup/GST/top-up fees.',
        note: 'Every foreign currency needs a remembered exchange rate. Money in company base currency (INR) needs no rate (identity 1.00000000).',
      },
      {
        n: 3,
        name: 'Managerial approval hierarchy',
        who: 'Direct Reporting Manager (or Admin)',
        what: 'Your reporting manager inspects the full trip itinerary, budget breakdown, and currency plan under Approvals → Submitted Trips. The manager selects one of three decisions: Approve, Request Changes (with mandatory explanatory reason), or Reject (with mandatory reason).',
        note: 'Request changes sends the trip back to the traveller for revision and resubmission. Rejection terminates the request permanently.',
      },
      {
        n: 4,
        name: 'Fund allocation & treasury disbursement',
        who: 'Finance or HR / Travel Desk',
        what: 'Following budget approval, Finance issues the authorized funds: physical cash in hand, corporate forex card loads, or intermediate travel tranches. The funding summary shows the approved budget, the traveller’s own funds, and the amount requested from the company — the budget total minus own funds, never below zero — frozen when the trip is submitted. Each allocation records the precise disbursement date, amount, currency, and payment reference.',
        note: 'The very first fund allocation automatically activates the trip and unlocks expense logging. Until funds are issued, expenses cannot be recorded — the trip must be Active, not merely Approved. If the traveller carries their own funds, those reduce the amount requested from the company (budget minus own funds, never below zero), and are reimbursed at reconciliation.',
      },
      {
        n: 5,
        name: 'On-the-road expense logging & digital receipts',
        who: 'Traveller on an active trip (funds issued)',
        what: 'Log each expenditure as it happens: date, category, description, exact amount paid, currency, and payment method (Cash, Forex Card, Personal Card). Expenses are only available on Active trips — funds must be issued first. Capture receipts using the in-app camera scanner or file uploader. Submit each expense to your manager.',
        note: 'The trip must be Active (funds issued) before any expense can be saved. Own-funded spend is reimbursed at reconciliation — record it the same way as any other expense. In-app receipt scanner downsizes high-resolution phone photos in browser memory before uploading.',
      },
      {
        n: 6,
        name: 'Trip completion & reconciliation submission',
        who: 'Traveller',
        what: 'Once travel concludes, submit the trip for final reconciliation. Trek compiles an exact ledger: Total Advances Issued vs Total Approved Expenses = Net Settlement Balance. Every logged expense must be decided by management before reconciliation can be submitted.',
        note: 'A positive balance indicates surplus funds the traveller must return to the company. A negative balance indicates out-of-pocket expenses — including own funds spent on the trip — that the company must reimburse.',
      },
      {
        n: 7,
        name: 'Finance reconciliation audit & decision',
        who: 'Finance / Treasury Auditor',
        what: 'Finance audits the reconciliation ledger, inspects all attached receipts, checks currency conversions, and either approves the reconciliation or sends it back with specific audit queries.',
        note: 'Sending back allows the traveller to attach missing invoices or rectify category classifications.',
      },
      {
        n: 8,
        name: 'Settlement execution & immutable closure',
        who: 'Finance & Treasury',
        what: 'Finance records the final financial settlement (bank transfer reference for employee reimbursement, or treasury cash receipt for surplus unspent advance returned) and formally closes the trip.',
        note: 'A closed trip is physically sealed. No additional expenses, budget lines, or fund allocations can ever be claimed against it.',
      },
    ],
  },

  /* ------------------------------------------------------------------ what
   * each role can and cannot do. The table below is checked against the
   * permission matrix by the test suite. */
  roles: {
    title: 'Who can do what',
    intro: 'Every role in Trek shares the same clean CarbonCN interface, but views and actions are strictly governed by centralized, deny-by-default server authorization. Permissions are verifiable cryptographic facts, not cosmetic UI hints.',
    matrix: [
      { role: 'Traveller', code: 'employee' },
      { role: 'Manager', code: 'manager' },
      { role: 'Travel desk', code: 'hr_travel' },
      { role: 'Finance', code: 'finance' },
      { role: 'Admin', code: 'admin' },
    ],
    capabilities: [
      { label: 'Create a trip', perms: ['trip.create'] },
      { label: 'Prepare the budget and the currency plan', perms: ['trip.budget.manage', 'trip.fx.manage'] },
      { label: 'See and edit own trips', perms: ['trip.read.own'] },
      { label: 'Record expenses', perms: ['expense.create'] },
      { label: 'Upload and read own receipts', perms: ['bill.upload', 'bill.read.own'] },
      { label: 'Read own expenses', perms: ['expense.read.own'] },
      { label: 'Submit for reconciliation', perms: ['trip.reconcile.submit'] },
      { label: 'Request advances and read settlements', perms: ['advance.request', 'settlement.read.own'] },
      { label: 'Manage own documents', perms: ['document.read.own', 'document.write.own'] },
      { label: 'See a reporting tree', perms: ['trip.read.team'] },
      { label: 'Approve budgets in a reporting tree', perms: ['trip.approve'] },
      { label: 'Approve expenses in a reporting tree', perms: ['expense.approve'] },
      { label: 'Read a reporting tree’s expenses', perms: ['expense.read.team'] },
      { label: 'Reporting for a reporting tree', perms: ['report.team'] },
      { label: 'Manage delegates', perms: ['delegate.manage'] },
      { label: 'See every trip in the company', perms: ['trip.read.all'] },
      { label: 'Approve budgets company-wide', perms: ['trip.approve.all'] },
      { label: 'Approve expenses company-wide', perms: ['expense.approve.all'] },
      { label: 'Review expenses company-wide', perms: ['expense.read.all', 'expense.review'] },
      { label: 'Read every receipt in the company', perms: ['bill.read.all'] },
      { label: 'Issue funds', perms: ['trip.fund.manage'] },
      { label: 'Decide a reconciliation', perms: ['trip.reconcile.decide'] },
      { label: 'Settle and close a trip', perms: ['trip.settle'] },
      { label: 'Manage advances and settlements', perms: ['advance.manage', 'settlement.post'] },
      { label: 'Finance reporting and export', perms: ['report.finance'] },
      { label: 'Company reporting and export', perms: ['report.all'] },
      { label: 'Remember exchange rates', perms: ['rate.manage'] },
      { label: 'Manage people and departments', perms: ['employee.manage', 'department.manage'] },
      { label: 'Manage roles', perms: ['role.manage'] },
      { label: 'Configure policies, workflows and cost centres', perms: ['policy.manage', 'workflow.manage', 'costcenter.manage'] },
      { label: 'Read the audit log', perms: ['audit.read'] },
      { label: 'Manage bookings and travel documents', perms: ['booking.manage', 'document.manage'] },
    ],
    rows: [
      { role: 'Traveller', can: 'Create trips, prepare budgets, set multi-currency plans, log daily on-site expenses, scan paper receipts, and submit trips for manager review and post-travel reconciliation.' },
      { role: 'Manager', can: 'Review and decide trips, budgets, and individual expense claims for all employees within their transitive reporting tree (direct reports and indirect descendents via recursive CTE).' },
      { role: 'Finance', can: 'Access company-wide travel records, approve trips and reconciliations organization-wide, issue advance funds (cash & forex cards), execute settlements, synchronize European Central Bank live exchange rates, and export CSV financial reports.' },
      { role: 'Travel desk', can: 'Inspect all company travel bookings, assist employees with itinerary planning, and manage travel documentation and tickets.' },
      { role: 'Admin', can: 'Manage the employee directory, assign reporting managers and departments, grant system roles, inspect immutable audit logs, configure company base currency settings, and synchronize ECB forex rates.' },
    ],
    notes: [
      'A manager can never approve their own request, and can never decide on someone outside their reporting tree.',
      'Company-wide authority and reporting-tree authority are separate permissions. A manager holds the second, never the first.',
      'Someone whose account is deactivated loses access immediately, and every session they had is revoked.',
      'Every role can see its own travel, so the dashboard is never empty for anybody.',
      'Opaque 404 denials: If an unauthorized user attempts to probe another employee’s record by ID, the API returns HTTP 404 Not Found (byte-identical to non-existent records), preventing ID enumeration attacks.',
    ],
  },

  /* ------------------------------------------------------------------ the
   * states a trip and an expense can be in, and what each one allows. */
  states: {
    title: 'States',
    intro: 'The lifecycle stage a record occupies strictly determines what actions are permitted. The server enforces these transitions in a unified state machine — the client UI merely hides buttons that the server would refuse.',
    trip: [
      { s: 'Draft', d: 'The traveller is actively planning itinerary, budget lines, and currency plan. Fully editable and deletable; completely invisible to approvers.' },
      { s: 'Submitted', d: 'Under review by the traveller’s reporting manager. Trip parameters and budget estimates are frozen to prevent tampering during review.' },
      { s: 'Changes requested', d: 'Returned to the traveller by the manager with a required explanation note. Unlocked for editing, updating, and resubmission.' },
      { s: 'Approved', d: 'Budget is agreed and locked by management. Finance or Admin must now issue funds (cash advance or forex card). Expenses are locked until the first fund is issued and the trip becomes Active.' },
      { s: 'Rejected', d: 'Formally refused by management with a documented reason. Permanently closed; if travel is required, a new trip draft must be created.' },
      { s: 'Active', d: 'Funds have been disbursed by Finance and the employee is traveling. Expenses and digital receipts continue to be recorded in real time.' },
      { s: 'Awaiting Finance', d: 'Reconciliation has been calculated and submitted by the traveller upon trip conclusion. Awaiting Finance sign-off.' },
      { s: 'Reconciled', d: 'Finance audit approved the reconciliation balance. Awaiting final payout of reimbursement or collection of surplus unspent advance.' },
      { s: 'Closed', d: 'Final financial settlement recorded. Trip is permanently archived in the immutable ledger. No further money changes permitted.' },
    ],
    expense: [
      { s: 'Draft', d: 'Recorded by the traveller but not yet submitted. Fully editable and deletable.' },
      { s: 'Submitted', d: 'Submitted to the reporting manager for verification. Locked against edits while pending review.' },
      { s: 'Approved', d: 'Approved by management. Included in the final trip expenditure total and counted toward reconciliation balance.' },
      { s: 'Rejected', d: 'Refused by management with a documented reason. Excluded from company reconciliation totals.' },
    ],
    notes: [
      'A trip moves forward only. A change request sends it back to you; nothing else does.',
      'A rejected trip is finished. Raise a new one if the travel is still needed — a rejected trip cannot be reopened.',
      'An expense that has been submitted cannot be deleted. The decision is recorded; raise a correcting expense instead.',
      'State transitions are enforced server-side. Any out-of-order transition request is immediately rejected with HTTP 409 invalid_transition.',
    ],
  },

  /* ------------------------------------------------------------------ the
   * money rules, because these are the ones that bite. */
  money: {
    title: 'Money',
    intro: 'Financial calculations in Trek follow absolute zero-tolerance rules. A reimbursement off by a single paisa is an unacceptable defect, so floating-point arithmetic is banned throughout the entire application.',
    rules: [
      { t: 'Amounts are exact decimals', d: 'Monetary amounts are stored in PostgreSQL as NUMERIC(14,2) and handled in JavaScript as exact strings validated against /^\\d+(\\.\\d{1,2})?$/. IEEE-754 floating point numbers (parseFloat, Math.round) are forbidden.' },
      { t: 'BigInt minor units', d: 'All internal financial arithmetic runs in integer counts of minor units (paise, cents, fils) held in native JavaScript BigInt inside src/money.js. Rounding follows PostgreSQL half-up behavior exactly.' },
      { t: 'Rates are remembered snapshots, not fetched on the fly', d: 'Trek remembers exchange rates recorded by company Finance or synced on demand from the European Central Bank, and offers them as defaults. Rates are never fetched on the fly during spending to modify booked expenditures — an unannounced rate change is not a rate anyone agreed to.' },
      { t: 'Conversions are immutable snapshots', d: 'Every budget line, logged expense, and fund disbursement stores its transaction currency, the exchange rate applied (rate_to_base), and the converted base amount (base_amount). Subsequent rate updates never touch booked records.' },
      { t: 'The base currency is the company’s', d: 'The default company base currency is INR, read dynamically from the company database record. All budget-versus-actual analysis and reconciliations are computed in the base currency for apples-to-apples consistency.' },
      { t: 'Converted figures are truncated, never rounded', d: 'When converting money between foreign currencies and base currency, converted minor units are truncated toward zero rather than rounded up. A conversion can lose a fraction of a paisa; it must never invent money from nothing.' },
      { t: 'Showing a report in another currency changes nothing', d: 'The dashboard “Show in” currency selector allows readers to inspect figures in foreign currencies (e.g. USD, EUR, AED). This alters presentation only; stored numbers remain immutable.' },
      { t: 'One category vocabulary', d: 'Budget estimates and actual expense claims share an identical category taxonomy (Travel, Accommodation, Food, Visa, SIM Card, Other), ensuring budget-vs-actual variance tracking compares identical categories.' },
      { t: 'The balance tells you who owes whom', d: 'A positive reconciliation balance indicates surplus company cash the employee must return. A negative balance indicates out-of-pocket expenses the company must reimburse.' },
    ],
  },

  /* ------------------------------------------------------------------ the
   * currencies Trek knows, and the rates it remembers. */
  currencies: {
    title: 'Currencies & rates',
    intro: 'Nobody has to remember or guess foreign exchange rates. Trek maintains a central registry of 50+ global currencies, provides one-click European Central Bank live synchronization, and offers remembered rates automatically across all travel workflows.',
    rules: [
      { t: 'One list of currencies', d: 'Trek maintains an authoritative registry of 52 global currencies (including USD, EUR, GBP, SAR, AED, INR, SGD, JPY, CAD, AUD, CHF and 41 others). All interface pickers draw from this single authoritative registry (GET /api/v1/currencies).' },
      { t: 'The base currency', d: 'INR. It is a setting on the company record, not a constant in the code, and every stored amount is in it. That is why a trip spent in five currencies still has one comparable number.' },
      { t: 'A remembered rate is a default to offer', d: 'When you open the currency plan, Trek looks up the rate it remembers for that currency and puts it in the box, with the day it took effect. Change it if today’s rate differs — what you type is what is saved.' },
      { t: 'Live European Central Bank (ECB) sync', d: 'Finance and Admin can sync live official daily exchange rates directly from the European Central Bank feed with zero proprietary API keys required. Syncing updates active currency pairs against INR and computes exact rates for pegged GCC currencies.' },
      { t: 'Central bank currency pegs', d: 'Currencies officially pegged to the US Dollar (UAE Dirham AED at 3.6725, Saudi Riyal SAR at 3.7500, Qatari Riyal QAR at 3.6400, Omani Rial OMR at 0.2723, Bahraini Dinar BHD at 0.3845, Kuwaiti Dinar KWD at 0.3080, Jordanian Dinar JOD at 0.7090) are derived with exact BigInt minor-unit precision from the ECB USD/INR cross rate.' },
      { t: 'Currencies without an automated feed', d: 'Five registry currencies (ARS, CLP, COP, TZS, UGX) are neither covered in the European Central Bank reference feed nor officially pegged to the US Dollar. For these currencies, Finance or Admin can record an agreed exchange rate manually in the Exchange Rates drawer. Until a rate is entered, dashboard conversions will display figures in the company base currency (INR) and state that no rate is remembered.' },
      { t: 'Rates are recorded per pair, per day', d: 'Entering today’s rate does not erase last week’s. A trip booked last month can still show the rate that was true when it was booked.' },
      { t: 'Recording a rate never touches booked money', d: 'A rate is a number the company entered. Changing it tomorrow does not move a rupee already budgeted, spent or issued — every money row keeps the rate it actually used.' },
      { t: 'Only Finance and Admin record rates', d: 'Remembering a rate is a company-wide fact. Anyone can read the rates that are known; only Finance and Admin can add one.' },
      { t: 'Reading a report in another currency', d: 'The dashboard has a “Show in” control. Pick a currency and the figures are shown in it, with the rate and its effective date underneath. If no rate is known for that currency, the figures stay in the base currency and the app says why.' },
    ],
    rows: [
      { role: 'Where the rate is shown', can: 'In the currency plan drawer, under the rate box: “Rate remembered for AED, effective 12 Nov 2026. Change it if today’s rate differs.”' },
      { role: 'Where the rate is recorded', can: 'The exchange-rates endpoint of the API — POST /api/v1/exchange-rates with a from-code, a to-code, a rate and the day it takes effect.' },
      { role: 'Where the rate is read back', can: 'GET /api/v1/exchange-rates/USD gives both directions: what a trip stores, and what a reader converting base to USD needs.' },
      { role: 'How to sync live ECB rates', can: 'Open the Exchange Rates drawer from the dashboard or currency plan and click “🔄 Sync live rates” to execute POST /api/v1/exchange-rates/sync.' },
    ],
    notes: [
      'A rate row says how many units of the second currency one unit of the first buys. Trek reads it either way round, so it does not matter which direction your company records it in.',
      'A currency cannot have a rate against itself, and a rate must be a positive number with at most eight decimal places.',
      'If you are on the road and require real-time market verification, click the “Compare on Google Finance ↗” deep-link in the currency drawer.',
    ],
  },

  /* ------------------------------------------------------------------ task
   * recipes — the shortest path to each thing people come here to do. */
  recipes: {
    title: 'How do I…',
    intro: 'Step-by-step operational recipes covering every user task in Trek, from pre-trip planning to post-trip financial settlement.',
    items: [
      { q: 'raise a new trip?', steps: ['My trips → New trip.', 'Fill in the departure city, the destination, the business purpose, the dates and the currency you will spend in. The departure city is never assumed, so check it.', 'Add an itinerary leg for each city hop, including the return leg, and enter any own funds you already have for the trip in company base currency.', 'Save the draft. Open the trip and add the budget lines.', 'Set the currency plan for each currency you will use.', 'Submit it for approval.'] },
      { q: 'plan a multi-city trip?', steps: ['On the trip form, enter your departure city first — Trek never assumes it.', 'Add each itinerary leg in order: from city, to city and departure date. A trip that flies A→B→C→D→B→A has five legs: A→B, B→C, C→D, D→B and B→A.', 'Include the return leg to your departure city so the itinerary ends where the traveller comes home.', 'Save the trip, then add the budget and currency plan as usual.'] },
      { q: 'plan flights and find automotive workshops?', steps: ['Open your trip and find the “Travel & Automotive Field Assistant” card.', 'Check the departure city first — Trek never assumes it, and the flight links use it.', 'Click “Google Flights” to open pre-filled flights from your departure city for your exact travel dates.', 'Click “Skyscanner” to compare flight fares across all airlines.', 'Click the automotive hub link (e.g. “Dubai Auto Hubs: Al Quoz & Ras Al Khor” or “Riyadh Industrial Auto Hubs”) to inspect client service centers and dealerships on Google Maps.'] },
      { q: 'sync live exchange rates with the European Central Bank?', steps: ['Ensure you are signed in as Finance or Admin.', 'Click “Manage exchange rates” on the dashboard or open the currency drawer.', 'Click “🔄 Sync live rates”.', 'Trek calls the ECB live feed, computes exact 8-decimal rates for 30+ currencies and pegged GCC currencies against INR, and saves them with today’s date.'] },
      { q: 'add an estimated expense to the budget?', steps: ['Open the trip → Budget → Add line.', 'Pick a category, describe the expense, give the amount and the currency.', 'Save. You need at least one line before the trip can be submitted.'] },
      { q: 'set the exchange rate for a currency?', steps: ['Open the trip → Currency & forex plan → Add currency.', 'Pick the currency. Trek fills in the rate it remembers and the day it took effect.', 'Change the rate if today’s rate differs, then enter the cash and the forex card amount.', 'Save currency.'] },
      { q: 'record an expense I have already paid for?', steps: ['Open an active trip (funds must be issued first) → Expenses → Add expense.', 'Enter the date, description, category, amount, the currency you actually paid in, and how you paid.', 'If you spent your own money before funds were issued, record it the same way — it is reimbursed at reconciliation.', 'Attach the receipt if you have one.', 'Submit the expense for approval.'] },
      { q: 'record funds I am carrying myself?', steps: ['On the trip form (New trip or Edit trip), find the “Own funds” field.', 'Enter the amount you already hold in company base currency (e.g. \xe2\x82\xb910,000).', 'Trek deducts this from the total budget to compute the amount requested from the company (Requested funds = Budget − Own funds, minimum zero).', 'Own funds are recorded as a snapshot when the trip is submitted and are reimbursed at reconciliation if spent on company business.'] },
      { q: 'issue funds to a traveller?', steps: ['Sign in as Finance or Admin.', 'Open the trip from My trips (or Approvals for company-wide view) → it must be Approved or Active.', 'Find the “Funds issued” section and click “+ Issue funds”.', 'Select the payment type (Cash / Forex card / Other), enter the amount and currency, and add a reference if available.', 'Save. The first issuance moves the trip to Active and unlocks expense logging. Additional top-up tranches can be issued the same way at any time while the trip is Active.'] },
      { q: 'upload a receipt?', steps: ['Open the trip → Bills → Add receipt.', 'Choose one of two: Scan receipt uses the camera on a laptop or phone that has one, and falls back to the device camera if it does not; Choose file / PDF picks a photo or a PDF already on the device.', 'A photo is shrunk to fit 1600 pixels and turned into a JPEG in the browser, so a 10 MB phone photo becomes a few hundred kilobytes before it is sent.', 'The receipt is attached to that expense and is visible to the approver. Only the person who owns the expense can add or delete one.'] },
      { q: 'approve a trip or an expense?', steps: ['Approvals, at the top of the sidebar.', 'Choose Submitted Trips or Submitted Expenses.', 'Approve, request changes with a reason, or reject with a reason.'] },
      { q: 'see how much a trip has left?', steps: ['Open the trip. The Budget vs actual panel shows the budget, the spend, what is pending and the funds issued — all in the base currency.', 'On your dashboard, check the Active Trip Command Center fuel gauge to see % spent and live cash in hand.'] },
      { q: 'read the numbers in dollars?', steps: ['On the dashboard, use the “Show in” control and pick USD.', 'Every figure is shown in USD with the rate that produced it and the day that rate was effective.', 'The stored amounts do not change — this is how it is shown, not a second set of books.'] },
      { q: 'close a trip?', steps: ['The trip must be over and reconciled.', 'Submit it for reconciliation from the trip.', 'Finance approves the reconciliation, then records the settlement and closes the trip.'] },
      { q: 'export the numbers for Excel?', steps: ['On the dashboard, Export employees (CSV) or Export trips (CSV).', 'The file carries the base-currency columns always, and the display-currency columns as well when you have chosen a different currency.'] },
      { q: 'record an exchange rate for the company?', steps: ['You need the rate.manage permission — Finance or Admin.', 'POST /api/v1/exchange-rates with fromCode, toCode, rate and effectiveOn.', 'The rate is then offered as the default in every trip’s currency plan.'] },
      { q: 'find out who can see a trip?', steps: ['Audit log, if you can read it.', 'Every action records who did it and when, including who approved a budget and who issued the funds.'] },
      { q: 'handle lost receipts on the road?', steps: ['When an original paper receipt is unavailable, add the expense claim with category and description noting “Lost receipt / Merchant invoice unavailable”.', 'Add details in the notes field explaining merchant name, location, and reason.', 'The manager can review and decide whether to approve or query.'] },
      { q: 'return unspent advance surplus?', steps: ['After completing your trip and logging all expenses, submit reconciliation.', 'If the balance is positive (e.g. +₹12,450.00), you owe this surplus back to company treasury.', 'Transfer the funds to the company bank account or deposit cash with Finance.', 'Finance approves the reconciliation, enters the settlement confirmation, and closes the trip.'] },
    ],
  },

  /* ------------------------------------------------------------------ the
   * things that go wrong, and what to do about them. */
  troubleshooting: {
    title: 'When something goes wrong',
    intro: 'Almost every message in Trek says what to do next. These are the ones worth reading twice. The messages are quoted exactly as the app shows them, so you can match one against the screen in front of you.',
    items: [
      { q: '“No exchange rate is set for AED on this trip. Add it to the currency plan first.”', a: 'Every currency you spend in needs a rate on the trip’s currency plan. The base currency does not — converting it to itself is the identity.' },
      { q: '“Expenses can only be recorded once the trip is approved and funded; this trip is draft.”', a: 'The trip must be Active before any expense can be recorded. “Approved and funded” means the manager has approved the budget and Finance has issued at least one fund allocation. If you need to record spend before funds arrive, ask Finance to issue the funds first.' },
      { q: '“You do not have an active reporting manager assigned.”', a: 'Your account has no manager, so nothing you submit can be approved. An Admin sets your reporting line under Employees.' },
      { q: '“1 expense on this trip is still awaiting approval. Approve or reject them before reconciling.”', a: 'The reconciliation needs every expense decided — approved or rejected. Money still in flight makes the balance wrong.' },
      { q: '“Add at least one budget line before submitting this trip for approval.”', a: 'A budget is what gets approved. Add at least one estimated-expense line to the trip first.' },
      { q: '“Only a draft trip can be edited; this trip is submitted.”', a: 'The stage does not allow that action. You cannot submit a closed trip or edit one under review.' },
      { q: '“Only draft expenses can be deleted; this expense is approved.”', a: 'An expense that has been submitted cannot be deleted. The decision is recorded; raise a correcting expense instead.' },
      { q: '“Only submitted expenses can be decided; this expense is approved.”', a: 'An expense can only be decided once, while it is with your manager.' },
      { q: '“Only a pending reconciliation can be decided; this trip is active.”', a: 'A reconciliation that Finance sent back has to be resubmitted by the traveller first.' },
      { q: '“Funds are issued only after the budget is approved; this trip is draft.”', a: 'Approval and funding are separate steps. The budget is approved first; then Finance issues the cash or the card.' },
      { q: '“A reconciliation can only be submitted while the trip is active; this trip is draft.”', a: 'Reconciliation happens after the trip is over and its spend is recorded, not while it is being planned.' },
      { q: '“A trip can only be settled after its reconciliation is approved; this trip is active.”', a: 'Finance approves the reconciliation first; the settlement and the closure follow it.' },
      { q: '“A currency cannot have a rate against itself.”', a: 'You tried to record a rate for a currency against itself. Pick two different currencies.' },
      { q: '“The rate must be a positive number with at most 8 decimal places.”', a: 'A rate is a number, not a note. Use digits, optionally with up eight decimal places — for example 83.25.' },
      { q: '“You do not have access to this.”', a: 'Either it is outside your reporting tree, or you do not hold that permission. An Admin can widen it.' },
      { q: '“Not found.”', a: 'Deliberately identical to a record that does not exist, so ids cannot be guessed to find out who has what.' },
      { q: 'Too many failed attempts.', a: 'Five failures for one email in fifteen minutes locks that email. Wait it out, or have an Admin issue a reset link.' },
      { q: 'A reset link never arrived.', a: 'Email may not be switched on yet. An Admin can issue a link from the command line instead.' },
      { q: 'The dashboard shows no money in the currency you picked.', a: 'No rate is remembered for that currency against the base, so there is nothing to convert with. Ask Finance to record the rate; the figures stay in the base currency until then.' },
    ],
  },

  /* ------------------------------------------------------------------ the
   * screens, so the interface is itself documented. */
  screens: {
    title: 'The screens',
    intro: 'Comprehensive guide to every screen and overlay in Trek.',
    items: [
      { t: 'Dashboard', d: 'Where you land after signing in, for everybody. The headline numbers, what is waiting on you right now, and the trips that have moved most recently. A “Show in” control reads the money in another currency, and Finance and Admin can export the figures to CSV for Excel.' },
      { t: 'Settings', d: 'Unified hub for personal profile details, password security, table density, display currency preferences, and (for Admin) audit log and currency rates.' },
      { t: 'My profile', d: 'Your record, your roles, your contact number. You can change your contact number and your password. Your department, grade, manager and roles are set by an Admin.' },
      { t: 'My trips', d: 'Every trip you have raised, with its stage and its budget against actual spend. Open one to prepare it, submit it, record expenses and reconcile it.' },
      { t: 'My expenses', d: 'Every expense you have claimed across all trips, filterable by trip and stage.' },
      { t: 'Receipts', d: 'Inside a trip, the receipts attached to its expenses. You can scan one with the camera, pick a file, view it full size, or delete it — if the expense is yours.' },
      { t: 'Approvals', d: 'For managers, Finance and Admin: the trips and expenses waiting on your decision, from the people who report to you.' },
      { t: 'Employees', d: 'For Admin: add people, set their reporting line, department, grade and roles, and deactivate an account.' },
      { t: 'Departments', d: 'For Admin: departments, their cost centres, their head, and how many active people each has.' },
      { t: 'Audit log', d: 'For Admin: every action, with who did it, when, and what changed before and after. It cannot be edited or deleted — by anyone, including the database owner.' },
      { t: 'Exchange rates drawer', d: 'Accessible from Dashboard or Currency plan: lists all remembered company rates, provides live European Central Bank synchronization, and allows Finance/Admin to record new daily rates.' },
      { t: 'Trip progress stepper', d: 'Inside any trip: a 5-stage Carbon progress indicator tracking 1. Draft Plan → 2. Approval → 3. Funds → 4. On Trip → 5. Settlement. If changes are requested or declined, the approval stage shows the rejection reason and declines forward transitions.' },
      { t: 'Receipt viewer modal', d: 'Click any attached receipt thumbnail to open the high-resolution lightbox modal with instant preview, zoom, pan, and file download.' },
    ],
    notes: [
      'A screen you cannot see is a permission you do not hold, not a broken app. The sidebar only offers what your role allows.',
      'The manual opens from the “?” at the foot of the sidebar and is searchable — try “reconciliation”, “rate” or “403”.',
    ],
  },

  /* ------------------------------------------------------------------ the
   * vocabulary. */
  glossary: {
    title: 'Words',
    intro: 'The financial and travel terminology used across Trek, and what each term specifically means.',
    items: [
      { t: 'Base currency', d: 'INR. The currency every stored amount is in, and the one everything is converted into for comparison.' },
      { t: 'Budget line', d: 'One estimated expense on a trip: category, description, amount, currency.' },
      { t: 'Currency plan', d: 'Per currency on a trip: cash to carry, forex card to load, exchange rate to base, and the charges (GST, top-up, service fees).' },
      { t: 'Exchange rate', d: 'How many units of one currency one unit of another buys. Trek remembers the ones the company records, one per pair per day, and offers them as a default.' },
      { t: 'Funds issued', d: 'What the company actually handed over: cash, a forex card, or an additional tranche.' },
      { t: 'Bill', d: 'The receipt behind an expense — a photo or a PDF.' },
      { t: 'Receipt scanner', d: 'The in-app camera that photographs a receipt and attaches it. It downsizes the picture in the browser before sending it, and falls back to the device camera where there is no webcam.' },
      { t: 'Reconciliation', d: 'The end-of-trip arithmetic: funds received against approved spend, and the balance.' },
      { t: 'Settlement', d: 'How the balance was settled, after which the trip closes.' },
      { t: 'Reporting tree', d: 'Who reports to you, directly or through someone else. It is never a department or an office location.' },
      { t: 'Opaque denial', d: 'Out-of-scope reads answer the same way as records that do not exist, so ids cannot be enumerated.' },
      { t: 'Audit event', d: 'An immutable record of one action: who, when, what changed before and after.' },
      { t: 'Display currency', d: 'The currency a report is shown in. It changes how the numbers read, never what is stored.' },
      { t: 'ECB Sync', d: 'Automated retrieval of official daily reference exchange rates from the European Central Bank via Frankfurter API.' },
      { t: 'Currency Peg', d: 'Fixed central bank exchange rate relationship, such as UAE Dirham pegged at 3.6725 to 1 USD.' },
      { t: 'Snapshot Immutability', d: 'The non-negotiable principle that historical transactions preserve the exact exchange rate and base amount locked at creation time.' },
    ],
  },

  /* ------------------------------------------------------------------ the
   * technical reference, for whoever inherits this. */
  reference: {
    title: 'Reference',
    intro: 'Architecture, APIs, operational invariants, and troubleshooting references.',
    items: [
      { t: 'Health', d: 'GET /healthz is liveness. GET /readyz is readiness: it also checks that every shipped migration is applied with an unchanged checksum.' },
      { t: 'Migrations', d: 'Forward-only and checksummed. A changed file that has already been applied stops the runner. Fix a mistake with a new migration, never by editing an old one.' },
      { t: 'The database role', d: 'The app connects as trek_app, which cannot update the audit log and cannot rewrite the schema. The owner credentials are for migrations only.' },
      { t: 'Errors', d: 'Errors carry a stable code — validation_failed, no_approval_route, invalid_transition, forbidden, not_found, mail_disabled — so the same problem always reads the same way.' },
      { t: 'Passwords', d: 'At least 6 characters, not the email or the person’s name, not the company name, not a dictionary word. Failed attempts are counted in the database, so the lockout survives a restart.' },
      { t: 'Sessions', d: 'An opaque token in an HttpOnly cookie; only its SHA-256 is stored. Sessions are revoked the moment an account is deactivated.' },
      { t: 'The API', d: 'Everything the interface does is a documented endpoint under /api/v1. See docs/API_REFERENCE.md.' },
      { t: 'Currencies and rates', d: 'GET /api/v1/currencies is the registry. GET /api/v1/exchange-rates lists the remembered rates, GET /api/v1/exchange-rates/USD gives one pair in both directions, and POST /api/v1/exchange-rates records a new rate.' },
      { t: 'Live Forex Sync API', d: 'POST /api/v1/exchange-rates/sync contacts the European Central Bank live data feed, updates market rates against base currency, and writes an atomic audit event.' },
      { t: 'Reading a report in another currency', d: 'GET /api/v1/dashboard?display=USD returns the figures in USD alongside the stored ones, plus the rate and the day it took effect.' },
      { t: 'Permission Matrix Endpoint', d: 'GET /api/v1/permissions/matrix delivers the exact authorization matrix that powers both server guards and the manual’s capability table.' },
    ],
  },
};

/* ------------------------------------------------------------------ the
 * help button and the panel. */

function manualIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9"></circle>
    <path d="M9.6 9.2a2.4 2.4 0 1 1 3.3 2.2c-.6.3-.9.8-.9 1.4v.3"></path>
    <path d="M12 16.4h.01"></path>
  </svg>`;
}

/* Every section, flattened into searchable entries. */
function manualIndex() {
  const out = [];
  for (const [key, section] of Object.entries(MANUAL)) {
    const title = section.title;
    const parts = [];

    if (section.stages) {
      for (const s of section.stages) parts.push({ h: `${s.n}. ${s.name}`, b: `${s.who} — ${s.what} ${s.note}`, t: title });
    }
    if (section.steps) {
      for (const s of section.steps) parts.push({ h: s.t, b: s.d, t: title });
    }
    if (section.rows) {
      for (const r of section.rows) parts.push({ h: r.role, b: r.can, t: title });
    }
    if (section.capabilities) {
      for (const c of section.capabilities) parts.push({ h: c.label, b: c.perms.join(', '), t: title });
    }
    if (section.areas) {
      for (const area of section.areas) {
        for (const i of area.items) parts.push({ h: i.t, b: `${i.where}${i.perms.length ? ' — ' + i.perms.join(', ') : ''}`, t: title });
      }
    }
    if (section.reserved) {
      for (const i of section.reserved.items) parts.push({ h: i.t, b: 'Declared in the matrix; not yet reachable in the app.', t: title });
    }
    if (section.trip) {
      for (const s of section.trip) parts.push({ h: s.s, b: s.d, t: title });
    }
    if (section.expense) {
      for (const s of section.expense) parts.push({ h: s.s, b: s.d, t: title });
    }
    if (section.rules) {
      for (const r of section.rules) parts.push({ h: r.t, b: r.d, t: title });
    }
    if (section.items) {
      /* A troubleshooting item is a question and an answer. */
      if (section.items[0]?.q !== undefined) {
        for (const i of section.items) parts.push({ h: i.q, b: i.a, t: title });
      } else if (section.items[0]?.steps !== undefined) {
        for (const i of section.items) parts.push({ h: i.q, b: i.steps.join(' '), t: title });
      } else {
        for (const i of section.items) parts.push({ h: i.t, b: i.d, t: title });
      }
    }
    if (section.notes) {
      for (const n of section.notes) parts.push({ h: 'Note', b: n, t: title });
    }
    out.push({ key, title, intro: section.intro, parts });
  }
  return out;
}

/* The roles table, drawn from the real permission matrix.
 *
 * The mark against a role is not written by hand — it is what the server's
 * matrix says. `permissionMatrix` is filled in by app.js from
 * GET /api/v1/permissions/matrix, which reads the same file the guard reads.
 * A capability is marked for a role when that role holds at least one of the
 * permissions behind it — because most capabilities can be reached by more
 * than one route (a manager approves within their tree, Finance approves
 * anywhere), and any route that works is a capability the role has. */
function heldPermissions(code) {
  const found = (permissionMatrix?.roles ?? []).find((x) => x.code === code);
  return new Set(found ? found.permissions : []);
}

function roleMarks(section) {
  return (section.matrix ?? []).map((r) => ({ role: r.role, held: heldPermissions(r.code) }));
}

function markCell(yes) {
  return `<td class="${yes ? 'yes' : 'no'}">${yes ? '✓' : '–'}</td>`;
}

function manualMatrix(section) {
  if (!section.matrix || !section.capabilities) return '';
  const roles = roleMarks(section);

  const html = ['<table class="man-table"><thead><tr><th>Capability</th>'];
  for (const r of roles) html.push(`<th>${esc(r.role)}</th>`);
  html.push('</tr></thead><tbody>');
  for (const c of section.capabilities) {
    html.push(`<tr><th>${esc(c.label)}</th>`);
    for (const r of roles) {
      const yes = c.perms.length === 0 || c.perms.some((p) => r.held.has(p));
      html.push(markCell(yes));
    }
    html.push('</tr>');
  }
  html.push('</tbody></table>');
  return html.join('');
}

/* The complete capability catalogue: every area, every capability, and who
 * has it. */
function manualCatalogue(section) {
  if (!section.areas) return '';
  const roles = roleMarks(section);

  const html = [];
  for (const area of section.areas) {
    html.push(`<div class="man-sub">${esc(area.area)}</div>`);
    html.push('<table class="man-table"><thead><tr><th>Capability</th><th>Where</th>');
    for (const r of roles) html.push(`<th>${esc(r.role)}</th>`);
    html.push('</tr></thead><tbody>');
    for (const item of area.items) {
      html.push(`<tr><th>${esc(item.t)}</th><td>${esc(item.where)}</td>`);
      for (const r of roles) {
        const yes = item.perms.length === 0 || item.perms.some((p) => r.held.has(p));
        html.push(markCell(yes));
      }
      html.push('</tr>');
    }
    html.push('</tbody></table>');
  }
  return html.join('');
}

function manualBody(section) {
  const s = MANUAL[section];
  if (!s) return '';

  let html = `<div class="man-intro">${esc(s.intro)}</div>`;

  if (s.stages) {
    html += '<ol class="man-stages">';
    for (const st of s.stages) {
      html += `
        <li class="man-stage">
          <div class="man-stage-head">
            <span class="man-num">${st.n}</span>
            <div>
              <div class="man-stage-name">${esc(st.name)}</div>
              <div class="man-who">${esc(st.who)}</div>
            </div>
          </div>
          <p class="man-p">${esc(st.what)}</p>
          <p class="man-note">${esc(st.note)}</p>
        </li>`;
    }
    html += '</ol>';
  }

  if (s.steps) {
    html += '<div class="man-rows">';
    for (const st of s.steps) {
      html += `
        <div class="man-row">
          <div class="man-row-role">${esc(st.t)}</div>
          <div class="man-row-can">${esc(st.d)}</div>
        </div>`;
    }
    html += '</div>';
  }

  if (s.matrix) html += manualMatrix(s);

  if (s.areas) html += manualCatalogue(s);

  if (s.reserved) {
    html += `<div class="man-sub">${esc(s.reserved.title)}</div>`;
    html += `<p class="man-intro">${esc(s.reserved.intro)}</p>`;
    html += '<div class="man-rows">';
    for (const i of s.reserved.items) {
      html += `
        <div class="man-row">
          <div class="man-row-role">${esc(i.t)}</div>
        </div>`;
    }
    html += '</div>';
  }

  if (s.rows) {
    html += '<div class="man-rows">';
    for (const r of s.rows) {
      html += `
        <div class="man-row">
          <div class="man-row-role">${esc(r.role)}</div>
          <div class="man-row-can">${esc(r.can)}</div>
        </div>`;
    }
    html += '</div>';
  }

  if (s.trip || s.expense) {
    for (const [label, list] of [['Trip', s.trip], ['Expense', s.expense]]) {
      if (!list) continue;
      html += `<div class="man-sub">${esc(label)}</div><div class="man-rows">`;
      for (const row of list) {
        html += `
          <div class="man-row">
            <div class="man-row-role">${esc(row.s)}</div>
            <div class="man-row-can">${esc(row.d)}</div>
          </div>`;
      }
      html += '</div>';
    }
  }

  if (s.rules) {
    html += '<div class="man-rows">';
    for (const r of s.rules) {
      html += `
        <div class="man-row">
          <div class="man-row-role">${esc(r.t)}</div>
          <div class="man-row-can">${esc(r.d)}</div>
        </div>`;
    }
    html += '</div>';
  }

  if (s.items) {
    /* A troubleshooting item is a question and an answer, not a title and a
     * definition — it reads differently and is searched differently. */
    if (s.items[0]?.q !== undefined && s.items[0]?.a !== undefined) {
      html += '<div class="man-qa">';
      for (const i of s.items) {
        html += `
          <div class="man-qa-item">
            <div class="man-q">${esc(i.q)}</div>
            <div class="man-a">${esc(i.a)}</div>
          </div>`;
      }
      html += '</div>';
    } else if (s.items[0]?.steps !== undefined) {
      html += '<div class="man-rows">';
      for (const i of s.items) {
        html += `
          <div class="man-row">
            <div class="man-row-role">${esc(i.q)}</div>
            <div class="man-row-can"><ol class="man-steps">${i.steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol></div>
          </div>`;
      }
      html += '</div>';
    } else {
      html += '<div class="man-rows">';
      for (const i of s.items) {
        html += `
          <div class="man-row">
            <div class="man-row-role">${esc(i.t)}</div>
            <div class="man-row-can">${esc(i.d)}</div>
          </div>`;
      }
      html += '</div>';
    }
  }

  if (s.notes) {
    html += '<ul class="man-notes">';
    for (const n of s.notes) html += `<li>${esc(n)}</li>`;
    html += '</ul>';
  }

  return html;
}

/** Open the manual. `section` may name a section to start on. */
function openManual(section = 'gettingStarted') {
  const index = manualIndex();

  const scrim = el(`
    <div class="man-scrim">
      <div class="man-panel" role="dialog" aria-modal="true" aria-label="Trek manual">
        <div class="man-head">
          <div>
            <h2 class="man-title">Trek manual</h2>
            <p class="man-sub">How the workflow runs, what each screen does, and what the money rules are.</p>
          </div>
          <button class="man-close" data-close aria-label="Close the manual">✕</button>
        </div>
        <div class="man-search">
          <input type="search" data-man-search placeholder="Search the manual — try &quot;reconciliation&quot;, &quot;rate&quot; or &quot;403&quot;" aria-label="Search the manual">
        </div>
        <div class="man-body">
          <nav class="man-nav" data-man-nav></nav>
          <div class="man-content" data-man-content></div>
        </div>
      </div>
    </div>`);

  document.body.appendChild(scrim);
  /* Carbon's modal pattern: the focus moves in, is trapped while the manual
   * is open, and returns to the button that opened it. */
  const releaseFocus = trapFocus(scrim.querySelector('[role="dialog"]'));
  const contentEl = scrim.querySelector('[data-man-content]');
  const navEl = scrim.querySelector('[data-man-nav]');
  const searchEl = scrim.querySelector('[data-man-search]');

  const close = () => {
    document.removeEventListener('keydown', onEsc);
    releaseFocus?.();
    scrim.remove();
  };
  /* The app's global Escape handler closes whatever is on top, and it must
   * go through THIS close — not remove the node — or the keydown listener and
   * the focus are never released. */
  scrim.closeOverlay = close;
  function onEsc(e) {
    if (e.key !== 'Escape') return;
    /* The app's global Escape handler closes whatever is on top. This one has
     * already closed the manual, so the event must not travel any further —
     * otherwise the handler behind it closes a second overlay with the same
     * keypress. */
    e.stopPropagation();
    close();
  }
  scrim.querySelector('[data-close]').addEventListener('click', close);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });
  document.addEventListener('keydown', onEsc);

  /* ---- navigation ---- */
  function renderNav(activeKey) {
    /* el() returns the FIRST element of the fragment, so the buttons are
     * wrapped in a single container. */
    navEl.replaceChildren(el(`
      <div>
        ${index.map((s) => `
          <button class="man-nav-item${s.key === activeKey ? ' active' : ''}" data-man-go="${esc(s.key)}">
            ${esc(s.title)}
          </button>`).join('')}
      </div>
    `));
    for (const b of navEl.querySelectorAll('[data-man-go]')) {
      b.addEventListener('click', () => show(b.dataset.manGo));
    }
  }

  /* ---- a section ---- */
  function show(key) {
    renderNav(key);
    contentEl.innerHTML = manualBody(key);
    contentEl.scrollTop = 0;
  }

  /* ---- search across every section ---- */
  function search(term) {
    const q = term.trim().toLowerCase();
    if (!q) { show(section); return; }

    const hits = [];
    for (const s of index) {
      for (const p of s.parts) {
        if (`${p.h} ${p.b} ${p.t}`.toLowerCase().includes(q)) hits.push({ section: s.key, ...p });
      }
    }

    renderNav(section);
    if (!hits.length) {
      contentEl.innerHTML = `
        <div class="man-empty">
          <h3>Nothing found for “${esc(term)}”</h3>
          <p>Try a shorter word, or browse the sections on the left.</p>
        </div>`;
      return;
    }

    contentEl.innerHTML = `
      <div class="man-intro">${hits.length} result${hits.length === 1 ? '' : 's'} for “${esc(term)}”</div>
      <div class="man-rows">
        ${hits.map((h) => `
          <div class="man-row">
            <div class="man-row-role">${esc(h.h)}</div>
            <div class="man-row-can">${esc(h.b)}<div class="man-hit-from">${esc(h.t)}</div></div>
          </div>`).join('')}
      </div>`;
  }

  searchEl.addEventListener('input', () => search(searchEl.value));

  show(section);
  searchEl.focus();
  return scrim;
}
