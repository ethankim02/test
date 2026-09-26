import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

/**
 * Minimal, transparent migration runner: applies every *.sql file in
 * migrations/ in filename order, exactly once, tracked in `_migrations`.
 * Each file runs inside its own transaction. See docs/DECISIONS.md ADR-002
 * for why this project hand-writes SQL migrations instead of relying on
 * drizzle-kit's generator.
 */
export async function runMigrations(connectionString: string): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      const { rows } = await client.query('SELECT 1 FROM _migrations WHERE name = $1', [file]);
      if (rows.length > 0) {
        continue;
      }
      const sqlText = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sqlText);
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}

// pathToFileURL (not a raw `file://${...}` template) is required for this
// comparison to work on Windows, where argv[1] uses backslashes and a drive
// letter that don't match import.meta.url's URL-encoded forward-slash form.
const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const connectionString = process.env.MIGRATOR_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('MIGRATOR_DATABASE_URL (or DATABASE_URL) is required');
    process.exit(1);
  }
  const applied = await runMigrations(connectionString);
  if (applied.length === 0) {
    console.log('no pending migrations');
  } else {
    console.log(`applied ${applied.length} migration(s): ${applied.join(', ')}`);
  }
}
