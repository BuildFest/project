import { describe, expect, it, vi } from "vitest";
import { foundryAgentClient, foundryResponsesUrl } from "../../src/ai/foundryAgent.js";

function reply(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("foundryAgentClient", () => {
  it("accepts an OpenAI protocol base or complete Responses URL", () => {
    const base = "https://example.services.ai.azure.com/api/projects/p/agents/PitCrewer/endpoint/protocols/openai";
    expect(foundryResponsesUrl(base)).toBe(`${base}/responses`);
    expect(foundryResponsesUrl(`${base}/responses`)).toBe(`${base}/responses`);
  });

  it("gets an Entra token and invokes the agent without model reasoning settings", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith("https://login.microsoftonline.com/")) {
        return reply({ access_token: "token", expires_in: 3600 });
      }
      return reply({
        output: [{ content: [{ type: "output_text", text: "{\"ok\":true}" }] }],
        usage: { input_tokens: 40, output_tokens: 7 },
      });
    });
    const endpoint = "https://example.services.ai.azure.com/api/projects/p/agents/PitCrewer/endpoint/protocols/openai";
    const client = foundryAgentClient("PitCrewer", endpoint, "tenant", "client", "secret", fetchMock);
    const result = await client.complete({
      system: "Return JSON.",
      messages: [{ role: "user", content: "Plan this project" }],
      maxTokens: 2_000,
      temperature: 0.2,
      json: true,
    });

    expect(result).toMatchObject({ text: '{"ok":true}', provider: "foundry", model: "PitCrewer" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const tokenCall = fetchMock.mock.calls[0];
    expect(String(tokenCall[0])).toContain("/tenant/oauth2/v2.0/token");
    expect(String(tokenCall[1]?.body)).toContain("scope=https%3A%2F%2Fai.azure.com%2F.default");
    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe(`${endpoint}/responses`);
    expect(init.headers).toMatchObject({ authorization: "Bearer token" });
    expect(JSON.parse(init.body as string)).toEqual({
      input: [
        { role: "developer", content: "Return JSON." },
        { role: "user", content: "Plan this project" },
      ],
      max_output_tokens: 2_000,
    });
  });
});
