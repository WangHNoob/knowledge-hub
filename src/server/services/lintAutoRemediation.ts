import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { config } from "../config";
import { resolveAutoRemediationModelConfig } from "./autoRemediationService";
import type { DiagnosticLogger } from "./diagnosticService";
import { emitKnowledgeEvent, onKnowledgeEvent } from "./eventService";
import type { FlywheelService } from "./flywheelService";
import { createLlmClient, LlmError, type JsonSchemaSpec, type LlmClient } from "./kbBuilder/llmClient";
import { extractMaxTokens, modelName, type PipelineModelConfig } from "./kbBuilder/modelConfig";
import { readLintReport } from "./lintRemediationService";
import type { KnowledgeLintIssue } from "./okf/lintService";
import type { TableAliasService } from "./tableAliasService";
import type { DatabaseHandle } from "../types";

/**
 * 阶段7：Knowledge Lint 别名自动修复。
 *
 * 「Data Dependencies 未解析到结构化表」和图谱里 `configured_in` 悬空边，本质都是
 * 正文/关系里写的（多为中文）表名解析不到 canonical table。单纯重建（用同样的源再跑一遍）
 * 修不好——所以这两类问题过去只能进例外中心等人工补别名。
 *
 * 本执行器复用 lint 已产出的诊断，调用 LLM 把未解析的表名映射到一个 **真实存在的** canonical
 * 表名（封闭动作集：add_alias 或放弃），写入持久化的 table_aliases（翻译表），再触发一次全量
 * 重建 + 自动发布。别名是确定性、可逆的配置（翻译表可编辑、发布可回滚），extract 阶段每次构建
 * 都会重新套用，所以修复是持久的。
 *
 * 安全与收敛：
 * - canonical 必须命中现有 canonical 表名集合，否则拒绝（不凭空造表名）。
 * - 只有当本轮确实新增了别名（幂等去重）才触发重建，避免「重建→lint→再重建」空转死循环。
 * - 无 LLM（deterministic）或无 lint 报告时安全跳过。
 * - 无法映射的（非表类悬空边、真缺资产）不处理，仍由既有链路留给人工。
 */
export interface LintAutoRemediationDeps {
  db: DatabaseHandle;
  tableAliases: Pick<TableAliasService, "list" | "upsertMany">;
  flywheel: Pick<FlywheelService, "sync">;
  dataDir: string;
  diagnostics?: DiagnosticLogger;
  llmClientFactory?: (config: PipelineModelConfig) => LlmClient | null;
  resolveModelConfig?: (db: DatabaseHandle) => Promise<PipelineModelConfig>;
}

export interface AppliedAlias {
  term: string;
  canonical: string;
  confidence: number;
}

export interface LintAliasRemediationResult {
  status: "applied" | "no_action" | "skipped" | "failed";
  appliedAliases: AppliedAlias[];
  syncId?: string;
  reason?: string;
}

interface UnresolvedTerm {
  issueId: string;
  kind: "table_dependency" | "graph_dangling_edge";
  term: string;
  context: string;
}

const ALIAS_MAPPING_SCHEMA: JsonSchemaSpec = {
  name: "lint_alias_mapping",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      mappings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            term: { type: "string" },
            canonical: { type: "string" },
            confidence: { type: "number" },
          },
          required: ["term", "canonical", "confidence"],
        },
      },
      skipped: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            term: { type: "string" },
            reason: { type: "string" },
          },
          required: ["term", "reason"],
        },
      },
    },
    required: ["mappings"],
  },
};

export function createLintAutoRemediationService(deps: LintAutoRemediationDeps): LintAutoRemediationService {
  return new LintAutoRemediationService(deps);
}

/**
 * 监听 `knowledge_lint.remediations_recorded`（每次发布记录治理队列后广播），对该发布的
 * lint 报告尝试别名自动修复。只做编排触发，不绕过既有确定性服务；返回 unsubscribe。
 */
export function registerLintAutoRemediation(deps: LintAutoRemediationDeps): () => void {
  const service = createLintAutoRemediationService(deps);
  return onKnowledgeEvent("knowledge_lint.remediations_recorded", (event) => {
    void (async () => {
      const projectId = stringValue(event.payload.projectId) || "default_project";
      const releaseId = stringValue(event.payload.releaseId) || event.entityId;
      if (!releaseId) return;
      const result = await service.remediate({ projectId, releaseId });
      await deps.diagnostics?.write({
        traceId: "",
        level: result.status === "failed" ? "warn" : "info",
        category: "flywheel",
        message: `lint alias auto-remediation: ${result.status}`,
        status: result.status === "failed" ? "failed" : "completed",
        actor: "system:lint-alias",
        entityType: "release",
        entityId: releaseId,
        context: {
          projectId,
          releaseId,
          status: result.status,
          reason: result.reason,
          appliedAliases: result.appliedAliases,
          syncId: result.syncId,
        },
      });
    })().catch((error) => {
      void deps.diagnostics?.write({
        traceId: "",
        level: "error",
        category: "flywheel",
        message: "lint alias auto-remediation failed",
        status: "failed",
        entityType: event.entityType,
        entityId: event.entityId,
        error,
        context: { eventId: event.eventId, payload: event.payload },
      });
    });
  });
}

export class LintAutoRemediationService {
  constructor(private readonly deps: LintAutoRemediationDeps) {}

  async remediate(input: { projectId: string; releaseId: string }): Promise<LintAliasRemediationResult> {
    if (!config.autoAliasRemediationEnabled) return { status: "skipped", appliedAliases: [], reason: "disabled" };

    const report = readLintReport(this.deps.dataDir, input.releaseId);
    if (!report) return { status: "skipped", appliedAliases: [], reason: "no_lint_report" };

    const terms = this.collectUnresolvedTerms(input.releaseId, report.issues);
    if (terms.length === 0) return { status: "no_action", appliedAliases: [], reason: "no_alias_eligible_issues" };

    // canonical 校验集合：翻译表已知 canonical ∪ 发布包 schemas.json 里的表名。
    const aliasEntries = await this.deps.tableAliases.list();
    const canonicalSet = new Set<string>(aliasEntries.map((entry) => entry.canonical));
    for (const name of this.readSchemaTableNames(input.releaseId)) canonicalSet.add(name);
    if (canonicalSet.size === 0) return { status: "skipped", appliedAliases: [], reason: "no_canonical_tables" };

    // 已解析（已是 canonical 或已有别名）的术语直接排除，避免重复。
    const resolved = new Map<string, string>();
    for (const entry of aliasEntries) {
      resolved.set(normKey(entry.canonical), entry.canonical);
      for (const alias of entry.aliases) resolved.set(normKey(alias), entry.canonical);
    }
    for (const name of canonicalSet) resolved.set(normKey(name), name);
    const openTerms = dedupeTerms(terms.filter((item) => !resolved.has(normKey(item.term))));
    if (openTerms.length === 0) return { status: "no_action", appliedAliases: [], reason: "all_terms_already_resolved" };

    const modelConfig = await (this.deps.resolveModelConfig ?? resolveAutoRemediationModelConfig)(this.deps.db);
    if (modelConfig.provider === "deterministic") {
      return { status: "skipped", appliedAliases: [], reason: "no_llm_model" };
    }
    const client = (this.deps.llmClientFactory ?? createLlmClient)(modelConfig);
    if (!client) return { status: "skipped", appliedAliases: [], reason: "no_llm_client" };

    let mappings: Array<{ term: string; canonical: string; confidence: number }>;
    try {
      mappings = await this.mapTermsToCanonical(client, openTerms, [...canonicalSet]);
    } catch (error) {
      return {
        status: "failed",
        appliedAliases: [],
        reason: error instanceof LlmError ? `llm_error: ${error.message}` : `llm_error: ${String(error)}`,
      };
    }

    // 校验 + 幂等：只保留能命中真实 canonical、且置信达标、且确实是新增的映射。
    const threshold = config.autoRemediationConfidenceThreshold;
    const canonicalByKey = new Map<string, string>();
    for (const name of canonicalSet) canonicalByKey.set(normKey(name), name);
    const additions = new Map<string, Set<string>>(); // canonical -> new alias terms
    const applied: AppliedAlias[] = [];
    for (const mapping of mappings) {
      const term = mapping.term.trim();
      if (!term) continue;
      const canonical = canonicalByKey.get(normKey(mapping.canonical));
      if (!canonical) continue; // 拒绝：不是真实表名
      if (mapping.confidence < threshold) continue;
      if (resolved.has(normKey(term))) continue; // 已解析，跳过
      if (!additions.has(canonical)) additions.set(canonical, new Set());
      additions.get(canonical)!.add(term);
      resolved.set(normKey(term), canonical);
      applied.push({ term, canonical, confidence: mapping.confidence });
    }
    if (applied.length === 0) return { status: "no_action", appliedAliases: [], reason: "no_confident_mapping" };

    // 合并写入现有别名（不覆盖）。
    const existingAliases = new Map(aliasEntries.map((entry) => [entry.canonical, entry.aliases]));
    const upserts = [...additions.entries()].map(([canonical, terms]) => ({
      canonical,
      aliases: [...new Set([...(existingAliases.get(canonical) ?? []), ...terms])],
    }));
    await this.deps.tableAliases.upsertMany(upserts, "system:lint-alias", "llm");

    // 别名改了但源文件没变，必须全量重建才能让 extract 重新套用别名。
    const sync = await this.deps.flywheel.sync({ projectId: input.projectId, requestedBy: "system:lint-alias", mode: "full" });

    await emitKnowledgeEvent(this.deps.db, {
      eventType: "knowledge_lint.alias_remediated",
      entityType: "release",
      entityId: input.releaseId,
      payload: {
        projectId: input.projectId,
        releaseId: input.releaseId,
        appliedAliases: applied,
        syncId: sync.syncId,
        syncStatus: sync.status,
        model: modelName(modelConfig),
      },
    });

    return { status: "applied", appliedAliases: applied, syncId: sync.syncId };
  }

  /** 从 lint 报告 + 发布包提取可用别名修复的未解析表名。 */
  private collectUnresolvedTerms(releaseId: string, issues: KnowledgeLintIssue[]): UnresolvedTerm[] {
    const out: UnresolvedTerm[] = [];
    const dependenciesByComponent = this.readDataDependencies(releaseId);
    for (const issue of issues) {
      if (issue.domain === "table_dependencies" && issue.id.startsWith("table_dep_unresolved_") && issue.componentId) {
        const dependencyText = dependenciesByComponent.get(issue.componentId) ?? "";
        for (const token of tokenizeDependencies(dependencyText)) {
          out.push({ issueId: issue.id, kind: "table_dependency", term: token, context: `Data Dependencies: ${dependencyText}` });
        }
      } else if (issue.domain === "graph" && issue.id.startsWith("graph_dangling_edge_")) {
        const parsed = parseDanglingEdge(issue.message);
        // 只处理 configured_in（目标应为表）的悬空边；节点↔节点悬空不是表名问题，交给人工。
        if (parsed && parsed.relation === "configured_in" && parsed.target) {
          out.push({
            issueId: issue.id,
            kind: "graph_dangling_edge",
            term: parsed.target,
            context: `图谱悬空边：${parsed.source} -> ${parsed.target} (configured_in)`,
          });
        }
      }
    }
    return out;
  }

  private async mapTermsToCanonical(
    client: LlmClient,
    terms: UnresolvedTerm[],
    canonicalNames: string[],
  ): Promise<Array<{ term: string; canonical: string; confidence: number }>> {
    const system =
      "你是游戏知识库的表名解析助手。给定若干「未解析的表名/术语」和一份「规范表名清单」，" +
      "判断每个术语应当映射到清单里的哪个规范表名（canonical）。" +
      "canonical 必须原样来自清单，绝不能自造或改写；拿不准就不要输出该项（放进 skipped）。" +
      "confidence 为 0-1 的置信度。只输出 JSON。";
    const user = [
      "规范表名清单（canonical，只能从中选）：",
      canonicalNames.map((name) => `- ${name}`).join("\n"),
      "",
      "未解析术语：",
      terms.map((item, index) => `${index + 1}. term="${item.term}" | ${item.context}`).join("\n"),
    ].join("\n");
    const result = await client.complete({
      system,
      user,
      maxTokens: extractMaxTokens(),
      jsonSchema: ALIAS_MAPPING_SCHEMA,
    });
    const parsed = JSON.parse(result.text) as { mappings?: unknown };
    if (!Array.isArray(parsed.mappings)) return [];
    return parsed.mappings
      .map((raw) => {
        const record = raw as Record<string, unknown>;
        const term = typeof record.term === "string" ? record.term : "";
        const canonical = typeof record.canonical === "string" ? record.canonical : "";
        const confidence = typeof record.confidence === "number" ? record.confidence : 0;
        return term && canonical ? { term, canonical, confidence } : null;
      })
      .filter((item): item is { term: string; canonical: string; confidence: number } => item !== null);
  }

  private readDataDependencies(releaseId: string): Map<string, string> {
    const out = new Map<string, string>();
    const index = this.readReleaseJson<{ pages?: Array<{ componentId?: string; fields?: { dataDependencies?: string } }> }>(
      releaseId,
      ["search", "index.json"],
    );
    for (const page of index?.pages ?? []) {
      if (page?.componentId && typeof page.fields?.dataDependencies === "string") {
        out.set(page.componentId, page.fields.dataDependencies);
      }
    }
    return out;
  }

  private readSchemaTableNames(releaseId: string): string[] {
    const manifest = this.readReleaseJson<{ tables?: Array<{ schema?: { table_name?: string } }> }>(releaseId, ["tables", "schemas.json"]);
    return (manifest?.tables ?? []).map((entry) => entry.schema?.table_name ?? "").filter(Boolean);
  }

  private readReleaseJson<T>(releaseId: string, segments: string[]): T | null {
    const path = join(this.deps.dataDir, "releases", releaseId, ...segments);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch {
      return null;
    }
  }
}

function tokenizeDependencies(text: string): string[] {
  return [...new Set(text.split(/[,\n，、;；/|]+/u).map((token) => token.trim()).filter((token) => token.length > 0 && token.length <= 60))];
}

function parseDanglingEdge(message: string): { source: string; target: string; relation: string } | null {
  const match = /^(.*?)\s*->\s*(.*?)\s*\((.*?)\)/u.exec(message);
  if (!match) return null;
  return { source: match[1].trim(), target: match[2].trim().replace(/^table:/u, ""), relation: match[3].trim() };
}

function dedupeTerms(terms: UnresolvedTerm[]): UnresolvedTerm[] {
  const seen = new Set<string>();
  const out: UnresolvedTerm[] = [];
  for (const item of terms) {
    const key = normKey(item.term);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** 与 kbBuilder/tableAliases.ts 的 aliasKey 保持一致的归一化，确保「已解析」判定口径相同。 */
function normKey(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/[\s_\-]+/gu, "");
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
