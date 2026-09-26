import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";

export async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "request body must be JSON" });
  }
  return schema.parse(json);
}

export function notFound(what: string): never {
  throw new HTTPException(404, { message: `${what} not found` });
}
