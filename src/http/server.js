/* Long-running Node server — local development and Docker.
 * On Vercel, api/[...path].js calls the same handler. */

import http from 'node:http';
import { config } from '../config.js';
import { log, reportError } from '../logging.js';
import * as db from '../db.js';
import { handle } from './app.js';

const server = http.createServer(handle);

server.listen(config.port, () => {
  log.info('boot', { port: config.port, env: config.env, mailDriver: config.mail.driver });
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
