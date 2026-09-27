import { ModelError, postJson, type CompletionRequest, type Fetch, type ModelClient } from "./client.js";

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
}

interface ResponsesApiResponse {
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  output_text?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

// Foundry's hosted-agent Responses protocol requires api-version on every
// call ("Missing required query parameter: api-version" otherwise); the
// non-dated "v1" surface is what this endpoint shape (…/endpoint/protocols/
// openai/responses) expects. Overridable in case Azure changes it.
export const DEFAULT_FOUNDRY_API_VERSION = "v1";

export function foundryResponsesUrl(endpoint: string, apiVersion = DEFAULT_FOUNDRY_API_VERSION): string {
  const url = new URL(endpoint);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/responses") ? path : `${path}/responses`;
  if (!url.searchParams.has("api-version")) url.searchParams.set("api-version", apiVersion);
  return url.toString();
}

function responseText(response: ResponsesApiResponse): string {
  if (response.output_text) return response.output_text;
  return (response.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text ?? "")
    .join("");
}

function entraTokenProvider(
  tenantId: string,
  clientId: string,
  clientSecret: string,
  fetchImpl: Fetch,
) {
  let cached: { token: string; expiresAt: number } | null = null;
  return async () => {
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const url = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "client_credentials",
          scope: "https://ai.azure.com/.default",
        }),
      });
    } catch (error) {
      throw new ModelError(`Microsoft Entra token request failed: ${(error as Error).message}`, null, true);
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 500);
      throw new ModelError(`Microsoft Entra token request returned ${response.status}: ${detail}`, response.status, response.status >= 500);
    }
    const data = (await response.json()) as TokenResponse;
    if (!data.access_token) throw new ModelError("Microsoft Entra token response did not include an access token", 502, false);
    cached = {
      token: data.access_token,
      expiresAt: Date.now() + Math.max(60, data.expires_in ?? 3_600) * 1_000,
    };
    return cached.token;
  };
}

/** Invokes an existing Microsoft Foundry agent through its Responses endpoint. */
export function foundryAgentClient(
  label: string,
  endpoint: string,
  tenantId: string,
  clientId: string,
  clientSecret: string,
  fetchImpl: Fetch = fetch,
  apiVersion = DEFAULT_FOUNDRY_API_VERSION,
): ModelClient {
  const url = foundryResponsesUrl(endpoint, apiVersion);
  const getToken = entraTokenProvider(tenantId, clientId, clientSecret, fetchImpl);
  return {
    provider: "foundry",
    model: label,
    async complete(request: CompletionRequest) {
      const token = await getToken();
      // Each item needs an explicit type: "message" — Azure rejects it
      // otherwise ("Invalid value: ''. Supported values are: ...").
      const input = [
        ...(request.system ? [{ type: "message" as const, role: "developer" as const, content: request.system }] : []),
        ...request.messages.map((m) => ({ type: "message" as const, ...m })),
      ];
      const data = (await postJson(
        fetchImpl,
        url,
        { authorization: `Bearer ${token}` },
        {
          input,
          max_output_tokens: request.maxTokens,
          // The agent owns its model and reasoning settings. The application
          // supplies only task context and validates JSON after the response.
        },
      )) as ResponsesApiResponse;
      return {
        text: responseText(data),
        provider: "foundry",
        model: label,
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
      };
    },
  };
}
