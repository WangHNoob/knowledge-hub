import { describe, expect, it } from "vitest";

import { createLlmClient, LlmError } from "../src/server/services/kbBuilder/llmClient";

const OPENAI = { provider: "openai-compatible", baseUrl: "https://llm.local/v1", model: "m", apiKey: "k" } as const;

function chatOk(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

describe("llm client — provider abstraction", () => {
  it("drops response_format and retries when the model rejects json_object, then remembers", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body.response_format) {
        return new Response(
          JSON.stringify({ error: { message: "`json_object` is not supported by this model", param: "response_format.type" } }),
          { status: 400, statusText: "Bad Request" },
        );
      }
      return chatOk('{"type":"concept","title":"X"}');
    };

    const client = createLlmClient(OPENAI, fetchImpl)!;

    const first = await client.complete({ system: "s", user: "u", jsonMode: true });
    expect(first.text).toContain("concept");
    // attempted with response_format, got 400, retried without it
    expect(bodies).toHaveLength(2);
    expect(bodies[0].response_format).toBeDefined();
    expect(bodies[1].response_format).toBeUndefined();

    // capability is remembered: the next call never sends response_format again
    await client.complete({ system: "s", user: "u", jsonMode: true });
    expect(bodies).toHaveLength(3);
    expect(bodies[2].response_format).toBeUndefined();
  });

  it("surfaces a non-recoverable HTTP failure as an LlmError carrying status and body", async () => {
    const client = createLlmClient(
      OPENAI,
      async () => new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500, statusText: "Server Error" }),
    )!;

    await expect(client.complete({ system: "s", user: "u", jsonMode: true })).rejects.toMatchObject({
      name: "LlmError",
      status: 500,
    });
  });

  it("routes anthropic requests to the messages endpoint and reads text content", async () => {
    const calls: string[] = [];
    const client = createLlmClient(
      { provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude", apiKey: "sk" },
      async (url) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ content: [{ type: "text", text: "hello" }] }), { status: 200 });
      },
    )!;

    const result = await client.complete({ system: "s", user: "u", maxTokens: 16 });
    expect(result.text).toBe("hello");
    expect(calls[0]).toBe("https://api.anthropic.com/v1/messages");
  });

  it("returns null for the deterministic provider (no network client)", () => {
    expect(createLlmClient({ provider: "deterministic", model: "deterministic" })).toBeNull();
  });

  it("LlmError is an Error subclass", () => {
    expect(new LlmError("x", { status: 400 })).toBeInstanceOf(Error);
  });
});
