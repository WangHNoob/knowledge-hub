// Finding enrichment：构建落库前，用 LLM 把一条「质量门禁发现」翻译成
//  (a) 管理员看得懂的人话标题/解释，和
//  (b) 几个**结构化**修复方案（每个带 AnnotationOverride patch），
// 让审核者选一个就能经现有 override 链路确定性自动修复。
//
// 设计约束：
//  - 永不阻断构建。无 LLM（deterministic）/ 调用失败 / JSON 非法时，
//    退回与历史一致的单候选「按建议修复」（方向性提示，非结构化）。
//  - 每次构建最多 enrich MAX_ENRICHED 条（按 severity 排序优先 blocking），
//    其余退回兜底单候选，控制 LLM 成本。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import type { PipelineModelConfig } from "./modelConfig";
import { extractMaxTokens } from "./modelConfig";
import { createLlmClient } from "./llmClient";
import type { JsonSchemaSpec, LlmClient } from "./llmClient";
import { ModelJsonParseError, parseModelJson } from "./jsonParse";
import type { QualityFinding } from "../../types";

/** 每次构建最多 enrich 多少条 finding（其余退回单候选兜底）。 */
export const MAX_ENRICHED = 20;

/** 审核任务的一个候选（前端渲染 + annotate 时落库）。 */
export interface ReviewTaskCandidate {
  id: string;
  label: string;
  value: Record<string, unknown>;
  confidence: number;
  rationale: string;
}

/** 一条 finding 经 enrichment 后用于落库的字段。 */
export interface EnrichedFinding {
  /** 人话标题；无 LLM 时退回原 finding.title。 */
  humanTitle: string;
  /** 人话解释（问题是什么、为什么、影响）；无 LLM 时退回原 description。 */
  humanExplain: string;
  candidates: ReviewTaskCandidate[];
  /** 是否真正由 LLM 生成（落进 context_snapshot 便于追溯/统计）。 */
  enriched: boolean;
}

interface EnrichInput {
  finding: QualityFinding;
  /** finding 对应组件的 wiki 正文（截断后喂给 LLM）；可空。 */
  componentMarkdown: string;
  /** 该组件的源逻辑路径（override 需要 sourcePath 才能确定性匹配）。 */
  sourcePath: string;
  pageType: string;
}

interface FindingSourceContext {
  sourcePath: string;
  wikiRel: string;
  pageType: string;
  componentMarkdown?: string;
}

const OverrideSchema = z.object({
  setType: z.string().trim().min(1).optional(),
  setTitle: z.string().trim().min(1).optional(),
  setFacts: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
  removeFacts: z.array(z.string()).optional(),
  replaceSection: z.object({ heading: z.string(), markdown: z.string() }).optional(),
  replaceBody: z.string().optional(),
});

const CandidateSchema = z.object({
  label: z.string(),
  rationale: z.string(),
  confidence: z.number(),
  override: OverrideSchema,
});

const EnrichmentSchema = z.object({
  humanTitle: z.string(),
  humanExplain: z.string(),
  candidates: z.array(CandidateSchema),
});

const ENRICHMENT_JSON_SCHEMA: JsonSchemaSpec = {
  name: "finding_enrichment",
  schema: tightenSchema(z.toJSONSchema(EnrichmentSchema)) as Record<string, unknown>,
};

/**
 * 对一批 findings 做 enrichment。返回与 `findings` 等长、同序的结果数组：
 * 已 enrich 的带人话 + 结构化候选，未 enrich / 失败的带兜底单候选。
 */
export async function enrichFindings(
  findings: QualityFinding[],
  options: {
    dataDir: string;
    modelConfig: PipelineModelConfig;
    /** finding.componentId → 该组件源逻辑路径 / wiki 相对路径，用于读正文与生成 override.sourcePath。 */
    resolveSource: (finding: QualityFinding) => { sourcePath: string; wikiRel: string; pageType: string };
    warnings: string[];
  },
): Promise<EnrichedFinding[]> {
  const client = options.modelConfig.provider === "deterministic" ? null : safeClient(options.modelConfig, options.warnings);

  // 按 severity 排优先级，前 MAX_ENRICHED 条走 LLM，其余兜底。保持原序返回。
  const order = findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => severityRank(a.finding.severity) - severityRank(b.finding.severity));
  const enrichSet = new Set(order.slice(0, MAX_ENRICHED).map((item) => item.index));
  if (client && findings.length > MAX_ENRICHED) {
    options.warnings.push(`finding enrichment capped at ${MAX_ENRICHED}; ${findings.length - MAX_ENRICHED} findings fell back to single suggestion`);
  }

  const results: EnrichedFinding[] = [];
  for (let index = 0; index < findings.length; index += 1) {
    const finding = findings[index];
    const source = options.resolveSource(finding);
    const markdown = readComponentMarkdown(options.dataDir, source.wikiRel);
    if (!client || !enrichSet.has(index)) {
      results.push(fallbackEnrichment(finding, { ...source, componentMarkdown: markdown }));
      continue;
    }
    const enriched = await enrichOne(client, { finding, componentMarkdown: markdown, sourcePath: source.sourcePath, pageType: source.pageType }, options.warnings);
    results.push(enriched ?? fallbackEnrichment(finding, { ...source, componentMarkdown: markdown }));
  }
  return results;
}

async function enrichOne(client: LlmClient, input: EnrichInput, warnings: string[]): Promise<EnrichedFinding | null> {
  try {
    const completion = await client.complete({
      system: ENRICH_SYSTEM,
      user: enrichUserPrompt(input),
      maxTokens: extractMaxTokens(),
      jsonSchema: ENRICHMENT_JSON_SCHEMA,
      jsonMode: true,
    });
    const parsed = EnrichmentSchema.safeParse(parseModelJson(completion.text, `enrich:${input.finding.ruleId}`));
    if (!parsed.success) {
      warnings.push(`finding enrichment ${input.finding.ruleId}: model JSON failed validation; used single-suggestion fallback`);
      return null;
    }
    const candidates = parsed.data.candidates
      .map((candidate, candidateIndex) => toCandidate(candidate, input, candidateIndex))
      .filter((candidate): candidate is ReviewTaskCandidate => candidate !== null);
    if (candidates.length === 0) {
      warnings.push(`finding enrichment ${input.finding.ruleId}: no candidate carried a usable override; used single-suggestion fallback`);
      return null;
    }
    return {
      humanTitle: parsed.data.humanTitle.trim() || input.finding.title,
      humanExplain: parsed.data.humanExplain.trim() || input.finding.description,
      candidates,
      enriched: true,
    };
  } catch (error) {
    if (error instanceof ModelJsonParseError) {
      warnings.push(`finding enrichment ${input.finding.ruleId}: invalid model JSON (${error.detail}); used single-suggestion fallback`);
      return null;
    }
    // 传输/HTTP 等错误同样不阻断构建。
    warnings.push(`finding enrichment ${input.finding.ruleId}: ${error instanceof Error ? error.message : String(error)}; used single-suggestion fallback`);
    return null;
  }
}

function toCandidate(
  candidate: z.infer<typeof CandidateSchema>,
  input: EnrichInput,
  index: number,
): ReviewTaskCandidate | null {
  const override = normalizeOverride(candidate.override, input);
  if (!override) return null;
  return {
    id: `fix_${index}`,
    label: candidate.label.trim() || `修复方案 ${index + 1}`,
    value: { override, ruleId: input.finding.ruleId, componentRef: input.finding.componentId ?? "" },
    confidence: clamp(candidate.confidence),
    rationale: candidate.rationale.trim(),
  };
}

// 把 LLM 的 override（facts 用 key/value 数组以满足严格结构化输出）转成
// extractStage `OverridePatchSchema` 吃的形状（setFacts 为 map），并补 sourcePath。
function normalizeOverride(raw: z.infer<typeof OverrideSchema>, input: EnrichInput): Record<string, unknown> | null {
  const override: Record<string, unknown> = {
    sourcePath: input.sourcePath,
    ruleId: input.finding.ruleId,
    pageType: input.pageType,
  };
  let hasAction = false;
  if (raw.setType) { override.setType = raw.setType; hasAction = true; }
  if (raw.setTitle) { override.setTitle = raw.setTitle; hasAction = true; }
  if (raw.setFacts?.length) {
    const facts: Record<string, string> = {};
    for (const { key, value } of raw.setFacts) {
      const trimmed = key.trim();
      if (trimmed) facts[trimmed] = value;
    }
    if (Object.keys(facts).length > 0) { override.setFacts = facts; hasAction = true; }
  }
  if (raw.removeFacts?.length) {
    const removed = [...new Set(raw.removeFacts.map((item) => item.trim()).filter(Boolean))];
    if (removed.length > 0) { override.removeFacts = removed; hasAction = true; }
  }
  if (raw.replaceSection?.heading) { override.replaceSection = raw.replaceSection; hasAction = true; }
  if (raw.replaceBody !== undefined) { override.replaceBody = raw.replaceBody; hasAction = true; }
  if (!input.sourcePath || !hasAction) return null;
  return override;
}

/** 兜底：不依赖 LLM，也要把常见门禁转成可理解、可执行的维修方案。 */
export function fallbackEnrichment(finding: QualityFinding, source?: FindingSourceContext): EnrichedFinding {
  const structured = structuredFallback(finding, source);
  if (structured) return structured;
  return {
    humanTitle: finding.title,
    humanExplain: finding.description,
    candidates: [{
      id: "manual_follow_suggestion",
      label: "人工按原建议处理",
      value: { ruleId: finding.ruleId, action: finding.suggestedAction, componentRef: finding.componentId ?? "" },
      confidence: clamp(1 - finding.scoreImpact),
      rationale: `系统无法生成确定性补丁，需要人工按建议处理：${finding.suggestedAction}`,
    }],
    enriched: false,
  };
}

function structuredFallback(finding: QualityFinding, source?: FindingSourceContext): EnrichedFinding | null {
  if (finding.ruleId === "wikiSpecCompleteness") return wikiSpecFallback(finding, source);
  if (finding.ruleId === "requiredFacts") return requiredFactsFallback(finding, source);
  return null;
}

function wikiSpecFallback(finding: QualityFinding, source?: FindingSourceContext): EnrichedFinding {
  const missingSections = parseListAfter(finding.description, "missing sections");
  const page = source?.wikiRel || finding.componentId || "该页面";
  const candidates: ReviewTaskCandidate[] = [];
  const sourcePath = source?.sourcePath ?? "";
  const body = stripFrontmatter(source?.componentMarkdown ?? "");
  if (sourcePath && missingSections.length > 0) {
    candidates.push({
      id: "append_missing_spec_sections",
      label: `补齐缺失章节：${missingSections.join("、")}`,
      value: {
        ruleId: finding.ruleId,
        componentRef: finding.componentId ?? "",
        override: {
          sourcePath,
          ruleId: finding.ruleId,
          pageType: source?.pageType ?? "",
          replaceBody: appendMissingSections(body, missingSections),
        },
      },
      confidence: 0.82,
      rationale: "按 wiki spec 补上缺失章节，并填入待确认占位，先让页面结构满足规范；后续可继续补真实内容。",
    });
  }
  candidates.push(ruleDismissalCandidate(finding, "该页面不适用此 spec", "如果这个页面确实不需要这些章节，可将此规则对该组件永久豁免，后续构建不再报同类任务。"));
  return {
    humanTitle: `页面结构不完整：${page}`,
    humanExplain: missingSections.length
      ? `该 wiki 页面缺少 spec 要求的章节：${missingSections.join("、")}。通常是抽取时资料不足、页面类型判断偏差，或模板新增后旧页面没有同步。未处理会让 Agent 读到的页面结构不稳定，也会持续产生质量门禁任务。`
      : `该 wiki 页面没有达到 spec 完整度要求。通常是章节为空、页面类型判断偏差，或模板新增后旧页面没有同步。`,
    candidates,
    enriched: false,
  };
}

function requiredFactsFallback(finding: QualityFinding, source?: FindingSourceContext): EnrichedFinding {
  const missingFacts = parseListAfter(finding.description, "Missing facts");
  const page = source?.wikiRel || finding.componentId || "该页面";
  const candidates: ReviewTaskCandidate[] = [];
  const sourcePath = source?.sourcePath ?? "";
  if (sourcePath && missingFacts.length > 0) {
    candidates.push({
      id: "fill_missing_facts_todo",
      label: `补齐字段占位：${missingFacts.join("、")}`,
      value: {
        ruleId: finding.ruleId,
        componentRef: finding.componentId ?? "",
        override: {
          sourcePath,
          ruleId: finding.ruleId,
          pageType: source?.pageType ?? "",
          setFacts: Object.fromEntries(missingFacts.map((fact) => [fact, "待确认"])),
        },
      },
      confidence: 0.76,
      rationale: "先补上缺失 facts 的待确认值，使结构化字段完整；真实值需要后续根据原始资料校准。",
    });
  }
  candidates.push(ruleDismissalCandidate(finding, "这些字段对此页面不适用", "如果这些 required facts 对当前组件并不成立，可豁免该规则，避免后续重复报警。"));
  return {
    humanTitle: `结构化字段缺失：${page}`,
    humanExplain: missingFacts.length
      ? `该页面缺少 spec 要求的 facts 字段：${missingFacts.join("、")}。这通常来自抽取未识别、模板要求过严，或资料本身没有给出字段值。未处理会影响后续表依赖、图谱关系和 Agent 的结构化消费。`
      : `该页面缺少 spec 要求的 facts 字段。可能是抽取未识别、模板要求过严，或资料本身没有给出字段值。`,
    candidates,
    enriched: false,
  };
}

function ruleDismissalCandidate(finding: QualityFinding, label: string, rationale: string): ReviewTaskCandidate {
  return {
    id: "dismiss_rule_for_component",
    label,
    value: { ruleId: finding.ruleId, action: "dismiss_rule", componentRef: finding.componentId ?? "" },
    confidence: 0.5,
    rationale,
  };
}

function parseListAfter(text: string, label: string): string[] {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*:\\s*([^.;。]+)`, "iu").exec(text);
  if (!match) return [];
  return match[1]
    .split(/[,，、]/u)
    .map((item) => item.trim())
    .filter((item) => item && item.toLowerCase() !== "none");
}

function stripFrontmatter(markdown: string): string {
  const trimmed = markdown.trim();
  if (!trimmed.startsWith("---")) return markdown.trimEnd();
  return trimmed.replace(/^---\s*[\s\S]*?\s*---\s*/u, "").trimEnd();
}

function appendMissingSections(markdown: string, sections: string[]): string {
  const base = markdown.trimEnd();
  const existing = new Set([...base.matchAll(/^##\s+(.+)$/gmu)].map((match) => match[1].trim().toLowerCase()));
  const additions = sections
    .filter((section) => !existing.has(section.toLowerCase()))
    .map((section) => `## ${section}\n待确认：该章节由审核中心按 spec 自动补齐，请后续根据原始资料完善。`);
  if (additions.length === 0) return base || sections.map((section) => `## ${section}\n待确认：请根据原始资料完善。`).join("\n\n");
  return `${base ? `${base}\n\n` : ""}${additions.join("\n\n")}\n`;
}

const ENRICH_SYSTEM = [
  "你是知识库治理助手。给定一条质量门禁发现和对应 wiki 页面，",
  "产出：humanTitle（一句中文人话标题，说清哪里有问题），",
  "humanExplain（2-4 句解释：问题是什么、为什么算问题、不修会有什么影响），",
  "以及 2-4 个 candidates 修复方案。每个方案的 override 必须是可机器执行的结构化补丁，",
  "字段从 setType/setTitle/setFacts/removeFacts/replaceSection/replaceBody 中选用，只填真正需要改的。",
  "setFacts 用 [{key,value}] 数组。方案要覆盖不同假设（如：补正确值 / 判定为误报删除依赖 / 改用规范名）。",
  "confidence 为 0~1 的把握度。不要编造来源中不存在的事实。",
].join("\n");

function enrichUserPrompt(input: EnrichInput): string {
  return [
    `规则: ${input.finding.ruleId}（严重度 ${input.finding.severity}）`,
    `原始标题: ${input.finding.title}`,
    `原始描述: ${input.finding.description}`,
    `原始建议: ${input.finding.suggestedAction}`,
    `页面类型: ${input.pageType || "(未知)"}`,
    `源路径: ${input.sourcePath || "(未知)"}`,
    "",
    "wiki 正文（截断）:",
    input.componentMarkdown || "(无正文)",
  ].join("\n");
}

function readComponentMarkdown(dataDir: string, wikiRel: string): string {
  if (!wikiRel) return "";
  const abs = join(dataDir, wikiRel);
  if (!existsSync(abs)) return "";
  const text = readFileSync(abs, "utf8");
  return text.length > 6000 ? `${text.slice(0, 6000)}\n…(截断)` : text;
}

function safeClient(modelConfig: PipelineModelConfig, warnings: string[]): LlmClient | null {
  try {
    return createLlmClient(modelConfig);
  } catch (error) {
    warnings.push(`finding enrichment disabled: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function severityRank(severity: QualityFinding["severity"]): number {
  return severity === "blocking" ? 0 : severity === "warning" ? 1 : 2;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

// JSON Schema 收紧成两家 provider 严格模式都接受的子集（闭对象 + 全 required）。
// 与 extractStage 的同名私有 helper 等价，这里本地复制以免扩大导出面。
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
