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
      return new Response(JSON.stringify({ id: "chatcmpl-test" }), { status: 200 });
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
