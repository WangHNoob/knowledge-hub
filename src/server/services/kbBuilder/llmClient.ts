import type { PipelineModelConfig } from "./modelConfig";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** A JSON Schema (derived from a Zod schema) plus the name the provider requires. */
export interface JsonSchemaSpec {
  name: string;
  schema: Record<string, unknown>;
}

/**
 * Provider-agnostic completion request. Callers describe *what* they want, not
 * how a given provider's wire format spells it.
 *
 * Output-shape preference is best-effort and degrades gracefully so switching
 * models never breaks the pipeline:
 *   - `jsonSchema` → native structured output (OpenAI `response_format:
 *     json_schema` / Anthropic `output_config.format`); the strongest guarantee.
 *   - `jsonMode`   → JSON object mode (OpenAI `response_format: json_object`).
 * A provider/model that rejects the stronger mode is downgraded one step and
 * retried, and the capability is remembered for the rest of the run. Callers
 * should still validate the returned text against their schema.
 */
export interface LlmCompletionRequest {
  system: string;
  user: string;
  maxTokens?: number;
  jsonMode?: boolean;
  jsonSchema?: JsonSchemaSpec;
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

// OpenAI structured-output capability, strongest first. Negotiated downward
// when a gateway rejects a level, and remembered for the rest of the run.
//   2 = response_format: json_schema   1 = response_format: json_object   0 = none
type JsonLevel = 0 | 1 | 2;

class OpenAiCompatibleClient implements LlmClient {
  readonly provider = "openai-compatible" as const;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private maxJsonLevel: JsonLevel = 2;

  constructor(config: Extract<PipelineModelConfig, { provider: "openai-compatible" }>, private readonly fetchImpl: FetchLike) {
    this.model = config.model;
    this.baseUrl = config.baseUrl.replace(/\/+$/u, "");
    this.apiKey = config.apiKey;
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResult> {
    let level = this.desiredLevel(request);
    while (true) {
      const response = await this.post(request, level);
      if (response.ok) return { text: await readChatContent(response, this.model) };

      const body = await safeText(response);
      // Many "OpenAI-compatible" gateways don't implement response_format (json_schema
      // or json_object) and reject it with a 400. Step down one level, remember it,
      // and retry — schema → object → plain — instead of failing the run.
      if (level > 0 && response.status === 400 && mentionsStructuredOutput(body)) {
        level = (level - 1) as JsonLevel;
        this.maxJsonLevel = level;
        continue;
      }
      throw httpError(this.model, response.status, response.statusText, body);
    }
  }

  async ping(request: LlmCompletionRequest): Promise<void> {
    const response = await this.post(request, 0);
    if (!response.ok) throw httpError(this.model, response.status, response.statusText, await safeText(response));
  }

  private desiredLevel(request: LlmCompletionRequest): JsonLevel {
    const wanted: JsonLevel = request.jsonSchema ? 2 : request.jsonMode ? 1 : 0;
    return Math.min(wanted, this.maxJsonLevel) as JsonLevel;
  }

  private post(request: LlmCompletionRequest, level: JsonLevel): Promise<Response> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
    };
    if (request.maxTokens != null) body.max_tokens = request.maxTokens;
    if (level === 2 && request.jsonSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: request.jsonSchema.name, strict: true, schema: request.jsonSchema.schema },
      };
    } else if (level >= 1) {
      body.response_format = { type: "json_object" };
    }
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
  private structuredSupported = true;

  constructor(config: Extract<PipelineModelConfig, { provider: "anthropic" }>, private readonly fetchImpl: FetchLike) {
    this.model = config.model;
    this.endpoint = anthropicMessagesEndpoint(config.baseUrl);
    this.apiKey = config.apiKey;
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResult> {
    const useSchema = Boolean(request.jsonSchema) && this.structuredSupported;
    const response = await this.post(request, useSchema);
    if (response.ok) return { text: await readMessageContent(response, this.model) };

    const body = await safeText(response);
    // Older models / proxies may not support output_config structured outputs.
    // Drop it, remember, and retry on prompt-only steering.
    if (useSchema && response.status === 400 && mentionsStructuredOutput(body)) {
      this.structuredSupported = false;
      const retry = await this.post(request, false);
      if (retry.ok) return { text: await readMessageContent(retry, this.model) };
      throw httpError(this.model, retry.status, retry.statusText, await safeText(retry), this.endpoint);
    }
    throw httpError(this.model, response.status, response.statusText, body, this.endpoint);
  }

  async ping(request: LlmCompletionRequest): Promise<void> {
    const response = await this.post(request, false);
    if (!response.ok) {
      throw httpError(this.model, response.status, response.statusText, await safeText(response), this.endpoint);
    }
  }

  private post(request: LlmCompletionRequest, useSchema: boolean): Promise<Response> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: request.maxTokens ?? 4096,
      system: request.system,
      messages: [{ role: "user", content: [{ type: "text", text: request.user }] }],
    };
    if (useSchema && request.jsonSchema) {
      body.output_config = { format: { type: "json_schema", schema: request.jsonSchema.schema } };
    }
    return this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
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

async function readMessageContent(response: Response, model: string): Promise<string> {
  const json = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };
  const content = json.content?.find((item) => item.type === "text" && item.text)?.text;
  if (!content) throw new LlmError(`${model} returned no content`);
  return content;
}

function httpError(model: string, status: number, statusText: string, body: string, endpoint?: string): LlmError {
  const where = endpoint ? `（请求地址：${endpoint}）` : "";
  const detail = body ? ` — ${body.length > 800 ? `${body.slice(0, 800)}…` : body}` : "";
  return new LlmError(`${model} request failed: ${status} ${statusText}${where}${detail}`, { status, body });
}

function mentionsStructuredOutput(body: string): boolean {
  return /response_format|json_object|json_schema|output_config|structured\s*output/i.test(body);
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}
