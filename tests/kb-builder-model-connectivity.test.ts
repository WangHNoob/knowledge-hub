import { describe, expect, it } from "vitest";

import { testModelConnectivity } from "../src/server/services/kbBuilder/modelConnectivity";

describe("model connectivity", () => {
  it("tests OpenAI-compatible chat completion without exposing the API key", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const result = await testModelConnectivity({
      provider: "openai-compatible",
      baseUrl: "https://llm.local/v1/",
      model: "gpt-test",
      apiKey: "secret-key",
    }, async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 1,
        model: "gpt-test",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200 });
    });

    expect(result).toEqual({
      ok: true,
      provider: "openai-compatible",
      model: "gpt-test",
      message: "模型连接成功。"
    });
    expect(calls[0].url).toBe("https://llm.local/v1/chat/completions");
    expect(calls[0].init.headers).toMatchObject({ authorization: "Bearer secret-key" });
    expect(JSON.stringify(result)).not.toContain("secret-key");
  });

  it("treats a 200 reasoning-model response (thinking only, no text) as a successful connection", async () => {
    // 复现 ark/deepseek-v4-pro：探针 max_tokens 极小时，模型只产出 thinking、无 text，
    // HTTP 却是 200。端点/鉴权/模型都可用，连接应判为成功。
    const result = await testModelConnectivity({
      provider: "anthropic",
      baseUrl: "https://ark.cn-beijing.volces.com/api/coding",
      model: "deepseek-v4-pro",
      apiKey: "secret-key",
    }, async () => new Response(JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "deepseek-v4-pro",
      content: [{ type: "thinking", thinking: "We" }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 9, output_tokens: 2, cache_read_input_tokens: 0 },
    }), { status: 200 }));

    expect(result.ok).toBe(true);
    expect(result.message).toBe("模型连接成功。");
    expect(JSON.stringify(result)).not.toContain("secret-key");
  });

  it("returns a readable failure when the provider rejects the request", async () => {
    const result = await testModelConnectivity({
      provider: "openai-compatible",
      baseUrl: "https://llm.local/v1",
      model: "gpt-test",
      apiKey: "secret-key",
    }, async () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401, statusText: "Unauthorized" }));

    expect(result.ok).toBe(false);
    expect(result.message).toContain("401");
    expect(result.message).toContain("bad key");
    expect(JSON.stringify(result)).not.toContain("secret-key");
  });
});
