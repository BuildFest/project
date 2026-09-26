import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { migrate } from "../src/migrations.js";

/** A port the OS says is free right now (listen on 0, read it, release it). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

function removeDir(dir: string) {
  // Windows can hold the data dir briefly after postgres exits (EBUSY).
  // It's a temp dir, so cleanup is best-effort.
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (err) {
    console.warn(`could not remove ${dir}:`, (err as Error).message);
  }
}

// Every test file starts its own cluster in parallel. A port can still be
// taken between freePort() and postgres binding it (embedded-postgres then
// rejects with `undefined`), so retry on a fresh port and data dir.
async function startCluster(attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    const dataDir = mkdtempSync(join(tmpdir(), "pitcrew-pg-"));
    const port = await freePort();
    const postgres = new EmbeddedPostgres({
      // persistent: true so stop() doesn't delete dataDir itself (that throws
      // EBUSY on Windows); stop() below removes it with retries instead.
      databaseDir: dataDir, port, user: "postgres", password: "test", persistent: true, onLog: () => {},
      // Production (Railway) is UTF-8; on Windows initdb would default to WIN1252,
      // which rejects characters like "✓" that real commit messages contain.
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    try {
      await postgres.initialise();
      await postgres.start();
      return { postgres, dataDir, port };
    } catch (err) {
      await postgres.stop().catch(() => {});
      removeDir(dataDir);
      if (attempt >= attempts) throw err ?? new Error(`embedded postgres failed to start on port ${port}`);
    }
  }
}

/** Starts a throwaway Postgres migrated the same way production is. Call stop() in afterAll. */
export async function startTestDb() {
  const { postgres, dataDir, port } = await startCluster();
  await postgres.createDatabase("pitcrew_test");
  const pool = new pg.Pool({ connectionString: `postgres://postgres:test@localhost:${port}/pitcrew_test` });
  await migrate(pool, () => {});

  return {
    pool,
    async stop() {
      await pool.end();
      await postgres.stop();
      removeDir(dataDir);
    },
  };
}
