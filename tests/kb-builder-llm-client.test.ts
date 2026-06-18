import { describe, expect, it } from "vitest";

import { createLlmClient, LlmError, type JsonSchemaSpec } from "../src/server/services/kbBuilder/llmClient";

const OPENAI = { provider: "openai-compatible", baseUrl: "https://llm.local/v1", model: "m", apiKey: "k" } as const;
const SCHEMA: JsonSchemaSpec = {
  name: "extracted_page",
  schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false },
};

function chatOk(content: string): Response {
  return new Response(JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200 });
}
function reject(message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), { status: 400, statusText: "Bad Request" });
}

describe("llm client — provider abstraction", () => {
  it("uses native structured output (json_schema, strict) when the gateway supports it", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const client = createLlmClient(OPENAI, async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return chatOk('{"title":"X"}');
    })!;

    const result = await client.complete({ system: "s", user: "u", jsonSchema: SCHEMA });
    expect(result.text).toContain("X");
    expect(bodies).toHaveLength(1);
    expect(JSON.stringify(bodies[0])).toContain("extracted_page");
    expect(JSON.stringify(bodies[0])).toContain("json_schema");
  });

  it("degrades json_schema → json_object → plain on rejection, and remembers the working level", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const client = createLlmClient(OPENAI, async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { response_format?: { type?: string } };
      bodies.push(body);
      if (body.response_format?.type === "json_schema") return reject("json_schema is not supported by this model");
      if (body.response_format?.type === "json_object") return reject("`json_object` is not supported by this model");
      return chatOk('{"title":"X"}');
    })!;

    await client.complete({ system: "s", user: "u", jsonSchema: SCHEMA });
    expect(bodies.map((b) => (b.response_format as { type?: string } | undefined)?.type)).toEqual([
      "json_schema",
      "json_object",
      undefined,
    ]);

    // capability is remembered: the next call goes straight to plain.
    await client.complete({ system: "s", user: "u", jsonSchema: SCHEMA });
    expect(bodies).toHaveLength(4);
    expect(bodies[3].response_format).toBeUndefined();
  });

  it("falls back to json_object when only json_schema is rejected", async () => {
    const types: Array<string | undefined> = [];
    const client = createLlmClient(OPENAI, async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { response_format?: { type?: string } };
      types.push(body.response_format?.type);
      if (body.response_format?.type === "json_schema") return reject("response_format json_schema unsupported");
      return chatOk('{"title":"X"}');
    })!;

    await client.complete({ system: "s", user: "u", jsonSchema: SCHEMA });
    expect(types).toEqual(["json_schema", "json_object"]);
  });

  it("surfaces a non-recoverable HTTP failure as an LlmError carrying status", async () => {
    const client = createLlmClient(
      OPENAI,
      async () => new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500, statusText: "Server Error" }),
    )!;
    await expect(client.complete({ system: "s", user: "u", jsonSchema: SCHEMA })).rejects.toMatchObject({
      name: "LlmError",
      status: 500,
    });
  });

  it("routes anthropic structured output through the SDK provider on the messages endpoint", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const client = createLlmClient(
      { provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-5", apiKey: "sk" },
      async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return anthropicOk('{"title":"X"}');
      },
    )!;

    await client.complete({ system: "s", user: "u", maxTokens: 16, jsonSchema: SCHEMA });
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0].body.output_config).toMatchObject({ format: { type: "json_schema" } });
  });

  it("drops anthropic structured output and retries when the model rejects it", async () => {
    const hasStructuredOutput: boolean[] = [];
    const client = createLlmClient(
      { provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-5", apiKey: "sk" },
      async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { output_config?: unknown };
        hasStructuredOutput.push(body.output_config !== undefined);
        if (body.output_config !== undefined) return reject("structured output is not supported");
        return anthropicOk('{"title":"X"}');
      },
    )!;

    const result = await client.complete({ system: "s", user: "u", maxTokens: 16, jsonSchema: SCHEMA });
    expect(result.text).toContain("X");
    expect(hasStructuredOutput).toEqual([true, false]);
  });

  it("returns null for the deterministic provider (no network client)", () => {
    expect(createLlmClient({ provider: "deterministic", model: "deterministic" })).toBeNull();
  });

  it("LlmError is an Error subclass", () => {
    expect(new LlmError("x", { status: 400 })).toBeInstanceOf(Error);
  });
});

function anthropicOk(content: string): Response {
  return new Response(JSON.stringify({
    id: "msg-test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5",
    content: [{ type: "text", text: content }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200 });
}
