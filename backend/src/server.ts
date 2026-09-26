// Local development entry point: `npm run dev` (needs DATABASE_URL).
import { serve } from "@hono/node-server";
import { createApp } from "./api/app.js";
import { createPool } from "./db.js";

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: createApp(createPool()).fetch, port }, (info) => {
  console.log(`Pit Crew API listening on http://localhost:${info.port}`);
});
