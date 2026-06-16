import type { PipelineModelConfig } from "./modelConfig";

export interface ModelConnectivityResult {
  ok: boolean;
  provider: PipelineModelConfig["provider"];
  model: string;
  message: string;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export async function testModelConnectivity(
  config: PipelineModelConfig,
  fetchImpl: FetchLike = fetch,
): Promise<ModelConnectivityResult> {
  if (config.provider === "deterministic") {
    return {
      ok: false,
      provider: config.provider,
      model: config.model,
      message: "请切换到 OpenAI-compatible 或 Anthropic-compatible，并填写 Base URL、Model 和 API Key 后再测试连接。"
    };
  }

  if (!config.apiKey) {
    return {
      ok: false,
      provider: config.provider,
      model: config.model,
      message: "请填写 OpenAI-compatible API Key 后再测试连接。"
    };
  }

  if (config.provider === "anthropic-compatible") {
    return testAnthropicConnectivity(config, fetchImpl);
  }

  return testOpenAIConnectivity(config, fetchImpl);
}

async function testOpenAIConnectivity(
  config: Extract<PipelineModelConfig, { provider: "openai-compatible" }>,
  fetchImpl: FetchLike,
): Promise<ModelConnectivityResult> {
  const baseUrl = config.baseUrl.replace(/\/+$/u, "");
  try {
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 1,
        messages: [
          { role: "system", content: "Reply with ok." },
          { role: "user", content: "ping" },
        ],
      }),
    });

    if (!response.ok) {
      return {
        ok: false,
        provider: config.provider,
        model: config.model,
        message: `模型连接失败：${response.status} ${extractErrorMessage(await response.text(), response.statusText)}`,
      };
    }

    return {
      ok: true,
      provider: config.provider,
      model: config.model,
      message: "模型连接成功。"
    };
  } catch (error) {
    return {
      ok: false,
      provider: config.provider,
      model: config.model,
      message: `模型连接失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function testAnthropicConnectivity(
  config: Extract<PipelineModelConfig, { provider: "anthropic-compatible" }>,
  fetchImpl: FetchLike,
): Promise<ModelConnectivityResult> {
  const baseUrl = config.baseUrl.replace(/\/+$/u, "");
  try {
    const response = await fetchImpl(`${baseUrl}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.apiKey ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 1,
        system: "Reply with ok.",
        messages: [
          { role: "user", content: [{ type: "text", text: "ping" }] },
        ],
      }),
    });

    if (!response.ok) {
      return {
        ok: false,
        provider: config.provider,
        model: config.model,
        message: `模型连接失败：${response.status} ${extractErrorMessage(await response.text(), response.statusText)}`,
      };
    }

    return {
      ok: true,
      provider: config.provider,
      model: config.model,
      message: "模型连接成功。"
    };
  } catch (error) {
    return {
      ok: false,
      provider: config.provider,
      model: config.model,
      message: `模型连接失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function extractErrorMessage(body: string, fallback: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown };
    if (typeof parsed.error?.message === "string") return parsed.error.message;
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // Fall through to plain text.
  }
  return body.trim() || fallback;
}
