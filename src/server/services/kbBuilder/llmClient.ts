import type { PipelineModelConfig } from "./modelConfig";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Provider-agnostic completion request. Callers describe *what* they want, not
 * how a given provider's wire format spells it. `jsonMode` is a best-effort
 * hint: providers that support it constrain output to a JSON object; providers
 * that don't (or models that reject the param) silently fall back to prompt-only
 * steering, so switching models never breaks the pipeline.
 */
export interface LlmCompletionRequest {
  system: string;
  user: string;
  maxTokens?: number;
  jsonMode?: boolean;
}

export interface LlmCompletionResult {
  text: string;
}

export interface LlmClient {
  readonly provider: Exclude<PipelineModelConfig["provider"], "deterministic">;
  readonly model: string;
  complete(request: LlmCompletionRequest): Promise<LlmCompletionResult>;
  /** Verify the endpoint/auth/model accept a request, without requiring output content. */
  ping(request: LlmCompletionRequest): Promise<void>;
}

/** Transport/HTTP-level failure from a provider, carrying the raw status/body. */
export class LlmError extends Error {
  readonly status?: number;
  readonly body?: string;

  constructor(message: string, options: { status?: number; body?: string } = {}) {
    super(message);
    this.name = "LlmError";
    this.status = options.status;
    this.body = options.body;
  }
}

/**
 * Build the client for a model config. Returns null for the deterministic
 * provider, which performs no network calls — callers handle that branch.
 */
export function createLlmClient(config: PipelineModelConfig, fetchImpl: FetchLike = fetch): LlmClient | null {
  if (config.provider === "deterministic") return null;
  if (config.provider === "anthropic") return new AnthropicClient(config, fetchImpl);
  return new OpenAiCompatibleClient(config, fetchImpl);
}

class OpenAiCompatibleClient implements LlmClient {
  readonly provider = "openai-compatible" as const;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  // Remembered per client instance: once a model rejects response_format we stop
  // sending it for the rest of this run instead of paying a failed request each call.
  private jsonModeSupported = true;

  constructor(config: Extract<PipelineModelConfig, { provider: "openai-compatible" }>, private readonly fetchImpl: FetchLike) {
    this.model = config.model;
    this.baseUrl = config.baseUrl.replace(/\/+$/u, "");
    this.apiKey = config.apiKey;
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResult> {
    const wantJsonMode = Boolean(request.jsonMode) && this.jsonModeSupported;
    const response = await this.post(request, wantJsonMode);

    if (response.ok) return { text: await readChatContent(response, this.model) };

    const body = await safeText(response);
    // Many "OpenAI-compatible" gateways don't implement response_format/json_object
    // and reject it with a 400. Drop the param, remember it, and retry once.
    if (wantJsonMode && response.status === 400 && mentionsResponseFormat(body)) {
      this.jsonModeSupported = false;
      const retry = await this.post(request, false);
      if (retry.ok) return { text: await readChatContent(retry, this.model) };
      throw httpError(this.model, retry.status, retry.statusText, await safeText(retry));
    }
    throw httpError(this.model, response.status, response.statusText, body);
  }

  async ping(request: LlmCompletionRequest): Promise<void> {
    const response = await this.post(request, false);
    if (!response.ok) throw httpError(this.model, response.status, response.statusText, await safeText(response));
  }

  private post(request: LlmCompletionRequest, useJsonMode: boolean): Promise<Response> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
    };
    if (request.maxTokens != null) body.max_tokens = request.maxTokens;
    if (useJsonMode) body.response_format = { type: "json_object" };
    return this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey ?? ""}`,
      },
      body: JSON.stringify(body),
    });
  }
}

class AnthropicClient implements LlmClient {
  readonly provider = "anthropic" as const;
  readonly model: string;
  private readonly endpoint: string;
  private readonly apiKey?: string;

  constructor(config: Extract<PipelineModelConfig, { provider: "anthropic" }>, private readonly fetchImpl: FetchLike) {
    this.model = config.model;
    this.endpoint = anthropicMessagesEndpoint(config.baseUrl);
    this.apiKey = config.apiKey;
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResult> {
    const response = await this.post(request);
    if (!response.ok) {
      throw httpError(this.model, response.status, response.statusText, await safeText(response), this.endpoint);
    }

    const json = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };
    const content = json.content?.find((item) => item.type === "text" && item.text)?.text;
    if (!content) throw new LlmError(`${this.model} returned no content`);
    return { text: content };
  }

  async ping(request: LlmCompletionRequest): Promise<void> {
    const response = await this.post(request);
    if (!response.ok) {
      throw httpError(this.model, response.status, response.statusText, await safeText(response), this.endpoint);
    }
  }

  private post(request: LlmCompletionRequest): Promise<Response> {
    // Anthropic has no response_format param; JSON output is steered by the
    // prompt, so jsonMode needs no special handling here. max_tokens is required.
    return this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: request.maxTokens ?? 4096,
        system: request.system,
        messages: [{ role: "user", content: [{ type: "text", text: request.user }] }],
      }),
    });
  }
}

export function anthropicMessagesEndpoint(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/u, "");
  if (normalized.endsWith("/messages")) return normalized;
  if (normalized.endsWith("/v1")) return `${normalized}/messages`;
  return `${normalized}/v1/messages`;
}

/** Extract a human-readable message from a provider error body, JSON or text. */
export function extractErrorMessage(body: string, fallback: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown };
    if (typeof parsed.error?.message === "string") return parsed.error.message;
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // Fall through to plain text.
  }
  return body.trim() || fallback;
}

async function readChatContent(response: Response, model: string): Promise<string> {
  const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new LlmError(`${model} returned no content`);
  return content;
}

function httpError(model: string, status: number, statusText: string, body: string, endpoint?: string): LlmError {
  const where = endpoint ? `（请求地址：${endpoint}）` : "";
  const detail = body ? ` — ${body.length > 800 ? `${body.slice(0, 800)}…` : body}` : "";
  return new LlmError(`${model} request failed: ${status} ${statusText}${where}${detail}`, { status, body });
}

function mentionsResponseFormat(body: string): boolean {
  return /response_format|json_object/i.test(body);
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}
