/* Vercel serverless entry point. Every /api/* request lands here.
 *
 * Only this directory becomes public functions. scripts/ (migrate, reset:staging,
 * seed:staging, issue-password-link) is never deployed as an endpoint, so none of it can
 * be triggered from the web.
 */

import { handle } from '../src/http/app.js';

export default function handler(req, res) {
  return handle(req, res);
}
