import type { z } from "zod";
import type { CompletionRequest } from "./client.js";
import type { AiJob } from "./config.js";
import type { ModelRouter, RunOptions } from "./router.js";

export class InvalidModelReplyError extends Error {
  constructor(message: string, readonly reply: string) {
    super(message);
    this.name = "InvalidModelReplyError";
  }
}

// Pulls the first JSON object out of a reply. Models sometimes wrap JSON in
// prose or code fences even when told not to.
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end < start) throw new SyntaxError("no JSON object in reply");
  return JSON.parse(text.slice(start, end + 1));
}

// Runs a job that must answer with JSON matching `schema`. An invalid reply is
// retried once with the validation error fed back; after that it throws.
export async function runJson<S extends z.ZodType>(
  router: ModelRouter,
  job: AiJob,
  request: CompletionRequest,
  schema: S,
  options: RunOptions = {},
): Promise<z.output<S>> {
  const jsonRequest = { ...request, json: true };
  const first = await router.run(job, jsonRequest, options);
  const parsed = validate(first.text, schema);
  if (parsed.ok) return parsed.value;

  const retry = await router.run(job, {
    ...jsonRequest,
    messages: [
      ...jsonRequest.messages,
      { role: "assistant", content: first.text },
      {
        role: "user",
        content: `That reply was invalid: ${parsed.error}. Reply again with only a corrected JSON object.`,
      },
    ],
  });
  const second = validate(retry.text, schema);
  if (second.ok) return second.value;
  throw new InvalidModelReplyError(`model reply for ${job} is invalid: ${second.error}`, retry.text);
}

function validate<S extends z.ZodType>(
  text: string,
  schema: S,
): { ok: true; value: z.output<S> } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = extractJsonObject(text);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const result = schema.safeParse(json);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    error: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
  };
}
