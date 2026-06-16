export type PipelineModelConfig =
  | { provider: "deterministic"; model: "deterministic" }
  | { provider: "openai-compatible"; baseUrl: string; model: string; apiKey?: string }
  | { provider: "anthropic-compatible"; baseUrl: string; model: string; apiKey?: string; anthropicVersion: string };

export function normalizeModelConfig(input: unknown, legacyModel = "deterministic"): PipelineModelConfig {
  if (isRecord(input) && input.provider === "openai-compatible") {
    return {
      provider: "openai-compatible",
      baseUrl: stringValue(input.baseUrl, "https://api.openai.com/v1").replace(/\/+$/u, ""),
      model: stringValue(input.model, legacyModel === "deterministic" ? "gpt-4.1-mini" : legacyModel),
      apiKey: optionalString(input.apiKey),
    };
  }

  if (isRecord(input) && input.provider === "anthropic-compatible") {
    return {
      provider: "anthropic-compatible",
      baseUrl: stringValue(input.baseUrl, "https://api.anthropic.com/v1").replace(/\/+$/u, ""),
      model: stringValue(input.model, legacyModel === "deterministic" ? "claude-sonnet-4-5" : legacyModel),
      apiKey: optionalString(input.apiKey),
      anthropicVersion: stringValue(input.anthropicVersion, "2023-06-01"),
    };
  }

  return { provider: "deterministic", model: "deterministic" };
}

export function modelName(config: PipelineModelConfig): string {
  return config.provider === "deterministic" ? "deterministic" : config.model;
}

export function redactModelConfig(config: PipelineModelConfig): Record<string, unknown> {
  if (config.provider === "deterministic") return { provider: "deterministic", model: "deterministic" };
  if (config.provider === "anthropic-compatible") {
    return {
      provider: "anthropic-compatible",
      baseUrl: config.baseUrl,
      model: config.model,
      anthropicVersion: config.anthropicVersion,
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
