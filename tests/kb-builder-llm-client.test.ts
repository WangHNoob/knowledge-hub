import { describe, expect, it } from "vitest";

import { createLlmClient, LlmError, type JsonSchemaSpec } from "../src/server/services/kbBuilder/llmClient";

const OPENAI = { provider: "openai-compatible", baseUrl: "https://llm.local/v1", model: "m", apiKey: "k" } as const;
const SCHEMA: JsonSchemaSpec = {
  name: "extracted_page",
  schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false },
};

function chatOk(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
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
    expect(bodies[0].response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "extracted_page", strict: true, schema: SCHEMA.schema },
    });
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

    // capability is remembered: the next call goes straight to plain
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

  it("routes anthropic structured output through output_config on the messages endpoint", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const client = createLlmClient(
      { provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude", apiKey: "sk" },
      async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return new Response(JSON.stringify({ content: [{ type: "text", text: '{"title":"X"}' }] }), { status: 200 });
      },
    )!;

    await client.complete({ system: "s", user: "u", maxTokens: 16, jsonSchema: SCHEMA });
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0].body.output_config).toEqual({ format: { type: "json_schema", schema: SCHEMA.schema } });
  });

  it("drops anthropic output_config and retries when the model rejects it", async () => {
    const hasOutputConfig: boolean[] = [];
    const client = createLlmClient(
      { provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude", apiKey: "sk" },
      async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { output_config?: unknown };
        hasOutputConfig.push(body.output_config !== undefined);
        if (body.output_config !== undefined) return reject("output_config is not supported");
        return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 });
      },
    )!;

    const result = await client.complete({ system: "s", user: "u", maxTokens: 16, jsonSchema: SCHEMA });
    expect(result.text).toBe("ok");
    expect(hasOutputConfig).toEqual([true, false]);
  });

  it("returns null for the deterministic provider (no network client)", () => {
    expect(createLlmClient({ provider: "deterministic", model: "deterministic" })).toBeNull();
  });

  it("LlmError is an Error subclass", () => {
    expect(new LlmError("x", { status: 400 })).toBeInstanceOf(Error);
  });
});
