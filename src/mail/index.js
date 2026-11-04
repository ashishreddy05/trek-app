/* Email — password links and (later) notifications. OTP delivery has been removed.
 *
 * PROVISIONAL — Slot 5 (email provider) is unsigned. Resend is recommended for Vercel
 * (one API key, one domain verification); Postmark is also supported. Both are plain
 * HTTPS calls with no SDK.
 *
 * MAIL_DRIVER=disabled is allowed: sign-in still works, but "Forgot password" and
 * "Email sign-in link" can't send anything, and links must be issued by an operator
 * (scripts/issue-password-link.js).
 */

import { config } from '../config.js';
import { log } from '../logging.js';

const from = () => `${config.mail.fromName} <${config.mail.fromAddress}>`;

async function post(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Email provider rejected the message (${res.status}): ${detail.slice(0, 200)}`);
  }
}

const drivers = {
  /* Dev only — config.js refuses it elsewhere. Prints to the SERVER terminal, never to a browser. */
  console: {
    async send({ to, subject, text }) {
      process.stdout.write(`\n──── MAIL (dev) ────\nto: ${to}\nsubject: ${subject}\n\n${text}\n────────────────────\n\n`);
    },
  },
  disabled: {
    async send() { throw new Error('Email delivery is disabled (MAIL_DRIVER=disabled).'); },
  },
  resend: {
    send: ({ to, subject, text, html }) =>
      post('https://api.resend.com/emails',
        { Authorization: `Bearer ${config.mail.apiKey}` },
        { from: from(), to: [to], subject, text, html }),
  },
  postmark: {
    send: ({ to, subject, text, html }) =>
      post('https://api.postmarkapp.com/email',
        { 'X-Postmark-Server-Token': config.mail.apiKey },
        { From: from(), To: to, Subject: subject, TextBody: text, HtmlBody: html, MessageStream: config.mail.stream ?? 'outbound' }),
  },
};

export function mailEnabled() {
  return config.mail.driver !== 'disabled';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* The only function that receives a password link. It goes to the employee's own inbox
 * and is not logged. */
export async function sendPasswordLinkEmail({ to, name, url, purpose, expiresText }) {
  const first = name?.split(' ')[0] ?? 'there';
  const invite = purpose === 'invite';
  const subject = invite ? 'Set up your Trek sign-in' : 'Reset your Trek password';
  const lead = invite
    ? 'Your Trek account is ready. Choose a password to finish setting it up.'
    : 'Someone asked to reset the password for your Trek account.';
  const action = invite ? 'Set your password' : 'Choose a new password';

  const text = [
    `Hi ${first},`, '', lead, '', `${action}: ${url}`, '',
    `The link works once and expires in ${expiresText}.`, '',
    invite
      ? "If you weren't expecting this, you can ignore it."
      : "If you didn't ask for this, you can ignore it — your password hasn't changed.",
    '', 'Trek · GaragePlug',
  ].join('\n');

  const html = `<!doctype html><html><body style="margin:0;padding:32px;background:#F6F7F5;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif">
<div style="max-width:440px;margin:0 auto;background:#fff;border-radius:14px;padding:32px;border:1px solid rgba(20,52,42,.08)">
<p style="margin:0 0 16px;font-size:15px;color:rgba(20,52,42,.72)">Hi ${escapeHtml(first)},</p>
<p style="margin:0 0 24px;font-size:15px;color:#14342A;line-height:1.55">${escapeHtml(lead)}</p>
<p style="margin:0 0 24px"><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 20px;background:#0A4636;color:#fff;border-radius:8px;font-size:14px;font-weight:500;text-decoration:none">${escapeHtml(action)}</a></p>
<p style="margin:0 0 16px;font-size:13px;color:rgba(20,52,42,.62);line-height:1.55">The link works once and expires in ${escapeHtml(expiresText)}.</p>
<p style="margin:0;font-size:13px;color:rgba(20,52,42,.5);line-height:1.55">${invite
    ? "If you weren't expecting this, you can ignore it."
    : "If you didn't ask for this, you can ignore it — your password hasn't changed."}</p>
</div>
<p style="max-width:440px;margin:16px auto 0;font-size:12px;color:rgba(20,52,42,.45);text-align:center">Trek · GaragePlug</p>
</body></html>`;

  const started = Date.now();
  try {
    await drivers[config.mail.driver].send({ to, subject, text, html });
    log.info('mail.password_link_sent', { to, purpose, ms: Date.now() - started });
  } catch (err) {
    log.error('mail.password_link_failed', { to, purpose, err, ms: Date.now() - started });
    throw err;
  }
}

/* Notifications are records first; the store and triggers come with the stages that own
 * them. This is only the delivery step. Cadence is D-16 (unsigned). */
export async function sendNotificationEmail({ to, subject, text, html }) {
  if (!mailEnabled()) return;
  await drivers[config.mail.driver].send({ to, subject, text, html });
}
