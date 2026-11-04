/* The expected migration set: filenames + checksums of migrations/*.sql.
 *
 * Shared by scripts/migrate.js (what to apply) and db.migrationsCurrent()
 * (/readyz — what "ready" means). One definition, no drift between the two.
 */

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export function checksum(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) { h = (h * 31 + text.charCodeAt(i)) | 0; }
  return String(h);
}

export async function expectedMigrations() {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  return Promise.all(
    files.map(async (file) => {
      const sql = await readFile(join(dir, file), 'utf8');
      return { file, sql, checksum: checksum(sql) };
    })
  );
}
