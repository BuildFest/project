import type { ProviderName } from "./config.js";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  system?: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  // Ask the provider for a JSON object reply where it supports that natively.
  json?: boolean;
}

export interface CompletionResult {
  text: string;
  provider: ProviderName;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ModelClient {
  readonly provider: ProviderName;
  readonly model: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export type Fetch = typeof fetch;

export class ModelError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

// POSTs JSON and retries once on rate limits, server errors and network failures.
export async function postJson(
  fetchImpl: Fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<unknown> {
  let lastError: ModelError | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    } catch (err) {
      lastError = new ModelError(`request to ${url} failed: ${(err as Error).message}`, null, true);
      continue;
    }
    if (res.ok) return res.json();
    const retryable = res.status === 429 || res.status >= 500;
    const detail = (await res.text().catch(() => "")).slice(0, 500);
    lastError = new ModelError(`${url} returned ${res.status}: ${detail}`, res.status, retryable);
    if (!retryable) break;
  }
  throw lastError;
}
