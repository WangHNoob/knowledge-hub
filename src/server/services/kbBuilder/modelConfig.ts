export type PipelineModelConfig =
  | { provider: "deterministic"; model: "deterministic" }
  | { provider: "openai-compatible"; baseUrl: string; model: string; apiKey?: string }
  | { provider: "anthropic"; baseUrl: string; model: string; apiKey?: string };

export function normalizeModelConfig(input: unknown, legacyModel = "deterministic"): PipelineModelConfig {
  if (isRecord(input) && input.provider === "openai-compatible") {
    return {
      provider: "openai-compatible",
      baseUrl: stringValue(input.baseUrl, "https://api.openai.com/v1").replace(/\/+$/u, ""),
      model: stringValue(input.model, legacyModel === "deterministic" ? "gpt-4.1-mini" : legacyModel),
      apiKey: optionalString(input.apiKey),
    };
  }

  if (isRecord(input) && input.provider === "anthropic") {
    return {
      provider: "anthropic",
      baseUrl: stringValue(input.baseUrl, "https://api.anthropic.com/v1").replace(/\/+$/u, ""),
      model: stringValue(input.model, legacyModel === "deterministic" ? "claude-sonnet-4-5" : legacyModel),
      apiKey: optionalString(input.apiKey),
    };
  }

  return { provider: "deterministic", model: "deterministic" };
}

export function modelName(config: PipelineModelConfig): string {
  return config.provider === "deterministic" ? "deterministic" : config.model;
}

export function redactModelConfig(config: PipelineModelConfig): Record<string, unknown> {
  if (config.provider === "deterministic") return { provider: "deterministic", model: "deterministic" };
  if (config.provider === "anthropic") {
    return {
      provider: "anthropic",
      baseUrl: config.baseUrl,
      model: config.model,
      apiKeyConfigured: Boolean(config.apiKey),
    };
  }
  return {
    provider: "openai-compatible",
    baseUrl: config.baseUrl,
    model: config.model,
    apiKeyConfigured: Boolean(config.apiKey),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function extractMaxTokens(): number {
  return readPositiveInt("KH_KB_EXTRACT_MAX_TOKENS", 4096);
}

export function probeMaxTokens(): number {
  return readPositiveInt("KH_MODEL_PROBE_MAX_TOKENS", 1);
}

/** 每次 LLM 请求的超时（毫秒）。防止慢/不可达的供应商让构建无限挂起、无法中止。 */
export function requestTimeoutMs(): number {
  return readPositiveInt("KH_LLM_REQUEST_TIMEOUT_MS", 180000);
}

/** 连接探针的超时（毫秒）——比正式请求短，测试连接不该长时间转圈。 */
export function probeTimeoutMs(): number {
  return readPositiveInt("KH_MODEL_PROBE_TIMEOUT_MS", 30000);
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: expected positive integer, got "${raw}"`);
  }
  return parsed;
}
