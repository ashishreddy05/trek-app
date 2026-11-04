#!/usr/bin/env node
/* Issue a single-use set-password link.
 *
 * Use it for:
 *   · the first administrator, who can't sign in yet to send invites
 *   · any employee when email delivery isn't configured (MAIL_DRIVER=disabled)
 *
 * The link prints to THIS terminal only, for whoever holds the database credentials.
 * It never appears in the Trek UI, is never returned by the API, and is never logged.
 * Every issued link is audited.
 *
 *   node --env-file=.env.staging.local scripts/issue-password-link.js ashishreddy@garageplug.com
 *   … --send                      email it instead of printing (needs a mail driver)
 *   … --all-without-password      every active employee who has not set a password yet
 */

import * as db from '../src/db.js';
import { issuePasswordLink } from '../src/auth/password.js';
import { sendPasswordLinkEmail, mailEnabled } from '../src/mail/index.js';
import { config } from '../src/config.js';

const args = process.argv.slice(2);
const send = args.includes('--send');
const all = args.includes('--all-without-password');
const email = args.find((a) => !a.startsWith('--'))?.toLowerCase();

if (!email && !all) {
  console.error('\nUsage: issue-password-link.js <work-email> [--send]\n       issue-password-link.js --all-without-password [--send]\n');
  process.exit(1);
}
if (send && !mailEnabled()) {
  console.error('\n✗ --send needs a mail driver (MAIL_DRIVER=resend or postmark). Leave off --send to print the link.\n');
  process.exit(1);
}

const rows = await db.many(
  `SELECT e.id, e.name, e.work_email, e.status, a.id AS account_id, a.status AS account_status,
          (pc.account_id IS NOT NULL) AS has_password
     FROM employee e
     JOIN account a ON a.employee_id = e.id
     LEFT JOIN password_credential pc ON pc.account_id = a.id
    WHERE ${all ? "e.status = 'active' AND pc.account_id IS NULL" : 'lower(e.work_email) = $1'}
    ORDER BY e.employee_code`,
  all ? [] : [email]
);

if (!rows.length) {
  console.error(all ? '\nEvery active employee already has a password.\n' : `\n✗ No employee with the email ${email}.\n`);
  await db.close();
  process.exit(all ? 0 : 1);
}

console.log(`\nEnvironment: ${config.env} · ${config.baseUrl}\n`);

for (const row of rows) {
  if (row.status !== 'active' || row.account_status !== 'active') {
    console.log(`  ✗ ${row.name} is inactive — reactivate them first.`);
    continue;
  }
  const purpose = row.has_password ? 'reset' : 'invite';
  const link = await db.tx((t) => issuePasswordLink(t, {
    accountId: row.account_id, employee: row, purpose, via: 'cli',
  }));

  if (send) {
    await sendPasswordLinkEmail({ to: row.work_email, name: row.name, url: link.url, purpose, expiresText: link.expiresText });
    console.log(`  ✓ ${row.name} — ${purpose} link emailed to ${row.work_email}`);
  } else {
    console.log(`  ${row.name} <${row.work_email}> — ${purpose}, expires in ${link.expiresText}`);
    console.log(`  ${link.url}\n`);
  }
}

if (!send) {
  console.log('Send each link only to its owner, privately. Anyone holding a link can set that password.\n');
}
await db.close();
