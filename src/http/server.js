/* Long-running Node server — local development and Docker.
 * On Vercel, api/[...path].js calls the same handler. */

import http from 'node:http';
import { config } from '../config.js';
import { log, reportError } from '../logging.js';
import * as db from '../db.js';
import { handle } from './app.js';
import { initEnums } from './validation.js';
import { purgeExpired } from '../auth/session.js';

const server = http.createServer(handle);

server.listen(config.port, () => {
  log.info('boot', { port: config.port, env: config.env, mailDriver: config.mail.driver });
  initEnums(db.pool).catch(() => {});

  // Clean expired sessions, login attempts and password reset tokens periodically
  const purge = () => purgeExpired(db).catch((err) => reportError(err, { source: 'purgeExpired' }));
  setTimeout(purge, 60_000).unref();
  const purgeInterval = setInterval(purge, 3600_000);
  purgeInterval.unref();
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log.info('shutdown', { sig });
    server.close(async () => { await db.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}

process.on('unhandledRejection', (err) => reportError(err, { source: 'unhandledRejection' }));
process.on('uncaughtException', (err) => { reportError(err, { source: 'uncaughtException' }); process.exit(1); });
