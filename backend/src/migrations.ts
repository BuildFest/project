import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

// db/ sits next to backend/, and both src/ and dist/ are one level under
// backend/, so the same relative path works under tsx and after a build.
const DB_DIR = fileURLToPath(new URL("../../db/", import.meta.url));

function migrationFiles() {
  const dir = join(DB_DIR, "migrations");
  const names = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".sql")).sort() : [];
  return [
    { version: "0000_schema", path: join(DB_DIR, "schema.sql") },
    ...names.map((f) => ({ version: f.replace(/\.sql$/, ""), path: join(dir, f) })),
  ];
}

/**
 * Applies db/schema.sql (as 0000_schema), then db/migrations/*.sql in filename
 * order. Each file runs once, in its own transaction, so a failed migration
 * leaves nothing half-applied. Files must not contain their own begin/commit.
 */
export async function migrate(pool: pg.Pool, log: (msg: string) => void = console.log): Promise<void> {
  const client = await pool.connect();
  try {
    // Overlapping deploys can start two instances; only one migrates at a time.
    await client.query("select pg_advisory_lock(hashtext('pitcrew:migrate'))");
    await client.query(
      `create table if not exists schema_migrations (
         version    text primary key,
         applied_at timestamptz not null default now()
       )`,
    );
    const { rows } = await client.query<{ version: string }>("select version from schema_migrations");
    const applied = new Set(rows.map((r) => r.version));

    for (const file of migrationFiles()) {
      if (applied.has(file.version)) continue;
      await client.query("begin");
      try {
        await client.query(readFileSync(file.path, "utf8"));
        await client.query("insert into schema_migrations (version) values ($1)", [file.version]);
        await client.query("commit");
        log(`applied ${file.version}`);
      } catch (err) {
        await client.query("rollback");
        throw new Error(`migration ${file.version} failed: ${(err as Error).message}`, { cause: err });
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock(hashtext('pitcrew:migrate'))").catch(() => {});
    client.release();
  }
}
