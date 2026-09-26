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
export function pgErrorToHttp(err: unknown): HttpError | null {
  if (!(err instanceof pg.DatabaseError)) return null;

  // TODO: map the SQLSTATE codes our schema produces to HTTP statuses.

  return null;
}
