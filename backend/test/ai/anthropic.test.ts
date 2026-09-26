import { describe, expect, it, vi } from "vitest";
import { anthropicClient } from "../../src/ai/anthropic.js";

describe("anthropicClient", () => {
  it("sends a messages request and joins text blocks", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            content: [
              { type: "text", text: '{"ok":' },
              { type: "text", text: "true}" },
            ],
            usage: { input_tokens: 50, output_tokens: 4 },
          }),
          { status: 200 },
        ),
    );
    const client = anthropicClient("claude-sonnet-5", "key", fetchMock);
    const result = await client.complete({
      system: "you maintain projects",
      messages: [{ role: "user", content: "status?" }],
      maxTokens: 200,
      json: true,
    });

    expect(result).toEqual({
      text: '{"ok":true}',
      provider: "anthropic",
      model: "claude-sonnet-5",
      inputTokens: 50,
      outputTokens: 4,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(init.body as string);
    expect(body.system).toContain("you maintain projects");
    expect(body.system).toContain("single JSON object");
    expect(body.messages).toEqual([{ role: "user", content: "status?" }]);
  });
});
