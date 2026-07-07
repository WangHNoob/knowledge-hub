import type { DatabaseHandle, KnowledgeGovernanceProfile, KnowledgeGovernanceProfileInput } from "../types";

/**
 * 环境变量提供的治理默认值。项目未设置覆盖时全部沿用这些默认。
 * 由 app.ts 从 config 注入，服务本身不直接读 config，保持可测试与可覆盖。
 */
export interface GovernanceDefaults {
  minAutoPublishScore: number;
  requireEvidence: boolean;
  lintAutoGovernanceEnabled: boolean;
  lintAutoEligibleThreshold: number;
  autoPublishRevisions: boolean;
  blockOnDeletes: boolean;
  blockOnTrustDecline: boolean;
  blockOnPendingCorrections: boolean;
  autoClusterEnabled: boolean;
  highFrequencyThreshold: number;
}

export const DEFAULT_GOVERNANCE_DEFAULTS: GovernanceDefaults = {
  minAutoPublishScore: 0.7,
  requireEvidence: true,
  lintAutoGovernanceEnabled: true,
  lintAutoEligibleThreshold: 0.85,
  autoPublishRevisions: true,
  blockOnDeletes: true,
  blockOnTrustDecline: true,
  blockOnPendingCorrections: true,
  autoClusterEnabled: true,
  highFrequencyThreshold: 2,
};

export function createGovernanceProfileService(db: DatabaseHandle, defaults: Partial<GovernanceDefaults> = {}): GovernanceProfileService {
  return new GovernanceProfileService(db, { ...DEFAULT_GOVERNANCE_DEFAULTS, ...defaults });
}

/**
 * 阶段7：项目级治理规则覆盖层。
 * - resolve(projectId)：合并「环境变量默认 + 项目级覆盖」，返回完整 profile（读多写少）。
 * - update(projectId, patch)：管理员按项目落覆盖值（upsert 单行 JSONB）。
 * 消费方（发布自动化、飞轮反馈聚合）通过 resolve 拿到确定的数值，不再散落读 config 常量。
 */
export class GovernanceProfileService {
  private readonly adapter;

  constructor(private readonly db: DatabaseHandle, private readonly defaults: GovernanceDefaults) {
    this.adapter = db.adapter;
  }

  /** 环境变量默认构成的基线 profile（未落库时的 resolve 结果）。 */
  baseline(projectId: string): KnowledgeGovernanceProfile {
    const d = this.defaults;
    return {
      projectId,
      trust: { minAutoPublishScore: d.minAutoPublishScore, requireEvidence: d.requireEvidence },
      lint: { autoGovernanceEnabled: d.lintAutoGovernanceEnabled, autoEligibleThreshold: d.lintAutoEligibleThreshold },
      release: {
        autoPublishRevisions: d.autoPublishRevisions,
        blockOnDeletes: d.blockOnDeletes,
        blockOnTrustDecline: d.blockOnTrustDecline,
        blockOnPendingCorrections: d.blockOnPendingCorrections,
      },
      feedback: { autoClusterEnabled: d.autoClusterEnabled, highFrequencyThreshold: d.highFrequencyThreshold },
      source: "default",
      updatedBy: "",
      updatedAt: "",
    };
  }

  async resolve(projectId = "default_project"): Promise<KnowledgeGovernanceProfile> {
    const { rows } = await this.adapter.query(
      "SELECT * FROM knowledge_governance_profiles WHERE project_id = $1",
      [projectId],
    );
    const base = this.baseline(projectId);
    if (rows.length === 0) return base;
    const row = rows[0];
    const stored = normalizeInput(readConfig(row.config_json));
    return {
      ...mergeProfile(base, stored),
      source: "project",
      updatedBy: String(row.updated_by ?? ""),
      updatedAt: String(row.updated_at ?? ""),
    };
  }

  async update(input: { projectId: string; patch: KnowledgeGovernanceProfileInput; updatedBy: string }): Promise<KnowledgeGovernanceProfile> {
    const current = await this.resolve(input.projectId);
    const merged = mergeProfile(current, normalizeInput(input.patch));
    // 只存与四组策略相关的字段（不含 source/updatedBy/updatedAt/projectId 元数据）。
    const config = {
      trust: merged.trust,
      lint: merged.lint,
      release: merged.release,
      feedback: merged.feedback,
    };
    const now = new Date().toISOString();
    await this.adapter.query(
      `INSERT INTO knowledge_governance_profiles (project_id, config_json, updated_by, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id) DO UPDATE
         SET config_json = EXCLUDED.config_json,
             updated_by = EXCLUDED.updated_by,
             updated_at = EXCLUDED.updated_at`,
      [input.projectId, JSON.stringify(config), input.updatedBy, now],
    );
    return this.resolve(input.projectId);
  }

  /** 清除项目级覆盖，回退到环境变量默认。 */
  async reset(projectId: string): Promise<KnowledgeGovernanceProfile> {
    await this.adapter.query("DELETE FROM knowledge_governance_profiles WHERE project_id = $1", [projectId]);
    return this.resolve(projectId);
  }
}

function readConfig(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string" && value.length > 0) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** 只挑出四组策略里的已知字段，忽略未知键与类型不符的值。 */
function normalizeInput(raw: Record<string, unknown> | KnowledgeGovernanceProfileInput): KnowledgeGovernanceProfileInput {
  const source = raw as Record<string, unknown>;
  const trust = asObject(source.trust);
  const lint = asObject(source.lint);
  const release = asObject(source.release);
  const feedback = asObject(source.feedback);
  const out: KnowledgeGovernanceProfileInput = {};
  const trustPatch = {
    ...numberField(trust, "minAutoPublishScore", 0, 1),
    ...boolField(trust, "requireEvidence"),
  };
  if (Object.keys(trustPatch).length) out.trust = trustPatch;
  const lintPatch = {
    ...boolField(lint, "autoGovernanceEnabled"),
    ...numberField(lint, "autoEligibleThreshold", 0, 1),
  };
  if (Object.keys(lintPatch).length) out.lint = lintPatch;
  const releasePatch = {
    ...boolField(release, "autoPublishRevisions"),
    ...boolField(release, "blockOnDeletes"),
    ...boolField(release, "blockOnTrustDecline"),
    ...boolField(release, "blockOnPendingCorrections"),
  };
  if (Object.keys(releasePatch).length) out.release = releasePatch;
  const feedbackPatch = {
    ...boolField(feedback, "autoClusterEnabled"),
    ...intField(feedback, "highFrequencyThreshold", 1, 100),
  };
  if (Object.keys(feedbackPatch).length) out.feedback = feedbackPatch;
  return out;
}

function mergeProfile(base: KnowledgeGovernanceProfile, patch: KnowledgeGovernanceProfileInput): KnowledgeGovernanceProfile {
  return {
    ...base,
    trust: { ...base.trust, ...patch.trust },
    lint: { ...base.lint, ...patch.lint },
    release: { ...base.release, ...patch.release },
    feedback: { ...base.feedback, ...patch.feedback },
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function boolField(source: Record<string, unknown>, key: string): Record<string, boolean> {
  return typeof source[key] === "boolean" ? { [key]: source[key] as boolean } : {};
}

function numberField(source: Record<string, unknown>, key: string, min: number, max: number): Record<string, number> {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return {};
  return { [key]: Math.min(max, Math.max(min, value)) };
}

function intField(source: Record<string, unknown>, key: string, min: number, max: number): Record<string, number> {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return {};
  return { [key]: Math.min(max, Math.max(min, Math.round(value))) };
}
