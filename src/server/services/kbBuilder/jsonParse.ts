// 共享：解析 LLM 返回的 JSON 文本。结构化输出一般已是合法 JSON，但降级模式
// （json_object / 纯 prompt）可能包 markdown 代码围栏或夹带前后缀文本，这里逐级
// 兜底解析。供 extractStage 与 findingEnrichment 复用。

export class ModelJsonParseError extends Error {
  readonly detail: string;

  constructor(rel: string, detail: string) {
    super(`Model returned invalid JSON for ${rel}: ${detail}`);
    this.name = "ModelJsonParseError";
    this.detail = detail;
  }
}

export function parseModelJson(content: string, rel: string): unknown {
  const candidates = [
    content,
    stripMarkdownFence(content),
    extractFirstJsonObject(content),
  ].filter((candidate): candidate is string => Boolean(candidate?.trim()));

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new ModelJsonParseError(rel, detail);
}

function stripMarkdownFence(content: string): string {
  const trimmed = content.trim();
  const match = /^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/u.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

function extractFirstJsonObject(content: string): string | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return content.slice(start, end + 1).trim();
}
