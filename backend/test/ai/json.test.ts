import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { CompletionRequest, CompletionResult } from "../../src/ai/client.js";
import { extractJsonObject, InvalidModelReplyError, runJson } from "../../src/ai/json.js";
import type { ModelRouter } from "../../src/ai/router.js";

function scriptedRouter(replies: string[]): ModelRouter & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  return {
    requests,
    available: () => true,
    async run(_job, request): Promise<CompletionResult> {
      requests.push(request);
      return { text: replies.shift() ?? "", provider: "groq", model: "m", inputTokens: 1, outputTokens: 1 };
    },
  };
}

const Schema = z.object({ task_id: z.string(), confidence: z.number().min(0).max(1) });
const request = { messages: [{ role: "user" as const, content: "link this" }], maxTokens: 100 };

describe("extractJsonObject", () => {
  it("finds JSON wrapped in prose or code fences", () => {
    expect(extractJsonObject('Sure!\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("throws when there is no object", () => {
    expect(() => extractJsonObject("no idea")).toThrow(SyntaxError);
  });
});

describe("runJson", () => {
  it("returns the parsed reply and asks for JSON mode", async () => {
    const router = scriptedRouter(['{"task_id":"task_1","confidence":0.9}']);
    await expect(runJson(router, "link_suggestion", request, Schema)).resolves.toEqual({
      task_id: "task_1",
      confidence: 0.9,
    });
    expect(router.requests[0].json).toBe(true);
  });

  it("retries once with the validation error", async () => {
    const router = scriptedRouter([
      '{"task_id":"task_1","confidence":7}',
      '{"task_id":"task_1","confidence":0.7}',
    ]);
    await expect(runJson(router, "link_suggestion", request, Schema)).resolves.toMatchObject({
      confidence: 0.7,
    });
    const feedback = router.requests[1].messages.at(-1)!.content;
    expect(feedback).toContain("confidence");
  });

  it("gives up after a second invalid reply", async () => {
    const router = scriptedRouter(["nope", '{"task_id":1}']);
    await expect(runJson(router, "link_suggestion", request, Schema)).rejects.toBeInstanceOf(
      InvalidModelReplyError,
    );
  });
});
