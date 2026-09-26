// Server entry point: `npm run dev` locally, `node dist/server.js` on Railway.
import { serve } from "@hono/node-server";
import { createApp } from "./api/app.js";
import { requireEnv } from "./config.js";
import { createPool } from "./db.js";

// Fail at boot, not on the first webhook: a server without the secret would
// reject every delivery. Behind Railway's proxy the request origin is
// http://..., so production must say its public https URL explicitly.
requireEnv("GITHUB_WEBHOOK_SECRET");
if (process.env.NODE_ENV === "production") requireEnv("PUBLIC_BASE_URL");

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: createApp(createPool()).fetch, port }, (info) => {
  console.log(`Pit Crew API listening on port ${info.port}`);
});
