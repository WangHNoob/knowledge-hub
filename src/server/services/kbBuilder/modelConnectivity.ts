import type { PipelineModelConfig } from "./modelConfig";
import { probeMaxTokens } from "./modelConfig";
import {
  anthropicMessagesEndpoint,
  createLlmClient,
  extractErrorMessage,
  LlmError,
  type FetchLike,
} from "./llmClient";

export interface ModelConnectivityResult {
  ok: boolean;
  provider: PipelineModelConfig["provider"];
  model: string;
  message: string;
}

export async function testModelConnectivity(
  config: PipelineModelConfig,
  fetchImpl: FetchLike = fetch,
): Promise<ModelConnectivityResult> {
  if (config.provider === "deterministic") {
    return {
      ok: false,
      provider: config.provider,
      model: config.model,
      message: "请切换到 OpenAI-compatible 或 Anthropic，并填写 Base URL、Model 和 API Key 后再测试连接。",
    };
  }

  if (!config.apiKey) {
    return {
      ok: false,
      provider: config.provider,
      model: config.model,
      message: "请填写 API Key 后再测试连接。",
    };
  }

  const client = createLlmClient(config, fetchImpl);
  if (!client) {
    return { ok: false, provider: config.provider, model: config.model, message: "无法为该模型创建客户端。" };
  }

  try {
    await client.ping({ system: "Reply with ok.", user: "ping", maxTokens: probeMaxTokens() });
    return { ok: true, provider: config.provider, model: config.model, message: "模型连接成功。" };
  } catch (error) {
    return { ok: false, provider: config.provider, model: config.model, message: failureMessage(config, error) };
  }
}

function failureMessage(config: PipelineModelConfig, error: unknown): string {
  if (error instanceof LlmError && error.status != null) {
    const endpointNote =
      config.provider === "anthropic" && "baseUrl" in config
        ? `。请求地址：${anthropicMessagesEndpoint(config.baseUrl)}`
        : "";
    return `模型连接失败：${error.status} ${extractErrorMessage(error.body ?? "", "")}${endpointNote}`;
  }
  return `模型连接失败：${error instanceof Error ? error.message : String(error)}`;
}
