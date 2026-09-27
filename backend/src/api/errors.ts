import pg from "pg";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ModelError } from "../ai/client.js";
import { InvalidModelReplyError } from "../ai/json.js";
import { AiUnavailableError } from "../ai/router.js";

export interface HttpError {
  status: ContentfulStatusCode;
  body: { error: string; code?: string };
}

/** Keep provider details in server logs while giving the UI an actionable error. */
export function aiErrorToHttp(err: unknown): HttpError | null {
  if (err instanceof InvalidModelReplyError) {
    return { status: 502, body: { error: "the planning agent returned an invalid response; try again" } };
  }
  if (err instanceof AiUnavailableError) {
    return { status: 503, body: { error: "the planning agent is not configured or its token budget is unavailable" } };
  }
  if (!(err instanceof ModelError)) return null;
  if (err.status === 401) {
    return { status: 502, body: { error: "Microsoft Foundry authentication failed; verify the Azure credentials" } };
  }
  if (err.status === 403) {
    return { status: 502, body: { error: "Microsoft Foundry denied access; verify the Foundry Agent Consumer role" } };
  }
  if (err.status === 400 || err.status === 404) {
    return { status: 502, body: { error: "Microsoft Foundry rejected the request; verify the agent endpoint and active version" } };
  }
  return { status: 502, body: { error: "Microsoft Foundry could not complete the planning request; try again" } };
}

/**
 * Translates a Postgres error into an HTTP response, or returns null to let it
 * surface as a 500.
 *
 * Most relational validation lives in db/schema.sql (CHECKs, composite FKs,
 * unique indexes, triggers), so this function is what turns those rules into
 * API errors the frontend can show.
 *
 * Useful fields on pg.DatabaseError: code (SQLSTATE), constraint, detail,
 * message. SQLSTATE reference:
 * https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
// Messages are fixed strings: pg's own messages name tables and constraints,
// which the API contract says must never reach the client.
const MAPPINGS: Record<string, { status: ContentfulStatusCode; error: string }> = {
  "23505": { status: 409, error: "conflicts with an existing record" },
  "23503": { status: 400, error: "references something that does not exist in this project" },
  "23514": { status: 400, error: "violates a data rule" },
  "23502": { status: 400, error: "missing a required value" },
  "22007": { status: 400, error: "invalid date or time" },
  "22008": { status: 400, error: "date or time out of range" },
  "22P02": { status: 400, error: "invalid value" },
};

export function pgErrorToHttp(err: unknown): HttpError | null {
  if (!(err instanceof pg.DatabaseError) || !err.code) return null;
  // Raised by the task_dependencies_no_cycle trigger as a check_violation.
  if (err.constraint === "task_dependencies_no_cycle") {
    return { status: 409, body: { error: "dependency would create a cycle", code: "cycle" } };
  }
  const mapped = MAPPINGS[err.code];
  if (!mapped) return null;
  return { status: mapped.status, body: { error: mapped.error, code: err.code } };
}
