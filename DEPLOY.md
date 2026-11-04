# Deploy Trek: fresh Neon project + Vercel

This guide starts with an empty Neon project. No tables need to be created manually.
The temporary admin is ashishreddy@garageplug.com. There is no default password.

## 1. Get the Neon connection strings

Open your new Singapore project in Neon and click **Connect**. Select the
project branch, database (usually neondb), and owner role (usually neondb_owner).
Reveal/reset the role password in Neon if needed.

Copy two PostgreSQL connection strings:
- Connection pooling ON: pooled owner URL (hostname contains -pooler).
- Connection pooling OFF: direct owner URL.

Keep the SSL parameters supplied by Neon. Never commit either URL.

## 2. Configure local credentials and create the schema

Install Node 24 and run npm ci from this repository. Create .env from .env.example
only if .env does not already exist; otherwise edit the existing file. Replace
BOTH old database URLs with the strings from your new project:

```dotenv
APP_ENV=dev
APP_BASE_URL=http://localhost:3000
DATABASE_URL=<new pooled owner URL>
DATABASE_URL_UNPOOLED=<new direct owner URL>
DATABASE_SSL_MODE=require
MAIL_DRIVER=disabled
LOGIN_EMAIL_DOMAINS=garageplug.com
```

Then run:

```bash
npm run migrate
npm run migrate:status
```

All four migrations should be applied, with no pending or modified migrations.
The migration runner creates the schema and seeds your temporary admin account.

**Fresh database only:** migration 003's admin seed was corrected for this setup.
Do not use this edited migration against an older database where 003 was applied:
the checksum guard will refuse it. Do not reset stored checksums to bypass that guard.

The admin's employee code TEST-ADMIN, grade G1, location "Not configured" and
joining date are test placeholders required by the current schema. Correct them
in Employees later. Other legacy pilot identities remain seed/test data; verify
them before issuing anyone access.

## 3. Configure the restricted application role

After migrations, open **Neon → SQL Editor** with the same branch/database and
owner role. Execute scripts/create-app-role.sql, replacing the password placeholder
with a unique strong password in the SQL editor. Do not save the password in Git.

Return to **Connect**, choose role trek_app, and enable connection pooling.
Copy that connection string: this is Vercel's DATABASE_URL. Keep the owner
connection strings on your machine for migrations and operator commands.

## 4. Push the dev branch yourself

The workflow now tests pushes to main and dev. Create/switch to dev, commit the
changes, and push dev. Wait for GitHub Actions to pass.

CI uses its own disposable PostgreSQL database; it does not migrate your Neon project.
Do not run npm test against the team database: the integration tests change passwords
and write audit/login records.

## 5. Import into Vercel

Import the GitHub repository. Use repository root as Root Directory, **Other** as
Framework Preset, no Build Command, and public as Output Directory.

Choose your Vercel project name and note its actual stable production URL.
Under **Settings → Environments → Production → Branch Tracking**, select dev.
All future pushes to dev then update this project's production site. GitHub main
is unaffected.

Configure **Production** environment variables before deploying/redeploying:

```dotenv
APP_ENV=prod
APP_BASE_URL=https://<your actual stable production hostname>
DATABASE_URL=<pooled trek_app URL from step 3>
DATABASE_SSL_MODE=require
MAIL_DRIVER=disabled
LOGIN_EMAIL_DOMAINS=garageplug.com
```

Do not copy the entire local .env to Vercel. Do not add DATABASE_URL_UNPOOLED,
owner credentials, or TREK_ALLOW_STAGING_RESET. Local .env is ignored by Git.
Deploy dev after saving these variables.

MAIL_DRIVER=disabled requires no mail API key or sender address. It supports
password login and operator-issued setup/reset links. To enable email later,
verify a sender/domain with Resend or Postmark and configure MAIL_DRIVER,
MAIL_API_KEY and MAIL_FROM_ADDRESS both in Vercel and in the local environment
used for CLI --send. Redeploy after changing Vercel environment variables.

## 6. Verify and set your password

Open the deployed /healthz and /readyz endpoints. Both should return HTTP 200;
readiness should report db=true and migrations=true.

From your machine, with the local .env pointing to the same Neon project, run
(replace the example hostname with the actual deployed hostname):

```bash
APP_ENV=prod APP_BASE_URL=https://your-project.vercel.app MAIL_DRIVER=disabled \
npm run issue-password-link -- ashishreddy@garageplug.com
```

The terminal prints a one-time setup link. Open it, choose your own password,
then sign in using ashishreddy@garageplug.com. Treat the link as a password;
do not share it or commit it. The invite link expires in three days.

To try locally instead, run npm start in one terminal, then the same
issue-password-link command without the APP_ENV/APP_BASE_URL overrides in another.
That link will use localhost.

## 7. Add Abdul and hand over administration

While signed in as Ashish, create an active employee for abdul@garageplug.com
using his actual employee details. In that employee's role editor, add Admin.
When email delivery is disabled, issue his setup link from your machine with
the same production URL override and his email address.

After Abdul has set his password and successfully logged in, he removes Admin
from your account. An admin cannot edit their own roles, so Abdul must perform
that final step. Keep your Employee role if you still need member access.

This repository currently supports identity, employee/department management and
audit. Trips, expenses and approvals remain gated; deploying it does not enable
those workflows.
