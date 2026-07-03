import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";

import { z } from "zod";

import { config } from "../../config";
import { createLlmClient, type JsonSchemaSpec, type LlmClient } from "../kbBuilder/llmClient";
import { parseModelJson } from "../kbBuilder/jsonParse";
import { extractMaxTokens, type PipelineModelConfig } from "../kbBuilder/modelConfig";
import type { ReleaseAuditSummary } from "../releaseAudit";
import type { ConformanceReport, OkfIssue } from "./types";
import type { OkfSearchIndex } from "./searchIndex";

export type KnowledgeLintDomain = "links" | "evidence" | "graph" | "trust" | "table_dependencies" | "mcp_feedback";
export type KnowledgeLintSeverity = "blocking" | "warning" | "info";

export interface KnowledgeLintIssue {
  id: string;
  domain: KnowledgeLintDomain;
  severity: KnowledgeLintSeverity;
  title: string;
  message: string;
  okfPath?: string;
  componentId?: string;
  suggestedAction: string;
  governance?: KnowledgeLintGovernance;
}

export interface KnowledgeLintGovernance {
  source: "llm" | "rule_fallback";
  confidence: number;
  actionType: "auto_remediation" | "rebuild" | "manual_review" | "monitor";
  autoEligible: boolean;
  diagnosis: string;
  risk: string;
  remediation: string;
  rationale: string;
}

export interface KnowledgeLintReport {
  version: 1;
  generatedAt: string;
  releaseId: string;
  summary: {
    score: number;
    blocking: number;
    warning: number;
    info: number;
  };
  domains: Record<KnowledgeLintDomain, {
    blocking: number;
    warning: number;
    info: number;
    total: number;
  }>;
  governance: {
    source: "llm" | "rule_fallback";
    analyzed: number;
    autoEligible: number;
    manualReview: number;
    rebuild: number;
    monitor: number;
    warnings: string[];
  };
  issues: KnowledgeLintIssue[];
}

export interface KnowledgeLintExport {
  report: KnowledgeLintReport;
  jsonUri: string;
  markdownUri: string;
}

const MAX_LLM_GOVERNED_ISSUES = 12;

const GovernanceSchema = z.object({
  issues: z.array(z.object({
    id: z.string(),
    confidence: z.number(),
    actionType: z.enum(["auto_remediation", "rebuild", "manual_review", "monitor"]),
    autoEligible: z.boolean(),
    diagnosis: z.string(),
    risk: z.string(),
    remediation: z.string(),
    rationale: z.string(),
  })),
});

const GOVERNANCE_JSON_SCHEMA: JsonSchemaSpec = {
  name: "knowledge_lint_governance",
  schema: z.toJSONSchema(GovernanceSchema) as Record<string, unknown>,
};

interface GraphAsset {
  nodes?: Array<{ id?: string; label?: string; wiki_page?: string }>;
  edges?: Array<{ source?: string; target?: string; relation?: string }>;
}

interface TableSchemaManifest {
  tables?: Array<{ schema?: { table_name?: string } }>;
}

export async function exportKnowledgeLintReport(input: {
  releaseId: string;
  generatedAt: string;
  bundleDir: string;
  releaseDir: string;
  conformance: ConformanceReport;
  audit: ReleaseAuditSummary;
}): Promise<KnowledgeLintExport> {
  const report = await governKnowledgeLintReport(buildKnowledgeLintReport(input));
  const jsonUri = posix.join("releases", input.releaseId, "knowledge_lint.json");
  const markdownUri = posix.join("releases", input.releaseId, "knowledge_lint.md");
  writeFileSync(join(input.releaseDir, "knowledge_lint.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(join(input.releaseDir, "knowledge_lint.md"), renderKnowledgeLintMarkdown(report), "utf8");
  return { report, jsonUri, markdownUri };
}

export function buildKnowledgeLintReport(input: {
  releaseId: string;
  generatedAt: string;
  bundleDir: string;
  conformance: ConformanceReport;
  audit: ReleaseAuditSummary;
}): KnowledgeLintReport {
  const issues = attachComponentRefs([
    ...issuesFromConformance(input.conformance),
    ...issuesFromEvidence(input.audit),
    ...issuesFromGraph(input.bundleDir),
    ...issuesFromTrust(input.audit),
    ...issuesFromTableDependencies(input.bundleDir),
    ...issuesFromMcpFeedback(input.audit),
  ], input.bundleDir).map((issue) => ({ ...issue, governance: fallbackGovernance(issue) }));
  const summary = severitySummary(issues);
  return {
    version: 1,
    generatedAt: input.generatedAt,
    releaseId: input.releaseId,
    summary: {
      ...summary,
      score: lintScore(summary),
    },
    domains: domainSummaries(issues),
    governance: governanceSummary(issues, "rule_fallback", []),
    issues,
  };
}

export function renderKnowledgeLintMarkdown(report: KnowledgeLintReport): string {
  const lines = [
    "# Knowledge Lint Report",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- releaseId: ${report.releaseId}`,
    `- score: ${report.summary.score}`,
    `- blocking: ${report.summary.blocking}`,
    `- warning: ${report.summary.warning}`,
    `- info: ${report.summary.info}`,
    "",
    "## Domains",
    "",
    ...Object.entries(report.domains).map(([domain, summary]) => `- ${domain}: ${summary.total} total, ${summary.blocking} blocking, ${summary.warning} warning, ${summary.info} info`),
    "",
  ];

  for (const domain of Object.keys(report.domains) as KnowledgeLintDomain[]) {
    const domainIssues = report.issues.filter((issue) => issue.domain === domain);
    if (domainIssues.length === 0) continue;
    lines.push(`## ${domain}`, "");
    for (const issue of domainIssues) {
      const location = [issue.okfPath, issue.componentId].filter(Boolean).join(" / ");
      lines.push(`- [${issue.severity}] ${issue.title}${location ? ` (${location})` : ""}`);
      lines.push(`  - ${issue.message}`);
      lines.push(`  - action: ${issue.suggestedAction}`);
      if (issue.governance) {
        lines.push(`  - governance: ${issue.governance.actionType}, confidence ${issue.governance.confidence}, autoEligible ${issue.governance.autoEligible}`);
        lines.push(`  - diagnosis: ${issue.governance.diagnosis}`);
        lines.push(`  - remediation: ${issue.governance.remediation}`);
      }
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function issuesFromConformance(report: ConformanceReport): KnowledgeLintIssue[] {
  return report.issues.flatMap((issue, index) => {
    const domain = conformanceDomain(issue);
    if (!domain) return [];
    return [{
      id: `okf_${issue.issueType}_${index}`,
      domain,
      severity: issue.blocking ? "blocking" : "warning",
      title: conformanceTitle(issue),
      message: issue.message,
      okfPath: issue.okfPath,
      suggestedAction: conformanceAction(issue),
    }];
  });
}

function issuesFromEvidence(audit: ReleaseAuditSummary): KnowledgeLintIssue[] {
  if (audit.evidence.missingComponents <= 0) return [];
  return [{
    id: "evidence_missing_components",
    domain: "evidence",
    severity: audit.evidence.coveredComponents === 0 ? "blocking" : "warning",
    title: "发布组件缺少证据记录",
    message: `${audit.evidence.missingComponents}/${audit.evidence.requiredComponents} 个需要证据的组件没有 evidence_records 或 OKF Citations。`,
    suggestedAction: "补充 evidence_records 或重新构建生成 Citations，然后重新发布。",
  }];
}

function issuesFromGraph(bundleDir: string): KnowledgeLintIssue[] {
  const graphPath = join(bundleDir, "graph", "graph.json");
  if (!existsSync(graphPath)) {
    return [{
      id: "graph_missing_asset",
      domain: "graph",
      severity: "warning",
      title: "发布缺少知识图谱",
      message: "OKF bundle 中没有 graph/graph.json，Agent 只能使用页面和表检索，无法做关系遍历。",
      suggestedAction: "重新运行 graph 阶段并发布包含 graph_snapshot 的资产包。",
    }];
  }
  const graph = readJson<GraphAsset>(graphPath);
  if (!graph) {
    return [{
      id: "graph_unreadable",
      domain: "graph",
      severity: "blocking",
      title: "知识图谱无法解析",
      message: "graph/graph.json 不是合法 JSON。",
      suggestedAction: "修复 graph 阶段产物后重新发布。",
    }];
  }

  const issues: KnowledgeLintIssue[] = [];
  const nodeIds = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const node of graph.nodes ?? []) {
    const id = String(node.id ?? "").trim();
    if (!id) continue;
    if (nodeIds.has(id)) duplicateIds.add(id);
    nodeIds.add(id);
  }
  if ((graph.nodes ?? []).length === 0) {
    issues.push({
      id: "graph_empty_nodes",
      domain: "graph",
      severity: "warning",
      title: "知识图谱没有节点",
      message: "graph/graph.json 存在，但 nodes 为空。",
      suggestedAction: "检查 graph 阶段是否收集到了 wiki/table/entity 组件。",
    });
  }
  for (const id of [...duplicateIds].slice(0, 20)) {
    issues.push({
      id: `graph_duplicate_node_${slug(id)}`,
      domain: "graph",
      severity: "warning",
      title: "知识图谱节点 ID 重复",
      message: `节点 ${id} 出现多次，可能导致 Agent 关系遍历不稳定。`,
      suggestedAction: "在 graph 阶段统一节点 canonical id，重新构建。",
    });
  }

  const schemaNames = tableSchemaNames(bundleDir);
  for (const [index, edge] of (graph.edges ?? []).entries()) {
    const source = String(edge.source ?? "").trim();
    const target = String(edge.target ?? "").trim();
    if (!source || !target) continue;
    const targetTable = target.replace(/^table:/u, "");
    const targetExists = edge.relation === "configured_in" && schemaNames.has(targetTable);
    if (!nodeIds.has(source) || (!nodeIds.has(target) && !targetExists)) {
      issues.push({
        id: `graph_dangling_edge_${index}`,
        domain: "graph",
        severity: "warning",
        title: "知识图谱存在悬空边",
        message: `${source} -> ${target} (${edge.relation ?? "relation"}) 无法完整解析到节点或表 schema。`,
        suggestedAction: "修正 graph 节点/边生成逻辑，或补齐对应 wiki/table 资产。",
      });
    }
  }
  return issues;
}

function issuesFromTrust(audit: ReleaseAuditSummary): KnowledgeLintIssue[] {
  return audit.trust.lowTrustComponents
    .filter((component) => component.status === "blocked" || component.status === "needs_review" || (component.score ?? 1) < 0.75)
    .slice(0, 12)
    .map((component) => ({
      id: `trust_low_${slug(component.componentId)}`,
      domain: "trust" as const,
      severity: component.status === "blocked" || (component.score ?? 1) < 0.55 ? "blocking" as const : "warning" as const,
      title: "低可信知识组件",
      message: `${component.title} 的可信度为 ${component.score ?? "unknown"}，状态 ${component.status}。${component.reasons.slice(0, 2).join("；")}`,
      componentId: component.componentId,
      suggestedAction: "打开资产组件查看 Trust Score 明细，补证据、完整度、审计确认或一致性问题后重新发布。",
    }));
}

function issuesFromTableDependencies(bundleDir: string): KnowledgeLintIssue[] {
  const index = readJson<OkfSearchIndex>(join(bundleDir, "search", "index.json"));
  if (!index?.pages) return [];
  const issues: KnowledgeLintIssue[] = [];
  const schemas = tableSchemaNames(bundleDir);
  for (const page of index.pages) {
    const dependencyText = page.fields?.dataDependencies?.trim() ?? "";
    const resolvedTables = page.fields?.tables ?? [];
    if (dependencyText && resolvedTables.length === 0) {
      issues.push({
        id: `table_dep_unresolved_${slug(page.componentId)}`,
        domain: "table_dependencies",
        severity: schemas.size === 0 ? "warning" : "blocking",
        title: "Data Dependencies 未解析到结构化表",
        message: `${page.title} 写了 Data Dependencies，但没有解析到 tables/schemas.json 中的 canonical table。`,
        okfPath: page.okfPath,
        componentId: page.componentId,
        suggestedAction: "把正文依赖改为 canonical 英文表名，或在人工维护翻译表中补 alias 后重新构建发布。",
      });
    }
    if (/未解析|unknown|todo|待确认/iu.test(dependencyText)) {
      issues.push({
        id: `table_dep_pending_${slug(page.componentId)}`,
        domain: "table_dependencies",
        severity: "warning",
        title: "Data Dependencies 含待确认内容",
        message: `${page.title} 的依赖段落包含未解析/待确认表述。`,
        okfPath: page.okfPath,
        componentId: page.componentId,
        suggestedAction: "在审核中心确认依赖关系，正文和结构化 graph/table schema 对齐后重新发布。",
      });
    }
  }
  return issues;
}

function issuesFromMcpFeedback(audit: ReleaseAuditSummary): KnowledgeLintIssue[] {
  const issues: KnowledgeLintIssue[] = [];
  if (audit.agentFeedback.mcpMisses > 0) {
    issues.push({
      id: "mcp_unresolved_queries",
      domain: "mcp_feedback",
      severity: audit.agentFeedback.mcpMisses >= 3 ? "blocking" : "warning",
      title: "MCP 存在未解析查询",
      message: `审计窗口内有 ${audit.agentFeedback.mcpMisses} 次 MCP miss。高频查询：${audit.agentFeedback.topQueries.map((query) => `${query.query}(${query.count})`).join(", ") || "无"}`,
      suggestedAction: "把高频 miss 转成知识缺口任务，补 topic/page/table/graph 后重新发布并复测。",
    });
  }
  if (audit.agentFeedback.mcpErrors > 0) {
    issues.push({
      id: "mcp_tool_errors",
      domain: "mcp_feedback",
      severity: "warning",
      title: "MCP 工具调用存在错误",
      message: `审计窗口内有 ${audit.agentFeedback.mcpErrors} 次 MCP error。`,
      suggestedAction: "查看 Diagnostics 的 mcp 日志，修复工具参数、发布包文件或服务异常。",
    });
  }
  for (const [type, count] of Object.entries(audit.agentFeedback.feedbackByType)) {
    if (count <= 0 || type === "hit") continue;
    issues.push({
      id: `mcp_feedback_${slug(type)}`,
      domain: "mcp_feedback",
      severity: type === "repeated_query" ? "blocking" : "warning",
      title: `Agent 反馈：${type}`,
      message: `审计窗口内出现 ${count} 条 ${type} 反馈。`,
      suggestedAction: "进入 Agent 反馈页查看对应任务，把有效反馈修正到资料或知识资产后重新发布。",
    });
  }
  return issues;
}

function attachComponentRefs(issues: KnowledgeLintIssue[], bundleDir: string): KnowledgeLintIssue[] {
  const byPath = componentIdsByOkfPath(bundleDir);
  if (byPath.size === 0) return issues;
  return issues.map((issue) => {
    if (issue.componentId || !issue.okfPath) return issue;
    const componentId = byPath.get(normalizeOkfPath(issue.okfPath));
    return componentId ? { ...issue, componentId } : issue;
  });
}

function componentIdsByOkfPath(bundleDir: string): Map<string, string> {
  const index = readJson<OkfSearchIndex>(join(bundleDir, "search", "index.json"));
  const out = new Map<string, string>();
  for (const page of index?.pages ?? []) {
    if (page.okfPath && page.componentId) out.set(normalizeOkfPath(page.okfPath), page.componentId);
  }
  return out;
}

function normalizeOkfPath(value: string): string {
  const normalized = value.trim().replace(/\\/gu, "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function conformanceDomain(issue: OkfIssue): KnowledgeLintDomain | null {
  if (issue.issueType === "broken_link" || issue.issueType === "obsidian_link") return "links";
  if (issue.issueType === "missing_citation") return "evidence";
  if (issue.issueType === "missing_frontmatter" || issue.issueType === "missing_type" || issue.issueType === "unparseable_yaml") return "links";
  return null;
}

function conformanceTitle(issue: OkfIssue): string {
  if (issue.issueType === "missing_citation") return "OKF 页面缺少 Citations";
  if (issue.issueType === "broken_link") return "OKF 页面存在断链";
  if (issue.issueType === "obsidian_link") return "OKF 页面仍有非标准 Obsidian 链接";
  return "OKF 结构不完整";
}

function conformanceAction(issue: OkfIssue): string {
  if (issue.issueType === "missing_citation") return "补充 evidence_records/source refs 后重新发布。";
  if (issue.issueType === "broken_link" || issue.issueType === "obsidian_link") return "把正文链接改为 OKF bundle 内的标准 markdown 绝对链接。";
  return "修复 frontmatter/schema 后重新发布。";
}

function severitySummary(issues: KnowledgeLintIssue[]): { blocking: number; warning: number; info: number } {
  return {
    blocking: issues.filter((issue) => issue.severity === "blocking").length,
    warning: issues.filter((issue) => issue.severity === "warning").length,
    info: issues.filter((issue) => issue.severity === "info").length,
  };
}

function domainSummaries(issues: KnowledgeLintIssue[]): KnowledgeLintReport["domains"] {
  const out = Object.fromEntries((["links", "evidence", "graph", "trust", "table_dependencies", "mcp_feedback"] as KnowledgeLintDomain[])
    .map((domain) => [domain, { blocking: 0, warning: 0, info: 0, total: 0 }])) as KnowledgeLintReport["domains"];
  for (const issue of issues) {
    out[issue.domain][issue.severity] += 1;
    out[issue.domain].total += 1;
  }
  return out;
}

function lintScore(summary: { blocking: number; warning: number; info: number }): number {
  return Math.max(0, Math.round((1 - Math.min(1, summary.blocking * 0.2 + summary.warning * 0.035 + summary.info * 0.01)) * 100) / 100);
}

async function governKnowledgeLintReport(report: KnowledgeLintReport): Promise<KnowledgeLintReport> {
  const warnings: string[] = [];
  const fallbackIssues = report.issues.map((issue) => ({ ...issue, governance: fallbackGovernance(issue) }));
  const client = createKnowledgeLintLlmClient(warnings);
  if (!client || fallbackIssues.length === 0) {
    return {
      ...report,
      governance: governanceSummary(fallbackIssues, "rule_fallback", warnings),
      issues: fallbackIssues,
    };
  }

  try {
    const governed = await governIssuesWithLlm(client, fallbackIssues, warnings);
    return {
      ...report,
      governance: governanceSummary(governed, "llm", warnings),
      issues: governed,
    };
  } catch (error) {
    warnings.push(`knowledge lint LLM governance failed: ${error instanceof Error ? error.message : String(error)}`);
    return {
      ...report,
      governance: governanceSummary(fallbackIssues, "rule_fallback", warnings),
      issues: fallbackIssues,
    };
  }
}

async function governIssuesWithLlm(
  client: LlmClient,
  issues: KnowledgeLintIssue[],
  warnings: string[],
): Promise<KnowledgeLintIssue[]> {
  const targetIssues = issues
    .slice()
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
    .slice(0, MAX_LLM_GOVERNED_ISSUES);
  const targetIds = new Set(targetIssues.map((issue) => issue.id));
  if (issues.length > MAX_LLM_GOVERNED_ISSUES) {
    warnings.push(`knowledge lint LLM governance capped at ${MAX_LLM_GOVERNED_ISSUES}; ${issues.length - MAX_LLM_GOVERNED_ISSUES} issues used rule fallback`);
  }

  const completion = await client.complete({
    system: [
      "你是知识库治理助手。你不会直接修改发布包，只给出治理决策。",
      "只允许把低风险、可由已有确定性回写/重建链路处理的问题标记为 auto_remediation。",
      "证据缺失、可信度下降、删除知识、MCP 高频 miss 通常需要人工确认或重建，不要强行自动修。",
      "输出 JSON，必须覆盖输入中的每个 issue id。"
    ].join("\n"),
    user: JSON.stringify({
      releaseId: "knowledge_lint",
      issues: targetIssues.map((issue) => ({
        id: issue.id,
        domain: issue.domain,
        severity: issue.severity,
        title: issue.title,
        message: issue.message,
        okfPath: issue.okfPath ?? "",
        componentId: issue.componentId ?? "",
        suggestedAction: issue.suggestedAction,
      })),
    }, null, 2),
    maxTokens: extractMaxTokens(),
    jsonSchema: GOVERNANCE_JSON_SCHEMA,
    jsonMode: true,
  });
  const parsed = GovernanceSchema.parse(parseModelJson(completion.text, "knowledge_lint_governance"));
  const governanceById = new Map(parsed.issues.map((item) => [item.id, item] as const));
  return issues.map((issue) => {
    if (!targetIds.has(issue.id)) return issue;
    const governance = governanceById.get(issue.id);
    if (!governance) {
      warnings.push(`knowledge lint LLM governance missed issue ${issue.id}; used rule fallback`);
      return issue;
    }
    return {
      ...issue,
      governance: {
        source: "llm",
        confidence: clamp(governance.confidence),
        actionType: governance.actionType,
        autoEligible: Boolean(governance.autoEligible && governance.actionType === "auto_remediation" && governance.confidence >= 0.85),
        diagnosis: governance.diagnosis.trim(),
        risk: governance.risk.trim(),
        remediation: governance.remediation.trim(),
        rationale: governance.rationale.trim(),
      },
    };
  });
}

function fallbackGovernance(issue: KnowledgeLintIssue): KnowledgeLintGovernance {
  const actionType = fallbackActionType(issue);
  return {
    source: "rule_fallback",
    confidence: 0.6,
    actionType,
    autoEligible: false,
    diagnosis: issue.message,
    risk: fallbackRisk(issue),
    remediation: issue.suggestedAction,
    rationale: "未启用或未成功调用 LLM，使用确定性 Knowledge Lint 规则给出治理建议。",
  };
}

function fallbackActionType(issue: KnowledgeLintIssue): KnowledgeLintGovernance["actionType"] {
  if (issue.domain === "links" && issue.severity !== "blocking") return "auto_remediation";
  if (issue.domain === "table_dependencies" && issue.componentId) return "auto_remediation";
  if (issue.domain === "graph" || issue.domain === "evidence" || issue.domain === "trust") return "rebuild";
  if (issue.domain === "mcp_feedback") return "manual_review";
  return issue.severity === "info" ? "monitor" : "manual_review";
}

function fallbackRisk(issue: KnowledgeLintIssue): string {
  if (issue.severity === "blocking") return "会阻断或显著降低 Agent 对当前发布知识的可靠消费。";
  if (issue.severity === "warning") return "不会立即阻断发布，但会降低检索、引用或关系消费质量。";
  return "作为观察项记录，不需要立即处理。";
}

function governanceSummary(
  issues: KnowledgeLintIssue[],
  source: KnowledgeLintReport["governance"]["source"],
  warnings: string[],
): KnowledgeLintReport["governance"] {
  return {
    source,
    analyzed: issues.filter((issue) => issue.governance).length,
    autoEligible: issues.filter((issue) => issue.governance?.autoEligible).length,
    manualReview: issues.filter((issue) => issue.governance?.actionType === "manual_review").length,
    rebuild: issues.filter((issue) => issue.governance?.actionType === "rebuild").length,
    monitor: issues.filter((issue) => issue.governance?.actionType === "monitor").length,
    warnings,
  };
}

function createKnowledgeLintLlmClient(warnings: string[]): LlmClient | null {
  const modelConfig = resolveKnowledgeLintModelConfig();
  if (modelConfig.provider === "deterministic") {
    warnings.push("knowledge lint LLM governance disabled: no LLM config or API key");
    return null;
  }
  try {
    return createLlmClient(modelConfig);
  } catch (error) {
    warnings.push(`knowledge lint LLM governance disabled: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function resolveKnowledgeLintModelConfig(): PipelineModelConfig {
  const provider = process.env.KH_KNOWLEDGE_LINT_LLM_PROVIDER || config.autoRemediationLlmProvider;
  if (provider === "anthropic") {
    const apiKey = process.env.KH_KNOWLEDGE_LINT_LLM_API_KEY || process.env.ANTHROPIC_API_KEY || config.autoRemediationLlmApiKey;
    if (!apiKey) return { provider: "deterministic", model: "deterministic" };
    return {
      provider: "anthropic",
      baseUrl: process.env.KH_KNOWLEDGE_LINT_LLM_BASE_URL || config.autoRemediationLlmBaseUrl || "https://api.anthropic.com/v1",
      model: process.env.KH_KNOWLEDGE_LINT_LLM_MODEL || config.autoRemediationLlmModel || "claude-sonnet-4-5",
      apiKey,
    };
  }
  const apiKey = process.env.KH_KNOWLEDGE_LINT_LLM_API_KEY || process.env.OPENAI_API_KEY || config.autoRemediationLlmApiKey;
  if (!apiKey) return { provider: "deterministic", model: "deterministic" };
  return {
    provider: "openai-compatible",
    baseUrl: process.env.KH_KNOWLEDGE_LINT_LLM_BASE_URL || process.env.OPENAI_BASE_URL || config.autoRemediationLlmBaseUrl || "https://api.openai.com/v1",
    model: process.env.KH_KNOWLEDGE_LINT_LLM_MODEL || process.env.OPENAI_MODEL || config.autoRemediationLlmModel || "gpt-4.1-mini",
    apiKey,
  };
}

function severityRank(severity: KnowledgeLintSeverity): number {
  return severity === "blocking" ? 0 : severity === "warning" ? 1 : 2;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function tableSchemaNames(bundleDir: string): Set<string> {
  const manifest = readJson<TableSchemaManifest>(join(bundleDir, "tables", "schemas.json"));
  return new Set((manifest?.tables ?? []).map((entry) => entry.schema?.table_name ?? "").filter(Boolean));
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "") || "item";
}
