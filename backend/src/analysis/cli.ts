import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { loadAiConfig } from "../ai/config.js";
import { createModelRouter } from "../ai/router.js";
import { createPool } from "../db.js";
import { runAnalysis } from "./runner.js";

if (existsSync(".env")) loadEnvFile(".env");
const projectId = process.argv[2];
if (!projectId) throw new Error("usage: npm run analyze -- <projectId>");
const db = createPool();
try { console.log(JSON.stringify(await runAnalysis(db, createModelRouter(loadAiConfig()), projectId), null, 2)); }
finally { await db.end(); }
