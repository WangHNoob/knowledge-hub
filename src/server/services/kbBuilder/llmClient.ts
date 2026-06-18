import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError, generateText, jsonSchema, NoObjectGeneratedError, Output, type LanguageModel } from "ai";
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
 * AI SDK 6 owns provider-specific request shaping and structured-output support.
 * This adapter only negotiates the project-level fallback ladder:
 *   - `jsonSchema` → SDK structured object output.
 *   - `jsonMode`   → SDK JSON output.
 *   - plain text   → prompt-only generation.
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
  return new AiSdkLlmClient(config, fetchImpl);
}

// Structured-output capability, strongest first. Negotiated downward when a
// gateway rejects a level, and remembered for the rest of the run.
//   2 = schema-constrained object   1 = generic JSON   0 = plain text
type JsonLevel = 0 | 1 | 2;

class AiSdkLlmClient implements LlmClient {
  readonly provider;
  readonly model: string;
  private maxJsonLevel: JsonLevel = 2;

  constructor(
    private readonly config: Exclude<PipelineModelConfig, { provider: "deterministic" }>,
    private readonly fetchImpl: FetchLike,
  ) {
    this.provider = config.provider;
    this.model = config.model;
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResult> {
    let level = this.desiredLevel(request);
    while (true) {
      try {
        return await this.generate(request, level);
      } catch (error) {
        if (level > 0 && isStructuredOutputFailure(error)) {
          level = (level - 1) as JsonLevel;
          this.maxJsonLevel = level;
          continue;
        }
        throw toLlmError(this.model, error, endpointForError(this.config));
      }
    }
  }

  async ping(request: LlmCompletionRequest): Promise<void> {
    try {
      await this.generate(request, 0);
    } catch (error) {
      throw toLlmError(this.model, error, endpointForError(this.config));
    }
  }

  private desiredLevel(request: LlmCompletionRequest): JsonLevel {
    const wanted: JsonLevel = request.jsonSchema ? 2 : request.jsonMode ? 1 : 0;
    return Math.min(wanted, this.maxJsonLevel) as JsonLevel;
  }

  private languageModel(level: JsonLevel): LanguageModel {
    if (this.config.provider === "anthropic") {
      const provider = createAnthropic({
        apiKey: this.config.apiKey,
        baseURL: anthropicProviderBaseUrl(this.config.baseUrl),
        fetch: adaptFetch(this.fetchImpl),
      });
      return provider(this.model);
    }

    const provider = createOpenAICompatible({
      name: "openai-compatible",
      apiKey: this.config.apiKey,
      baseURL: this.config.baseUrl.replace(/\/+$/u, ""),
      fetch: adaptFetch(this.fetchImpl),
      supportsStructuredOutputs: level === 2,
    });
    return provider(this.model);
  }

  private async generate(request: LlmCompletionRequest, level: JsonLevel): Promise<LlmCompletionResult> {
    const base = {
      model: this.languageModel(level),
      system: request.system,
      prompt: request.user,
      maxOutputTokens: request.maxTokens,
      maxRetries: 0,
    };

    if (level === 2 && request.jsonSchema) {
      const result = await generateText({
        ...base,
        output: Output.object({
          name: request.jsonSchema.name,
          schema: jsonSchema(request.jsonSchema.schema),
        }),
      });
      return { text: JSON.stringify(result.output) };
    }

    if (level >= 1) {
      const result = await generateText({
        ...base,
        output: Output.json({ name: request.jsonSchema?.name }),
      });
      return { text: JSON.stringify(result.output) };
    }

    const result = await generateText(base);
    return { text: result.text };
  }
}

function adaptFetch(fetchImpl: FetchLike) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => fetchImpl(String(input), init);
}

export function anthropicMessagesEndpoint(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/u, "");
  if (normalized.endsWith("/messages")) return normalized;
  if (normalized.endsWith("/v1")) return `${normalized}/messages`;
  return `${normalized}/v1/messages`;
}

function anthropicProviderBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/u, "");
  if (normalized.endsWith("/messages")) return normalized.replace(/\/messages$/u, "");
  if (normalized.endsWith("/v1")) return normalized;
  return `${normalized}/v1`;
}

function endpointForError(config: Exclude<PipelineModelConfig, { provider: "deterministic" }>): string | undefined {
  return config.provider === "anthropic" ? anthropicMessagesEndpoint(config.baseUrl) : undefined;
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

function toLlmError(model: string, error: unknown, endpoint?: string): LlmError {
  if (error instanceof LlmError) return error;
  if (NoObjectGeneratedError.isInstance(error) && error.text) return new LlmError(error.message, { body: error.text });
  if (APICallError.isInstance(error)) {
    return httpError(model, error.statusCode ?? 0, statusText(error), error.responseBody ?? error.message, endpoint ?? error.url);
  }
  return new LlmError(error instanceof Error ? error.message : String(error));
}

function isStructuredOutputFailure(error: unknown): boolean {
  if (NoObjectGeneratedError.isInstance(error)) return true;
  if (!APICallError.isInstance(error)) return false;
  return error.statusCode === 400 && mentionsStructuredOutput(`${error.responseBody ?? ""}\n${error.message}`);
}

function httpError(model: string, status: number, statusTextValue: string, body: string, endpoint?: string): LlmError {
  const where = endpoint ? `（请求地址：${endpoint}）` : "";
  const detail = body ? ` — ${body.length > 800 ? `${body.slice(0, 800)}...` : body}` : "";
  return new LlmError(`${model} request failed: ${status} ${statusTextValue}${where}${detail}`, { status, body });
}

function statusText(error: APICallError): string {
  const match = /(\d{3})\s+([A-Za-z][^\n:]+)/u.exec(error.message);
  return match?.[2]?.trim() ?? "Provider Error";
}

function mentionsStructuredOutput(body: string): boolean {
  return /response_format|json_object|json_schema|output_config|structured\s*output|schema/i.test(body);
}
