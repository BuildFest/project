// `npm run migrate` (built) or `npm run migrate:dev` (tsx). Needs DATABASE_URL.
// Railway runs this as the pre-deploy step, before new code takes traffic.
import { createPool } from "./db.js";
import { migrate } from "./migrations.js";

const pool = createPool();
try {
  await migrate(pool);
  console.log("migrations up to date");
} finally {
  await pool.end();
}
