#!/usr/bin/env node
/* Migration runner.
 *
 * Forward-only. Each file runs once, inside a transaction, recorded in
 * schema_migrations. There is no down-migration: a mistake in production is corrected
 * by a new forward migration — the same rule the settlement spec applies to posted
 * records.
 *
 * Applied by CI. Never by hand against production.
 */

import pg from 'pg';
import { expectedMigrations } from '../src/migrations.js';

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. See .env.example.');
  process.exit(1);
}

const client = new pg.Client({
  connectionString: url,
  ssl: process.env.DATABASE_SSL_MODE === 'disable' ? false : { rejectUnauthorized: false },
});

async function ensureTable() {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      checksum    text NOT NULL
    )`);
}

async function pending() {
  const files = await expectedMigrations();
  const { rows } = await client.query('SELECT filename, checksum FROM schema_migrations');
  const applied = new Map(rows.map((r) => [r.filename, r.checksum]));

  const out = [];
  for (const m of files) {
    if (!applied.has(m.file)) { out.push({ ...m, sum: m.checksum, state: 'pending' }); continue; }
    /* An applied migration whose contents changed is a mistake worth stopping for:
     * the database and the repository no longer agree about history. */
    if (applied.get(m.file) !== m.checksum) out.push({ ...m, sum: m.checksum, state: 'modified' });
  }
  return out;
}

async function up() {
  await ensureTable();
  const list = await pending();

  const modified = list.filter((m) => m.state === 'modified');
  if (modified.length) {
    console.error('\nRefusing to migrate — these already-applied files have changed:');
    for (const m of modified) console.error(`  ${m.file}`);
    console.error('\nMigrations are immutable once applied. Write a new forward migration.\n');
    process.exit(1);
  }

  const todo = list.filter((m) => m.state === 'pending');
  if (!todo.length) { console.log('Nothing to migrate.'); return; }

  for (const m of todo) {
    process.stdout.write(`applying ${m.file} … `);
    try {
      await client.query('BEGIN');
      await client.query(m.sql);
      await client.query(
        'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
        [m.file, m.sum]
      );
      await client.query('COMMIT');
      console.log('ok');
    } catch (err) {
      await client.query('ROLLBACK');
      console.log('FAILED');
      console.error(`\n${err.message}\n`);
      process.exit(1);
    }
  }
  console.log(`\n${todo.length} migration(s) applied.`);
}

async function status() {
  await ensureTable();
  const { rows } = await client.query(
    'SELECT filename, applied_at FROM schema_migrations ORDER BY filename'
  );
  const list = await pending();

  console.log('\nApplied:');
  for (const r of rows) console.log(`  ${r.filename}  ${r.applied_at.toISOString()}`);
  if (!rows.length) console.log('  (none)');

  const p = list.filter((m) => m.state === 'pending');
  console.log('\nPending:');
  for (const m of p) console.log(`  ${m.file}`);
  if (!p.length) console.log('  (none)');

  const mod = list.filter((m) => m.state === 'modified');
  if (mod.length) {
    console.log('\n⚠ Modified after being applied:');
    for (const m of mod) console.log(`  ${m.file}`);
  }
  console.log('');
}

const cmd = process.argv[2] ?? 'up';
await client.connect();
try {
  if (cmd === 'up') await up();
  else if (cmd === 'status') await status();
  else { console.error(`Unknown command: ${cmd}. Use "up" or "status".`); process.exit(1); }
} finally {
  await client.end();
}
