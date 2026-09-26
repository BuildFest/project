import pg from "pg";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export interface HttpError {
  status: ContentfulStatusCode;
  body: { error: string; code?: string };
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
  const mapped = MAPPINGS[err.code];
  if (!mapped) return null;
  return { status: mapped.status, body: { error: mapped.error, code: err.code } };
}
