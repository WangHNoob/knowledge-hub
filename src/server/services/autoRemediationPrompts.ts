import { z } from "zod";

import type { AssetComponent, EvidenceRecord, ReviewTask } from "../types";
import type { JsonSchemaSpec } from "./kbBuilder/llmClient";

/**
 * Structured output schema for LLM auto-remediation analysis.
 *
 * `correctValue` and `suggestions[i].value` are emitted as JSON strings so the
 * schema stays closed (strict-mode providers reject open-ended objects). We
 * parse them in the service layer.
 */
export const AutoRemediationOutputSchema = z.object({
  diagnosis: z.string(),
  fixType: z.enum(["annotation_override", "document_rewrite", "needs_human", "no_fix"]),
  confidence: z.number().min(0).max(1),
  correctValueJson: z.string(),
  rationale: z.string(),
  suggestions: z.array(
    z.object({
      label: z.string(),
      valueJson: z.string(),
      rationale: z.string()
    })
  )
});

export type AutoRemediationOutput = z.infer<typeof AutoRemediationOutputSchema>;

export interface ParsedRemediation {
  diagnosis: string;
  fixType: AutoRemediationOutput["fixType"];
  confidence: number;
  correctValue: Record<string, unknown>;
  rationale: string;
  suggestions: Array<{ label: string; value: unknown; rationale: string }>;
}

export const AUTO_REMEDIATION_JSON_SCHEMA: JsonSchemaSpec = {
  name: "auto_remediation_analysis",
  schema: tightenSchema(z.toJSONSchema(AutoRemediationOutputSchema)) as Record<string, unknown>
};

export interface RemediationPromptContext {
  feedbackType: string;
  agentQuery: string;
  suggestedAction: string;
  component: Pick<AssetComponent, "componentId" | "kind" | "group" | "title" | "legacyPath" | "quality"> & {
    body: string;
  };
  evidence: EvidenceRecord[];
  task: Pick<ReviewTask, "taskId" | "title" | "description" | "suggestedAction" | "ruleId" | "candidates">;
}

const KIND_GUIDANCE: Record<string, string> = {
  wiki_page:
    "correctValue expected shape: { markdown: string, facts?: Record<string,string>, title?: string }. `markdown` should be the full corrected wiki page body.",
  table_wiki_page:
    "correctValue expected shape: { markdown: string, facts?: Record<string,string>, rows?: Array<Record<string,unknown>> }.",
  table:
    "correctValue expected shape: { rows: Array<Record<string,unknown>>, columns?: Array<{ id: string, label: string }> }.",
  entity:
    "correctValue expected shape: { name: string, type: string, description?: string, properties?: Record<string,unknown> }.",
  graph_snapshot:
    "correctValue expected shape: { nodes: Array<{id,label,type}>, edges: Array<{source,target,relation}> }.",
  topic_index:
    "correctValue expected shape: { markdown: string } — full corrected index markdown."
};

export function buildSystemPrompt(componentKind: string): string {
  const guidance = KIND_GUIDANCE[componentKind] ?? KIND_GUIDANCE.wiki_page;
  return [
    "You are the Auto-Remediation analyst for a Knowledge Hub knowledge asset governance system.",
    "An external Agent consumed a knowledge component and produced feedback indicating a defect.",
    "Your job: diagnose the defect and, if you can fix it confidently, generate the corrected value.",
    "",
    "Output contract (STRICT):",
    '  - diagnosis (string): one-paragraph root-cause explanation in the same language as the agent query when possible.',
    '  - fixType (enum):',
    '      * "annotation_override" — you can produce the corrected value directly.',
    '      * "document_rewrite" — wiki/table_wiki/topic_index 整页改写：correctValueJson = { "markdown": "<full page markdown>" }。',
    '         只能重写该组件正文；必须保留证据可溯源的数值/ID，新增引用必须引用给定 evidence id；无把握时用 needs_human。',
    '      * "needs_human" — a human curator must decide; suggestions may be provided.',
    '      * "no_fix" — the feedback is invalid / already correct / not actionable.',
    '  - confidence (number 0..1): how sure you are the correctValue is right. Be conservative.',
    '      * Use >= 0.85 ONLY when the fix is unambiguous and directly grounded in evidence.',
    '      * document_rewrite 需要 >= 0.90（整页重写风险更高）。',
    '  - correctValueJson (string): a JSON-encoded object with the fixed value. MUST be valid JSON.',
    '      * When fixType is "needs_human" or "no_fix", output "{}".',
    "  - rationale (string): brief reason connecting evidence to the fix.",
    "  - suggestions (array): 0-3 alternative candidates for human review when fixType != annotation_override.",
    '      * each entry: { label, valueJson (JSON string), rationale }',
    "",
    `Component kind: ${componentKind}`,
    `Component guidance: ${guidance}`,
    "",
    "Constraints:",
    "- NEVER invent facts not supported by the provided evidence or component body.",
    "- If the feedback is ambiguous or you lack evidence, prefer fixType=needs_human with suggestions.",
    "- Keep correctValue MINIMAL — only fields you actually want to override.",
    "- correctValueJson MUST be plain JSON (no markdown fences)."
  ].join("\n");
}

export function buildUserPrompt(ctx: RemediationPromptContext): string {
  const evidenceLines = ctx.evidence.slice(0, 8).map((e, i) =>
    `  [${i + 1}] source=${e.sourceVersionId} confidence=${e.confidence}\n      quote: ${truncate(e.quote, 400)}${e.note ? `\n      note: ${truncate(e.note, 200)}` : ""}`
  );
  const candidateLines = ctx.task.candidates.slice(0, 5).map((c, i) =>
    `  (${i + 1}) ${c.label} — value=${truncate(JSON.stringify(c.value), 200)}`
  );
  return [
    `# Agent feedback`,
    `feedbackType: ${ctx.feedbackType}`,
    `agentQuery: ${truncate(ctx.agentQuery, 600)}`,
    ctx.suggestedAction ? `suggestedAction: ${truncate(ctx.suggestedAction, 400)}` : "",
    "",
    `# Review task`,
    `taskId: ${ctx.task.taskId}`,
    `title: ${ctx.task.title}`,
    `ruleId: ${ctx.task.ruleId}`,
    `description: ${truncate(ctx.task.description, 600)}`,
    ctx.task.suggestedAction ? `suggestedAction: ${truncate(ctx.task.suggestedAction, 400)}` : "",
    candidateLines.length > 0 ? `existing candidates:\n${candidateLines.join("\n")}` : "existing candidates: (none)",
    "",
    `# Component snapshot`,
    `componentId: ${ctx.component.componentId}`,
    `kind: ${ctx.component.kind}`,
    `group: ${ctx.component.group}`,
    `title: ${ctx.component.title}`,
    `legacyPath: ${ctx.component.legacyPath}`,
    `quality: ${truncate(JSON.stringify(ctx.component.quality ?? {}), 400)}`,
    "",
    `# Component body (truncated)`,
    truncate(ctx.component.body ?? "", 4000),
    "",
    `# Evidence records`,
    evidenceLines.length > 0 ? evidenceLines.join("\n") : "  (no evidence records)",
    "",
    "Produce your structured JSON now."
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** Parse the raw LLM output text into ParsedRemediation, or throw. */
export function parseRemediationOutput(raw: string): ParsedRemediation {
  const stripped = stripCodeFences(raw);
  const parsed = AutoRemediationOutputSchema.parse(JSON.parse(stripped));
  const correctValue = parseJsonObject(parsed.correctValueJson);
  const suggestions = parsed.suggestions.map((s) => ({
    label: s.label,
    value: safeParseJson(s.valueJson),
    rationale: s.rationale
  }));
  return {
    diagnosis: parsed.diagnosis,
    fixType: parsed.fixType,
    confidence: parsed.confidence,
    correctValue,
    rationale: parsed.rationale,
    suggestions
  };
}

function parseJsonObject(text: string): Record<string, unknown> {
  const value = safeParseJson(text);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function safeParseJson(text: string): unknown {
  if (!text || typeof text !== "string") return {};
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return {};
  }
}

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("```")) {
    return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  }
  return trimmed;
}

function truncate(text: string, max: number): string {
  if (!text) return "";
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function tightenSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(tightenSchema);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "$schema") continue;
      out[key] = tightenSchema(value);
    }
    if (out.type === "object" && out.properties && typeof out.properties === "object") {
      out.additionalProperties = false;
      out.required = Object.keys(out.properties as Record<string, unknown>);
    }
    return out;
  }
  return node;
}
