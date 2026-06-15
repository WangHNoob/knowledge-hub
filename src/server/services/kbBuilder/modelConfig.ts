export type PipelineModelConfig =
  | { provider: "deterministic"; model: "deterministic" }
  | { provider: "openai-compatible"; baseUrl: string; model: string; apiKey?: string };

export function normalizeModelConfig(input: unknown, legacyModel = "deterministic"): PipelineModelConfig {
  if (isRecord(input) && input.provider === "openai-compatible") {
    return {
      provider: "openai-compatible",
      baseUrl: stringValue(input.baseUrl, "https://api.openai.com/v1").replace(/\/+$/u, ""),
      model: stringValue(input.model, legacyModel === "deterministic" ? "gpt-4.1-mini" : legacyModel),
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
