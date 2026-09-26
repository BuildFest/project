import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";

const SCHEMA = readFileSync(new URL("../../db/schema.sql", import.meta.url), "utf8");

/** Starts a throwaway Postgres with db/schema.sql applied. Call stop() in afterAll. */
export async function startTestDb() {
  const dataDir = mkdtempSync(join(tmpdir(), "pitcrew-pg-"));
  const port = 50000 + Math.floor(Math.random() * 10000);
  const postgres = new EmbeddedPostgres({
    // persistent: true so stop() doesn't delete dataDir itself (that throws
    // EBUSY on Windows); stop() below removes it with retries instead.
    databaseDir: dataDir, port, user: "postgres", password: "test", persistent: true, onLog: () => {},
  });
  await postgres.initialise();
  await postgres.start();
  await postgres.createDatabase("pitcrew_test");
  const pool = new pg.Pool({ connectionString: `postgres://postgres:test@localhost:${port}/pitcrew_test` });
  await pool.query(SCHEMA);

  return {
    pool,
    async stop() {
      await pool.end();
      await postgres.stop();
      // Windows can hold the data dir briefly after postgres exits (EBUSY).
      // It's a temp dir, so cleanup is best-effort.
      try {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch (err) {
        console.warn(`could not remove ${dataDir}:`, (err as Error).message);
      }
    },
  };
}
