import type { AssetComponent, ReviewTask, TrustScore } from "../types";

export interface TrustEvidenceInput {
  sourceVersionId?: string;
  quote?: string;
  confidence?: number | null;
}

export interface ComputeTrustScoreInput {
  component: Pick<AssetComponent, "artifactId" | "kind" | "legacyPath" | "quality" | "sourceRefs">;
  evidenceRows?: TrustEvidenceInput[];
  reviewTasks?: Pick<ReviewTask, "severity" | "status" | "title" | "description">[];
  now: string | Date;
  lastTrustedAuditAt?: string | null;
}

const TRUST_VERSION = "v2-lite" as const;
const TRUST_POLICY = {
  version: TRUST_VERSION,
  editable: false,
  owner: "system",
  position: "可信度是发布知识的消费准入规则，目前随系统版本固定；策划可在立法页审议口径，暂不直接改权重。",
  dimensions: [
    {
      key: "evidence",
      label: "证据可靠性",
      weight: 0.35,
      source: "evidence_records + source_refs",
      formula: "有证据记录 35% + 有 source refs 25% + 引文具体度 25% + 证据置信度 15%",
      intent: "回答必须能追溯到资料版本，不能只靠生成正文。"
    },
    {
      key: "completeness",
      label: "规格全面性",
      weight: 0.25,
      source: "wikiSpecScore / completenessScore / quality score",
      formula: "优先读取构建阶段的 wiki spec 完整度；表、图谱、索引使用保守默认值。",
      intent: "知识是否覆盖该类型 Wiki 应有的章节和事实。"
    },
    {
      key: "auditFreshness",
      label: "飞轮审计时效",
      weight: 0.2,
      source: "lastTrustedAuditAt",
      formula: "通过飞轮审计后按半衰期衰减；未审计默认 45%。",
      intent: "新鲜不是新导入，而是最后一次可信审计越近越可靠。"
    },
    {
      key: "consistency",
      label: "一致性风险",
      weight: 0.2,
      source: "open review_tasks + consistencyScore",
      formula: "无相关未处理任务为 100%；blocking/warning/info 分别扣 45%/18%/8%。",
      intent: "结构、表依赖、图谱关系、source trace 等未解决问题会降低可信度。"
    },
  ],
  statusBands: [
    { status: "trusted", label: "可信", minScore: 0.85, description: "可直接作为 Agent 回答依据。" },
    { status: "usable_with_risk", label: "可用有风险", minScore: 0.7, description: "可消费，但 Agent 应携带风险提示或引用证据。" },
    { status: "needs_review", label: "需复核", minScore: 0.55, description: "适合人工复核后再引用。" },
    { status: "blocked", label: "阻塞", minScore: 0, description: "低于 55% 或存在 blocking 审核任务，不应作为可靠结论。" },
  ],
  caps: [
    { id: "blocking_review", label: "存在阻塞审核任务，最高 50%", maxScore: 0.5, trigger: "有 open blocking review_task" },
    { id: "warning_review", label: "存在 warning 审核任务，最高 85%", maxScore: 0.85, trigger: "有 open warning review_task" },
    { id: "missing_evidence", label: "缺少证据和 source refs，最高 55%", maxScore: 0.55, trigger: "需要证据但 evidence_records/source_refs 均为空" },
    { id: "missing_evidence_records", label: "缺少证据记录，最高 70%", maxScore: 0.7, trigger: "需要证据但没有 evidence_records" },
    { id: "pending_audit", label: "尚未通过飞轮审计，最高 70%", maxScore: 0.7, trigger: "lastTrustedAuditAt 为空" },
    { id: "very_incomplete", label: "规格完整度严重不足，最高 55%", maxScore: 0.55, trigger: "全面性低于 35%" },
    { id: "incomplete_spec", label: "规格完整度不足，最高 65%", maxScore: 0.65, trigger: "全面性低于 50%" },
    { id: "unresolved_consistency", label: "存在未解决一致性风险，最高 65%", maxScore: 0.65, trigger: "一致性低于 60%" },
  ],
  auditHalfLifeDays: [
    { matcher: "/activities/", days: 120, label: "活动玩法" },
    { matcher: "/tables/、/fields/、table kind", days: 90, label: "配置表 / 字段 / 数值" },
    { matcher: "/numeric_rules/", days: 90, label: "数值规则" },
    { matcher: "/systems/、/ui_flows/", days: 180, label: "系统规则 / UI 流程" },
    { matcher: "/concepts/", days: 365, label: "概念说明" },
    { matcher: "graph_snapshot", days: 120, label: "知识图谱" },
    { matcher: "default", days: 180, label: "默认" },
  ],
} as const;

const WEIGHTS = Object.fromEntries(TRUST_POLICY.dimensions.map((dimension) => [dimension.key, dimension.weight])) as Record<keyof TrustScore["breakdown"], number>;

export function getTrustPolicy() {
  return TRUST_POLICY;
}

export function computeTrustScore(input: ComputeTrustScoreInput): TrustScore {
  const now = typeof input.now === "string" ? new Date(input.now) : input.now;
  const quality = objectValue(input.component.quality);
  const evidenceRequired = evidenceRequiredForComponent(input.component);
  const evidenceRows = input.evidenceRows ?? [];
  const openTasks = (input.reviewTasks ?? []).filter((task) => task.status === "open");
  const halfLifeDays = auditHalfLifeDaysForComponent(input.component);
  const lastTrustedAuditAt = input.lastTrustedAuditAt ?? stringValue(trustObject(quality)?.lastTrustedAuditAt) ?? null;

  const evidence = evidenceScore(input.component, evidenceRows, evidenceRequired);
  const completeness = completenessScore(input.component);
  const auditFreshness = auditFreshnessScore(lastTrustedAuditAt, now, halfLifeDays);
  const consistency = consistencyScore(input.component, openTasks);
  const review = reviewState(openTasks);

  const rawScore = round(
    evidence * WEIGHTS.evidence +
    completeness * WEIGHTS.completeness +
    auditFreshness * WEIGHTS.auditFreshness +
    consistency * WEIGHTS.consistency
  );
  const caps = [
    ...review.caps,
    ...evidenceCaps(evidenceRequired, evidenceRows, input.component.sourceRefs),
    ...auditCaps(lastTrustedAuditAt),
    ...completenessCaps(completeness),
    ...consistencyCaps(consistency),
  ];
  const cappedScore = caps.reduce((score, cap) => Math.min(score, cap.maxScore), rawScore);
  const score = round(cappedScore);
  return {
    version: TRUST_VERSION,
    score,
    status: statusForScore(score, caps),
    breakdown: {
      evidence: round(evidence),
      completeness: round(completeness),
      auditFreshness: round(auditFreshness),
      consistency: round(consistency),
    },
    caps,
    reasons: reasonsFor({ evidence, completeness, auditFreshness, consistency, reviewReason: review.reason, evidenceRequired, lastTrustedAuditAt }),
    lastTrustedAuditAt,
    auditHalfLifeDays: halfLifeDays,
    evidenceRequired,
  };
}

export function trustFromQuality(quality: Record<string, unknown>): TrustScore | null {
  const trust = trustObject(quality);
  if (!trust) return null;
  const score = numberValue(trust.score);
  const breakdown = objectValue(trust.breakdown);
  if (score === null) return null;
  return {
    version: "v2-lite",
    score,
    status: statusValue(trust.status),
    breakdown: {
      evidence: numberValue(breakdown.evidence) ?? 0,
      completeness: numberValue(breakdown.completeness) ?? 0,
      auditFreshness: numberValue(breakdown.auditFreshness) ?? 0,
      consistency: numberValue(breakdown.consistency) ?? 0,
    },
    caps: Array.isArray(trust.caps) ? trust.caps.flatMap((value) => {
      const cap = objectValue(value);
      const maxScore = numberValue(cap.maxScore);
      return maxScore === null ? [] : [{
        id: stringValue(cap.id) || "cap",
        label: stringValue(cap.label) || "可信度封顶",
        maxScore,
      }];
    }) : [],
    reasons: Array.isArray(trust.reasons) ? trust.reasons.map(String) : [],
    lastTrustedAuditAt: stringValue(trust.lastTrustedAuditAt) || null,
    auditHalfLifeDays: numberValue(trust.auditHalfLifeDays) ?? 180,
    evidenceRequired: typeof trust.evidenceRequired === "boolean" ? trust.evidenceRequired : true,
  };
}

export function scoreFromQuality(quality: Record<string, unknown>): number | null {
  return trustFromQuality(quality)?.score ?? numberFromQuality(quality, ["confidence", "score", "overallScore"]);
}

function evidenceScore(component: ComputeTrustScoreInput["component"], rows: TrustEvidenceInput[], evidenceRequired: boolean): number {
  if (!evidenceRequired) return 1;
  const hasRows = rows.length > 0 ? 1 : 0;
  const hasSourceRefs = component.sourceRefs.length > 0 ? 1 : 0;
  const avgConfidence = rows.length
    ? rows.reduce((sum, row) => sum + (numberValue(row.confidence) ?? 0), 0) / rows.length
    : 0;
  const specificity = rows.length
    ? rows.some((row) => quoteSpecificity(String(row.quote ?? "")) >= 0.85) ? 1 : 0.6
    : 0;
  return clamp01(0.35 * hasRows + 0.25 * hasSourceRefs + 0.25 * specificity + 0.15 * avgConfidence);
}

function completenessScore(component: ComputeTrustScoreInput["component"]): number {
  const quality = objectValue(component.quality);
  const score = numberFromQuality(quality, ["completenessScore", "wikiSpecScore", "confidence", "score", "overallScore"]);
  if (score !== null) return clamp01(score);
  if (component.kind === "table_schema_json" || component.kind === "table_registry") return 0.75;
  if (component.kind === "graph_snapshot") return 0.75;
  if (component.kind === "topic_index") return 0.6;
  return 0.55;
}

function auditFreshnessScore(lastTrustedAuditAt: string | null, now: Date, halfLifeDays: number): number {
  if (!lastTrustedAuditAt) return 0.45;
  const auditedAt = new Date(lastTrustedAuditAt);
  if (Number.isNaN(auditedAt.getTime())) return 0.45;
  const ageDays = Math.max(0, (now.getTime() - auditedAt.getTime()) / 86_400_000);
  return clamp01(Math.exp(-Math.log(2) * ageDays / halfLifeDays));
}

function consistencyScore(component: ComputeTrustScoreInput["component"], openTasks: Pick<ReviewTask, "severity" | "title" | "description">[]): number {
  const explicit = numberFromQuality(objectValue(component.quality), ["consistencyScore"]);
  if (explicit !== null) return clamp01(explicit);
  const relevant = openTasks.filter(isConsistencyTask);
  if (relevant.length === 0) return 1;
  const penalty = relevant.reduce((sum, task) => sum + (task.severity === "blocking" ? 0.45 : task.severity === "warning" ? 0.18 : 0.08), 0);
  return clamp01(1 - penalty);
}

function reviewState(openTasks: Pick<ReviewTask, "severity" | "title">[]): { reason: string; caps: TrustScore["caps"] } {
  if (openTasks.some((task) => task.severity === "blocking")) {
    return { reason: "存在阻塞审核任务", caps: [{ id: "blocking_review", label: "存在阻塞审核任务，最高 50%", maxScore: 0.5 }] };
  }
  const warningCount = openTasks.filter((task) => task.severity === "warning").length;
  if (warningCount > 0) {
    return { reason: `存在 ${warningCount} 个 warning 审核任务`, caps: [{ id: "warning_review", label: "存在 warning 审核任务，最高 85%", maxScore: 0.85 }] };
  }
  const infoCount = openTasks.filter((task) => task.severity === "info").length;
  if (infoCount > 0) return { reason: `存在 ${infoCount} 个 info 审核任务`, caps: [] };
  return { reason: "无待处理审核任务", caps: [] };
}

function evidenceCaps(evidenceRequired: boolean, rows: TrustEvidenceInput[], sourceRefs: string[]): TrustScore["caps"] {
  if (!evidenceRequired) return [];
  if (rows.length === 0 && sourceRefs.length === 0) return [{ id: "missing_evidence", label: "缺少证据和 source refs，最高 55%", maxScore: 0.55 }];
  if (rows.length === 0) return [{ id: "missing_evidence_records", label: "缺少证据记录，最高 70%", maxScore: 0.7 }];
  return [];
}

function auditCaps(lastTrustedAuditAt: string | null): TrustScore["caps"] {
  return lastTrustedAuditAt ? [] : [{ id: "pending_audit", label: "尚未通过飞轮审计，最高 70%", maxScore: 0.7 }];
}

function completenessCaps(score: number): TrustScore["caps"] {
  if (score < 0.35) return [{ id: "very_incomplete", label: "规格完整度严重不足，最高 55%", maxScore: 0.55 }];
  if (score < 0.5) return [{ id: "incomplete_spec", label: "规格完整度不足，最高 65%", maxScore: 0.65 }];
  return [];
}

function consistencyCaps(score: number): TrustScore["caps"] {
  return score < 0.6 ? [{ id: "unresolved_consistency", label: "存在未解决一致性风险，最高 65%", maxScore: 0.65 }] : [];
}

function reasonsFor(input: {
  evidence: number;
  completeness: number;
  auditFreshness: number;
  consistency: number;
  reviewReason: string;
  evidenceRequired: boolean;
  lastTrustedAuditAt: string | null;
}): string[] {
  const reasons = [
    `${input.evidenceRequired ? "证据可靠性" : "证据非强制"} ${percent(input.evidence)}`,
    `规格全面性 ${percent(input.completeness)}`,
    input.lastTrustedAuditAt ? `审计时效性 ${percent(input.auditFreshness)}` : "尚未通过飞轮审计确认",
    `一致性 ${percent(input.consistency)}`,
    input.reviewReason,
  ];
  return reasons;
}

function evidenceRequiredForComponent(component: ComputeTrustScoreInput["component"]): boolean {
  if (component.kind === "table_wiki_page") return true;
  if (component.kind !== "wiki_page") return false;
  const path = `${component.artifactId}/${component.legacyPath}`.replace(/\\/g, "/");
  return !path.includes("/concepts/");
}

function auditHalfLifeDaysForComponent(component: ComputeTrustScoreInput["component"]): number {
  const path = `${component.artifactId}/${component.legacyPath}`.replace(/\\/g, "/");
  if (path.includes("/activities/")) return 120;
  if (path.includes("/tables/") || path.includes("/fields/") || component.kind.includes("table")) return 90;
  if (path.includes("/numeric_rules/")) return 90;
  if (path.includes("/systems/")) return 180;
  if (path.includes("/ui_flows/")) return 180;
  if (path.includes("/concepts/")) return 365;
  if (component.kind === "graph_snapshot") return 120;
  return 180;
}

function isConsistencyTask(task: Pick<ReviewTask, "title" | "description">): boolean {
  const text = `${task.title} ${task.description}`.toLowerCase();
  return /graph|relation|candidate|table|schema|source trace|frontmatter|alias|关系|图谱|候选|配置表|字段|别名|source/u.test(text);
}

function quoteSpecificity(quote: string): number {
  const text = quote.trim();
  if (!text) return 0;
  if (/^(Generated|Published) from source reference:/u.test(text)) return 0.6;
  return text.length >= 12 ? 1 : 0.7;
}

function statusForScore(score: number, caps: TrustScore["caps"]): TrustScore["status"] {
  if (caps.some((cap) => cap.id === "blocking_review") || score < 0.55) return "blocked";
  if (score < 0.7) return "needs_review";
  if (score < 0.85 || caps.length > 0) return "usable_with_risk";
  return "trusted";
}

function trustObject(quality: Record<string, unknown>): Record<string, unknown> | null {
  const trust = quality.trust;
  return trust && typeof trust === "object" && !Array.isArray(trust) ? trust as Record<string, unknown> : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberFromQuality(quality: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = numberValue(quality[key]);
    if (value !== null) return value;
  }
  return null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function statusValue(value: unknown): TrustScore["status"] {
  return value === "trusted" || value === "usable_with_risk" || value === "needs_review" || value === "blocked" ? value : "needs_review";
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
