// Usage: npm run import -- <file.ndjson[.gz]>
// Restores an export into DATABASE_URL (e.g. a local Docker Postgres for the
// demo fallback). Migrates the target first; refuses if the project exists.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { importProject } from "./backup.js";
import { createPool } from "./db.js";
import { migrate } from "./migrations.js";

const [file] = process.argv.slice(2);
if (!file) {
  console.error("usage: npm run import -- <file.ndjson | file.ndjson.gz>");
  process.exit(2);
}

const raw = readFileSync(file);
let text: string;
try {
  text = (file.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8");
} catch {
  console.error(`${file} is not a readable gzip file (empty or truncated?)`);
  process.exit(1);
}

const pool = createPool();
try {
  await migrate(pool);
  const result = await importProject(pool, text.split("\n"));
  console.log(`restored ${result.rows} rows of ${result.projectId}`);
  for (const [table, n] of Object.entries(result.tables)) if (n) console.log(`  ${table}: ${n}`);
} finally {
  await pool.end();
}
