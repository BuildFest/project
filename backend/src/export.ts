// Usage: npm run export -- <projectId> <file.ndjson[.gz]>
// Needs DATABASE_URL (for Railway, the Postgres service's DATABASE_PUBLIC_URL).
// Writes the file itself: PowerShell's `>` would re-encode stdout as UTF-16.
import { createWriteStream, rmSync } from "node:fs";
import { once } from "node:events";
import { createGzip } from "node:zlib";
import { exportProject } from "./backup.js";
import { createPool } from "./db.js";

const [projectId, file] = process.argv.slice(2);
if (!projectId || !file) {
  console.error("usage: npm run export -- <projectId> <file.ndjson | file.ndjson.gz>");
  process.exit(2);
}

const out = createWriteStream(file);
const sink = file.endsWith(".gz") ? createGzip() : null;
sink?.pipe(out);
const target = sink ?? out;

const pool = createPool();
try {
  const rows = await exportProject(pool, projectId, async (line) => {
    if (!target.write(`${line}\n`)) await once(target, "drain");
  });
  target.end();
  await once(out, "finish");
  console.error(`exported ${rows} rows of ${projectId} to ${file}`);
} catch (err) {
  // Never leave a partial file that could be mistaken for a backup.
  target.destroy();
  rmSync(file, { force: true });
  throw err;
} finally {
  await pool.end();
}
