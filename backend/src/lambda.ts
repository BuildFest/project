// AWS Lambda entry point (API Gateway -> Lambda), same routes as server.ts.
import { handle } from "hono/aws-lambda";
import { createApp } from "./api/app.js";
import { createPool } from "./db.js";

export const handler = handle(createApp(createPool()));
