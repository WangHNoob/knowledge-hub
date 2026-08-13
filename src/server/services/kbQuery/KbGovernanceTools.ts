import { nanoid } from "nanoid";

import type {
  AssetComponent,
  DatabaseHandle,
  KnowledgeEnvelope,
  ReleaseRecord,
} from "../../types";
import { jsonArray, jsonObject, mapComponent } from "../../db/mappers";
import type { DiagnosticLogger } from "../diagnosticService";
import { emitKnowledgeEvent } from "../eventService";
import { createProjectService } from "../projectService";
import { createReleaseService, AutoPublishEligibilityError } from "../releaseService";
import { createKbBuilderPipelineService } from "../kbBuilderService";
import { createLintRemediationService } from "../lintRemediationService";
import { createAttributionAuditService } from "../attributionAuditService";
import type { GovernanceProfileService } from "../governanceProfileService";
import type { FlywheelService } from "../flywheelService";
import type {
  CorrectionTarget,
  KnowledgeQueryContext,
  PublishTarget,
  SourceCorrectionView,
  ToolResult,
} from "./types";
import {
  auditIsStale,
  booleanArg,
  boundedLimitArg,
  boundedScoreArg,
  componentSummary,
  correctionTargetForComponent,
  flywheelGateReasons,
  healthBlockingReasons,
  healthComponent,
  healthCorrection,
  healthRecommendations,
  healthSummary,
  healthWarningReasons,
  manifestComponentIds,
  normalize,
  normalizeCorrectionFingerprint,
  normalizeCorrectionValue,
  normalizeSourcePath,
  numberArg,
  optionalNumber,
  optionalString,
  publishTargetSummary,
  releaseEnvelope,
  releaseSummary,
  same,
  slimAutoPublishCheck,
  slimPublishTarget,
  slug,
  sourceCorrectionFactKey,
  sourceCorrectionRecord,
  sourceRefLooksLikeSource,
  stringArg,
  trustLevel,
  uniqueSorted,
} from "./utils";

/**
 * 治理域 MCP 工具（correction / flywheel / attribution / rollback 等）。
 * 从 KnowledgeQueryService 拆出（纯移动，行为不变）：本类不直接持有
 * KnowledgeQueryService 引用，所有外部依赖经 GovernanceToolsContext 注入
 * （shared.trustSummaryForComponents 由主服务委托，避免循环依赖）。
 */
export interface GovernanceToolsContext {
  db: DatabaseHandle;
  adapter: DatabaseHandle["adapter"];
  diagnostics?: DiagnosticLogger;
  releaseService: ReturnType<typeof createReleaseService>;
  builderService: ReturnType<typeof createKbBuilderPipelineService>;
  lintRemediationService: ReturnType<typeof createLintRemediationService>;
  attributionAuditService: ReturnType<typeof createAttributionAuditService>;
  governanceProfileService: GovernanceProfileService;
  flywheel: () => FlywheelService;
  shared: {
    trustSummaryForComponents: (release: ReleaseRecord, componentIds: string[]) => Promise<KnowledgeEnvelope["trust"]>;
  };
}

export class KbGovernanceTools {
  private readonly adapter: DatabaseHandle["adapter"];
  private readonly db: DatabaseHandle;
  private readonly diagnostics?: DiagnosticLogger;
  private readonly releaseService: GovernanceToolsContext["releaseService"];
  private readonly builderService: GovernanceToolsContext["builderService"];
  private readonly lintRemediationService: GovernanceToolsContext["lintRemediationService"];
  private readonly attributionAuditService: GovernanceToolsContext["attributionAuditService"];
  private readonly governanceProfileService: GovernanceProfileService;
  private readonly flywheel: () => FlywheelService;
  private readonly trustSummaryForComponents: GovernanceToolsContext["shared"]["trustSummaryForComponents"];

  constructor(ctx: GovernanceToolsContext) {
    this.adapter = ctx.adapter;
    this.db = ctx.db;
    this.diagnostics = ctx.diagnostics;
    this.releaseService = ctx.releaseService;
    this.builderService = ctx.builderService;
    this.lintRemediationService = ctx.lintRemediationService;
    this.attributionAuditService = ctx.attributionAuditService;
    this.governanceProfileService = ctx.governanceProfileService;
    this.flywheel = ctx.flywheel;
    this.trustSummaryForComponents = ctx.shared.trustSummaryForComponents;
  }

  async kbListProjects(currentProjectId: string): Promise<ToolResult> {
    const projects = await createProjectService(this.db).listProjects();
    return {
      result: {
        currentProjectId,
        projects: projects.map((project) => ({
          projectId: project.projectId,
          name: project.name,
          description: project.description,
          status: project.status,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        })),
      },
      componentIds: [],
      forceHit: true,
    };
  }

  async kbGetFlywheelStatus(projectId: string): Promise<ToolResult> {
    const [release, latestBuild, corrections, blockingTasks, pendingReviewTasks, negativeFeedback, lintSummary, latestFeedback, latestPublishSkip, governanceProfile] = await Promise.all([
      this.releaseService.getCurrent(projectId),
      this.latestBuild(projectId),
      this.listCorrections(projectId, 10),
      this.countOpenBlockingTasks(projectId),
      this.countOpenReviewTasks(projectId),
      this.countNegativeFeedback(projectId),
      this.lintRemediationService.summary(projectId),
      this.latestAgentFeedback(projectId),
      this.latestKnowledgeEvent(projectId, "publish.skipped"),
      this.governanceProfileService.resolve(projectId),
    ]);
    const pendingCorrections = corrections.filter((item) => item.state === "pending_review").length;
    const failedLintRemediations = lintSummary.failed + lintSummary.needsHuman;
    const canAttemptPublish = Boolean(latestBuild?.packageId) &&
      blockingTasks === 0 &&
      pendingCorrections === 0 &&
      lintSummary.pending === 0 &&
      lintSummary.failed === 0 &&
      lintSummary.needsHuman === 0;
    const gateReasons = flywheelGateReasons({
      latestBuild,
      blockingTasks,
      pendingReviewTasks,
      pendingCorrections,
      lintSummary,
    });
    return {
      result: {
        projectId,
        currentRelease: release ? releaseEnvelope(release) : null,
        latestBuild,
        exceptions: {
          blockingTasks,
          pendingReviewTasks,
          negativeFeedback,
          pendingCorrections,
          failedLintRemediations,
        },
        recentActivity: {
          latestBuild,
          latestCorrection: corrections[0] ?? null,
          latestFeedback,
          latestPublishSkip,
        },
        corrections: {
          pendingReview: pendingCorrections,
          active: corrections.filter((item) => item.state === "active").length,
          recent: corrections,
        },
        gates: {
          blockingTasks,
          pendingReviewTasks,
          negativeFeedback,
          pendingCorrections,
          lintRemediation: lintSummary,
          policy: {
            source: governanceProfile.source,
            release: governanceProfile.release,
            lint: governanceProfile.lint,
            trust: governanceProfile.trust,
          },
          canAttemptPublish,
          reasons: gateReasons,
        },
      },
      componentIds: corrections.map((item) => item.componentId).filter(Boolean) as string[],
      forceHit: true,
    };
  }

  async kbRunHealthCheck(projectId: string, payload: Record<string, unknown>, context: KnowledgeQueryContext): Promise<ToolResult> {
    const governanceProfile = await this.governanceProfileService.resolve(projectId);
    const maxAuditAgeDays = boundedLimitArg(
      numberArg(payload, governanceProfile.trust.maxAuditAgeDays, "maxAuditAgeDays", "auditHalfLifeDays"),
      governanceProfile.trust.maxAuditAgeDays,
      3650,
    );
    const trustThreshold = boundedScoreArg(payload, governanceProfile.trust.minAutoPublishScore, "minTrustScore", "trustThreshold");
    const [release, latestBuild, blockingTasks, pendingReviewTasks, negativeFeedback, lintSummary, corrections] = await Promise.all([
      this.releaseService.getCurrent(projectId),
      this.latestBuild(projectId),
      this.countOpenBlockingTasks(projectId),
      this.countOpenReviewTasks(projectId),
      this.countNegativeFeedback(projectId),
      this.lintRemediationService.summary(projectId),
      this.listCorrections(projectId, 50),
    ]);
    if (!release) {
      const result = {
        projectId,
        status: "needs_attention",
        consumption: "blocked",
        summary: "当前项目没有已发布知识，Agent 暂无可消费版本。",
        checks: {
          release: { status: "failed", reason: "no_current_release" },
        },
        policy: {
          source: governanceProfile.source,
          release: governanceProfile.release,
          lint: governanceProfile.lint,
          trust: governanceProfile.trust,
        },
        recommendations: [
          { action: "upload_or_build", tool: "kb_get_flywheel_status", reason: "先确认资料库、构建和发布状态。", payload: { projectId } },
        ],
      };
      await emitKnowledgeEvent(this.db, {
        eventType: "knowledge_lint.health_checked",
        entityType: "project",
        entityId: projectId,
        payload: {
          projectId,
          status: result.status,
          consumption: result.consumption,
          policy: {
            source: governanceProfile.source,
            autoPublishRevisions: governanceProfile.release.autoPublishRevisions,
            lintAutoGovernanceEnabled: governanceProfile.lint.autoGovernanceEnabled,
            minAutoPublishScore: governanceProfile.trust.minAutoPublishScore,
          },
          actor: context.sessionId ?? "mcp-agent",
        },
      });
      return { result, componentIds: [], forceHit: true };
    }

    const componentIds = manifestComponentIds(release);
    const trust = await this.trustSummaryForComponents(release, componentIds);
    const lowTrust = trust.components
      .filter((component) => typeof component.trust?.score === "number" && component.trust.score < trustThreshold)
      .map((component) => healthComponent(component));
    const staleAudit = trust.components
      .filter((component) => auditIsStale(component.trust?.lastTrustedAuditAt ?? null, maxAuditAgeDays))
      .map((component) => healthComponent(component));
    const pendingCorrectionSamples = corrections.filter((item) => item.state === "pending_review").map(healthCorrection);
    const activeCorrectionSamples = corrections.filter((item) => item.state === "active").map(healthCorrection);
    const pendingCorrections = pendingCorrectionSamples.length;
    const activeCorrections = activeCorrectionSamples.length;
    const lintIssues = lintSummary.failed + lintSummary.needsHuman + lintSummary.pending;
    const blockingReasons = healthBlockingReasons({
      blockingTasks,
      pendingCorrections,
      lintSummary,
    });
    const warningReasons = healthWarningReasons({
      pendingReviewTasks,
      negativeFeedback,
      lowTrustCount: lowTrust.length,
      staleAuditCount: staleAudit.length,
      activeCorrections,
      lintSummary,
    });
    const reasons = [...blockingReasons, ...warningReasons];
    const status = blockingReasons.length > 0 ? "needs_attention" : warningReasons.length > 0 ? "warning" : "passed";
    const consumption = status === "needs_attention" ? "use_with_care" : "ready";
    const recommendations = healthRecommendations(projectId, blockingReasons, warningReasons, {
      pendingCorrections: pendingCorrectionSamples,
      activeCorrections: activeCorrectionSamples,
      lowTrust,
      staleAudit,
    });
    const result = {
      projectId,
      checkedAt: new Date().toISOString(),
      status,
      consumption,
      summary: healthSummary(status, release.version, blockingReasons.length, warningReasons.length),
      thresholds: {
        minTrustScore: trustThreshold,
        maxAuditAgeDays,
      },
      release: releaseEnvelope(release),
      latestBuild,
      policy: {
        source: governanceProfile.source,
        release: governanceProfile.release,
        lint: governanceProfile.lint,
        trust: governanceProfile.trust,
      },
      checks: {
        release: { status: "passed", componentCount: componentIds.length },
        lint: {
          status: lintIssues > 0 ? "warning" : "passed",
          remediation: lintSummary,
        },
        trust: {
          status: lowTrust.length > 0 ? "warning" : "passed",
          averageScore: trust.averageScore,
          minScore: trust.minScore,
          lowTrustCount: lowTrust.length,
          lowTrustSample: lowTrust.slice(0, 10),
        },
        auditFreshness: {
          status: staleAudit.length > 0 ? "warning" : "passed",
          staleCount: staleAudit.length,
          staleSample: staleAudit.slice(0, 10),
        },
        governance: {
          status: blockingReasons.length > 0 ? "failed" : warningReasons.length > 0 ? "warning" : "passed",
          blockingTasks,
          pendingReviewTasks,
          pendingCorrections,
          activeCorrections,
          negativeFeedback,
        },
        corrections: {
          status: pendingCorrections > 0 ? "failed" : activeCorrections > 0 ? "warning" : "passed",
          pendingReviewCount: pendingCorrections,
          activeCount: activeCorrections,
          pendingReviewSample: pendingCorrectionSamples.slice(0, 10),
          activeSample: activeCorrectionSamples.slice(0, 10),
        },
      },
      reasons,
      recommendations,
    };
    await emitKnowledgeEvent(this.db, {
      eventType: "knowledge_lint.health_checked",
      entityType: "release",
      entityId: release.releaseId,
      payload: {
        projectId,
        releaseId: release.releaseId,
        status,
        consumption,
        thresholds: { minTrustScore: trustThreshold, maxAuditAgeDays },
        policy: {
          source: governanceProfile.source,
          autoPublishRevisions: governanceProfile.release.autoPublishRevisions,
          lintAutoGovernanceEnabled: governanceProfile.lint.autoGovernanceEnabled,
          minAutoPublishScore: governanceProfile.trust.minAutoPublishScore,
        },
        reasons,
        recommendations: recommendations.map((item) => ({
          action: item.action,
          tool: item.tool,
          payload: item.payload ?? {},
        })),
        actor: context.sessionId ?? "mcp-agent",
      },
    });
    return {
      result,
      componentIds: uniqueSorted([...lowTrust.map((item) => item.componentId), ...staleAudit.map((item) => item.componentId)]),
      forceHit: true,
    };
  }

  async kbSubmitCorrection(projectId: string, payload: Record<string, unknown>, context: KnowledgeQueryContext): Promise<ToolResult> {
    const target = await this.resolveCorrectionTarget(projectId, payload);
    if (!target) throw new Error("kb_submit_correction requires componentId, knowledgePath, or an unambiguous sourcePath that resolves to a staged asset component.");
    const { component, sourcePath, anchor: anchorExplanation } = target;
    const anchor = await this.resolveSourceCorrectionAnchor(component.packageId, sourcePath);
    const suggestion = normalizeCorrectionValue(payload.suggestion);
    const factKey = optionalString(payload, "factKey") || sourceCorrectionFactKey(suggestion);
    const ruleId = optionalString(payload, "ruleId") || "mcp.agent_correction";
    const pageType = optionalString(payload, "pageType") || component.kind;
    const now = new Date().toISOString();
    const correctionId = `corr_mcp_${slug(sourcePath)}_${slug(ruleId)}_${nanoid(6)}`;
    const correctValue = {
      ...suggestion,
      factKey: factKey || suggestion.factKey,
      issue: stringArg(payload, "issue"),
      sourceContext: optionalString(payload, "sourceContext"),
      queryContext: optionalString(payload, "queryContext"),
      confidence: optionalNumber(payload, "confidence"),
    };
    const conflict = await this.findConflictingSourceCorrection({
      projectId,
      componentId: component.componentId,
      sourcePath,
      factKey,
      correctValue,
    });
    if (conflict) {
      throw new Error(
        `纠正冲突：组件 ${component.componentId} / ${sourcePath} 已有未退休纠正 ${conflict.correctionId}（${conflict.createdBy}），内容与本次建议不一致。请先确认或退役旧纠正，避免两 Agent 互相覆盖。`,
      );
    }
    await this.adapter.query(
      `UPDATE source_corrections
       SET state = 'retired', updated_at = $7
       WHERE project_id = $1
         AND bundle_id = $2
         AND source_path = $3
         AND rule_id = $4
         AND page_type = $5
         AND COALESCE(fact_key, '') = COALESCE($6, '')
         AND state <> 'retired'`,
      [projectId, anchor.bundleId, sourcePath, ruleId, pageType, factKey, now],
    );
    await this.adapter.query(
      `INSERT INTO source_corrections (
         correction_id, project_id, bundle_id, source_path, rule_id, page_type, fact_key,
         bound_source_hash, state, correct_value, component_id, package_id,
         example_id, task_id, created_by, created_at, updated_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending_review',$9,$10,$11,'','',$12,$13,$13)`,
      [
        correctionId,
        projectId,
        anchor.bundleId,
        sourcePath,
        ruleId,
        pageType,
        factKey || null,
        anchor.contentHash,
        JSON.stringify(correctValue),
        component.componentId,
        component.packageId,
        context.sessionId ?? "mcp-agent",
        now,
      ],
    );
    await emitKnowledgeEvent(this.db, {
      eventType: "correction.submitted",
      entityType: "source_correction",
      entityId: correctionId,
      payload: { projectId, correctionId, componentId: component.componentId, packageId: component.packageId, sourcePath, ruleId, anchor: anchorExplanation, actor: context.sessionId ?? "mcp-agent" },
    });
    await emitKnowledgeEvent(this.db, {
      eventType: "source_correction.created",
      entityType: "source_correction",
      entityId: correctionId,
      payload: { projectId, correctionId, componentId: component.componentId, packageId: component.packageId, sourcePath, ruleId, state: "pending_review", anchor: anchorExplanation },
    });
    return {
      result: {
        correctionId,
        state: "pending_review",
        message: "已提交修正建议；尚未改写发布知识。可继续调用 kb_apply_correction 激活后再做 scoped rebuild。",
        component: componentSummary(component),
        sourcePath,
        anchor: anchorExplanation,
        ruleId,
        pageType,
        factKey: factKey || null,
      },
      componentIds: [component.componentId],
      artifactIds: [component.artifactId],
      forceHit: true,
    };
  }

  async kbApplyCorrection(projectId: string, correctionId: string, context: KnowledgeQueryContext, note = ""): Promise<ToolResult> {
    const correction = await this.getCorrection(projectId, correctionId);
    if (!correction) throw new Error(`Unknown correction in project ${projectId}: ${correctionId}`);
    if (correction.state === "retired") throw new Error("Retired corrections cannot be applied.");
    const componentLevel = correction.sourcePath.startsWith("component:")
      || Boolean(correction.componentId && !sourceRefLooksLikeSource(correction.sourcePath));
    const currentHash = componentLevel ? correction.boundSourceHash : await this.findLatestSourceHash(correction.bundleId, correction.sourcePath);
    if (!componentLevel && !currentHash) throw new Error("当前资料版本中未找到该源文件，无法应用修正。");
    const now = new Date().toISOString();
    const { rows } = await this.adapter.query(
      `UPDATE source_corrections
       SET state = 'active', bound_source_hash = $3, updated_at = $4
       WHERE project_id = $1 AND correction_id = $2
       RETURNING *`,
      [projectId, correctionId, currentHash, now],
    );
    const updated = sourceCorrectionRecord(rows[0]);
    await emitKnowledgeEvent(this.db, {
      eventType: "correction.applied",
      entityType: "source_correction",
      entityId: correctionId,
      payload: { projectId, correctionId, componentId: updated.componentId, packageId: updated.packageId, sourcePath: updated.sourcePath, actor: context.sessionId ?? "mcp-agent", note },
    });
    await emitKnowledgeEvent(this.db, {
      eventType: "source_correction.confirmed",
      entityType: "source_correction",
      entityId: correctionId,
      payload: { projectId, correctionId, componentId: updated.componentId, sourcePath: updated.sourcePath, boundSourceHash: updated.boundSourceHash, actor: context.sessionId ?? "mcp-agent", note },
    });
    return { result: { correction: updated, message: "修正已激活为确定性覆盖；下一次 scoped rebuild 会把它注入中间态资产。" }, componentIds: updated.componentId ? [updated.componentId] : [], forceHit: true };
  }

  async kbStartIncrementalCheck(projectId: string, payload: Record<string, unknown>, context: KnowledgeQueryContext): Promise<ToolResult> {
    if (booleanArg(payload, false, "runPendingLintRemediations", "pendingLint", "lintPending")) {
      const releaseId = optionalString(payload, "releaseId") || (await this.releaseService.getCurrent(projectId))?.releaseId;
      const remediations = await this.lintRemediationService.executePending({
        projectId,
        releaseId,
        requestedBy: context.sessionId ?? "mcp-agent",
        kbBuilderService: this.builderService,
        limit: boundedLimitArg(numberArg(payload, 10, "limit"), 10, 50),
      });
      const componentIds = uniqueSorted(remediations.map((item) => item.targetComponentId).filter(Boolean));
      await emitKnowledgeEvent(this.db, {
        eventType: "lint.checked",
        entityType: "project",
        entityId: projectId,
        payload: {
          projectId,
          releaseId: releaseId ?? "",
          mode: "pending_lint_remediations",
          count: remediations.length,
          componentIds,
          status: remediations.length > 0 ? "started" : "empty",
          actor: context.sessionId ?? "mcp-agent",
        },
      });
      return {
        result: {
          status: remediations.length > 0 ? "started" : "empty",
          mode: "pending_lint_remediations",
          releaseId: releaseId ?? "",
          remediations,
          count: remediations.length,
          message: remediations.length > 0
            ? "已启动 pending Knowledge Lint 自动治理队列；每个可治理项会触发 scoped rebuild 并重新计算证据、依赖和 trust。"
            : "当前没有 pending Knowledge Lint 自动治理项。",
        },
        componentIds,
        forceHit: true,
      };
    }
    const correctionId = optionalString(payload, "correctionId");
    const correction = correctionId ? await this.getCorrection(projectId, correctionId) : null;
    const componentId = correction?.componentId || optionalString(payload, "componentId");
    if (!componentId) throw new Error("kb_start_incremental_check requires correctionId or componentId.");
    const rawSourcePath = normalizeSourcePath(optionalString(payload, "sourcePath") || correction?.sourcePath || "");
    const sourcePath = sourceRefLooksLikeSource(rawSourcePath) ? rawSourcePath : "";
    const run = await this.builderService.startScopedRebuildForComponent({
      componentId,
      sourcePath,
      requestedBy: context.sessionId ?? "mcp-agent",
      traceId: context.traceId,
      rebuildTaskId: correctionId ? `mcp:${correctionId}` : undefined,
    });
    await emitKnowledgeEvent(this.db, {
      eventType: "lint.checked",
      entityType: "build_run",
      entityId: run.runId,
      payload: { projectId, correctionId: correctionId || "", componentId, sourcePath, runId: run.runId, status: "started" },
    });
    return {
      result: {
        status: "started",
        run,
        correctionId: correctionId || "",
        componentId,
        sourcePath,
        message: "已启动目标组件 scoped rebuild；构建完成后会重新计算 lint、证据、依赖和 trust。",
      },
      componentIds: [componentId],
      forceHit: true,
    };
  }

  async kbPublishIfReady(projectId: string, payload: Record<string, unknown>, context: KnowledgeQueryContext): Promise<ToolResult> {
    const target = await this.resolvePublishTarget(projectId, optionalString(payload, "packageId"), optionalString(payload, "runId"));
    if (!target) {
      const result = await this.publishSkipped(projectId, "no_completed_build", [], context, { packageId: optionalString(payload, "packageId"), runId: optionalString(payload, "runId") });
      return { result, componentIds: [], forceHit: true };
    }
    let release: ReleaseRecord | null = null;
    try {
      if (target.only) {
        const revision = await this.releaseService.proposeRevisionDraftFromBuild({
          packageId: target.packageId,
          runId: target.runId,
          requestedBy: context.sessionId ?? "mcp-agent",
          only: target.only,
        });
        if (!revision.release) {
          const result = await this.publishSkipped(projectId, revision.reason, [], context, publishTargetSummary(target));
          return { result, componentIds: target.componentIds, forceHit: true };
        }
        release = revision.release;
      } else {
        release = await this.releaseService.createDraft({
          version: await this.nextMcpReleaseVersion(projectId),
          packageIds: [target.packageId],
          projectId,
          requestedBy: context.sessionId ?? "mcp-agent",
          note: `MCP 自动发布检查：${target.runId}`,
        });
      }
      const published = await this.releaseService.publish(release.releaseId, context.sessionId ?? "mcp-agent", { autoMode: Boolean(release.parentReleaseId) });
      await emitKnowledgeEvent(this.db, {
        eventType: "release.auto_publish_succeeded",
        entityType: "release",
        entityId: published.releaseId,
        payload: { projectId, releaseId: published.releaseId, runId: target.runId, packageId: target.packageId, mode: "mcp_publish_if_ready" },
      });
      return {
        result: {
          status: "published",
          release: releaseSummary(published, false),
          target: publishTargetSummary(target),
        },
        componentIds: target.componentIds,
        forceHit: true,
      };
    } catch (error) {
      const check = error instanceof AutoPublishEligibilityError ? error.check : null;
      const result = await this.publishSkipped(projectId, error instanceof Error ? error.message : String(error), check?.reasonDetails ?? [], context, {
        ...publishTargetSummary(target),
        releaseId: release?.releaseId ?? "",
        autoPublishCheck: check ? slimAutoPublishCheck(check) : null,
      });
      return { result, componentIds: target.componentIds, forceHit: true };
    }
  }

  async kbGetCorrectionStatus(projectId: string, correctionId: string): Promise<ToolResult> {
    const correction = await this.getCorrection(projectId, correctionId);
    if (!correction) throw new Error(`Unknown correction in project ${projectId}: ${correctionId}`);
    const { rows } = await this.adapter.query(
      `SELECT event_id, event_type, entity_type, entity_id, payload_json, created_at
       FROM knowledge_events
       WHERE project_id = $1
         AND (entity_id = $2 OR payload_json->>'correctionId' = $2)
       ORDER BY created_at ASC`,
      [projectId, correctionId],
    );
    const buildRunIds = rows.map((row) => String(jsonObject(row.payload_json).runId ?? "")).filter(Boolean);
    return {
      result: {
        correction,
        lifecycle: rows.map((row) => ({
          eventId: String(row.event_id ?? ""),
          type: String(row.event_type ?? ""),
          entityType: String(row.entity_type ?? ""),
          entityId: String(row.entity_id ?? ""),
          payload: jsonObject(row.payload_json),
          createdAt: String(row.created_at ?? ""),
        })),
        buildRunIds: uniqueSorted(buildRunIds),
      },
      componentIds: correction.componentId ? [correction.componentId] : [],
      forceHit: true,
    };
  }

  async kbGovernFlywheel(projectId: string, payload: Record<string, unknown>, context: KnowledgeQueryContext): Promise<ToolResult> {
    const steps: Array<{ name: string; status: "completed" | "skipped"; result?: unknown; reason?: string }> = [];
    const componentIds: string[] = [];
    const artifactIds: string[] = [];
    let correctionId = optionalString(payload, "correctionId");
    let runId = optionalString(payload, "runId");

    if (!correctionId) {
      const submitted = await this.kbSubmitCorrection(projectId, payload, context);
      correctionId = String((submitted.result as Record<string, unknown>).correctionId ?? "");
      componentIds.push(...submitted.componentIds);
      artifactIds.push(...(submitted.artifactIds ?? []));
      steps.push({ name: "submit_correction", status: "completed", result: submitted.result });
    } else {
      const correction = await this.getCorrection(projectId, correctionId);
      if (!correction) throw new Error(`Unknown correction in project ${projectId}: ${correctionId}`);
      if (correction.componentId) componentIds.push(correction.componentId);
      steps.push({ name: "submit_correction", status: "skipped", reason: "correctionId was provided" });
    }

    if (payload.apply === false) {
      steps.push({ name: "apply_correction", status: "skipped", reason: "apply=false" });
    } else {
      const applied = await this.kbApplyCorrection(projectId, correctionId, context, optionalString(payload, "note") ?? "kb_govern_flywheel");
      componentIds.push(...applied.componentIds);
      artifactIds.push(...(applied.artifactIds ?? []));
      steps.push({ name: "apply_correction", status: "completed", result: applied.result });
    }

    if (payload.check === false) {
      steps.push({ name: "incremental_check", status: "skipped", reason: "check=false" });
    } else {
      const checked = await this.kbStartIncrementalCheck(projectId, { ...payload, correctionId }, context);
      componentIds.push(...checked.componentIds);
      artifactIds.push(...(checked.artifactIds ?? []));
      runId = String(((checked.result as Record<string, unknown>).run as Record<string, unknown> | undefined)?.runId ?? runId ?? "");
      steps.push({ name: "incremental_check", status: "completed", result: checked.result });
    }

    let finalStatus = "checked";
    if (payload.publish === false) {
      steps.push({ name: "publish_if_ready", status: "skipped", reason: "publish=false" });
      finalStatus = "publish_skipped_by_request";
    } else {
      const published = await this.kbPublishIfReady(projectId, { ...payload, correctionId, runId }, context);
      componentIds.push(...published.componentIds);
      steps.push({ name: "publish_if_ready", status: "completed", result: published.result });
      finalStatus = String((published.result as Record<string, unknown>).status ?? "publish_checked");
    }

    const result = {
      status: finalStatus,
      projectId,
      correctionId,
      runId,
      steps,
      boundary: {
        stagedOnly: true,
        publishedAssetsImmutable: true,
        releaseChannelDirectWrite: false,
      },
      message: "飞轮治理已按统一 MCP 权限执行；发布只会在服务端门禁通过时生成新 revision。",
    };
    await emitKnowledgeEvent(this.db, {
      eventType: "flywheel.governed",
      entityType: "source_correction",
      entityId: correctionId,
      payload: { projectId, correctionId, runId, status: finalStatus, componentIds: uniqueSorted(componentIds), actor: context.sessionId ?? "mcp-agent" },
    });

    return {
      result,
      componentIds: uniqueSorted(componentIds),
      artifactIds: uniqueSorted(artifactIds),
      forceHit: true,
    };
  }

  async kbSubmitAttribution(projectId: string, payload: Record<string, unknown>, context: KnowledgeQueryContext): Promise<ToolResult> {
    const releaseId = optionalString(payload, "releaseId")
      ?? (await this.releaseService.getCurrent(projectId))?.releaseId
      ?? "";
    if (!releaseId) throw new Error("kb_submit_attribution requires releaseId or a current published release.");
    const title = optionalString(payload, "title") ?? `Agent attribution ${new Date().toISOString()}`;
    const segmentsRaw = payload.segments;
    if (!Array.isArray(segmentsRaw) || segmentsRaw.length === 0) {
      throw new Error("kb_submit_attribution requires a non-empty segments array.");
    }
    const segments = segmentsRaw.map((item) => {
      const row = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
      const text = typeof row.text === "string" ? row.text.trim() : "";
      if (!text) throw new Error("Each attribution segment requires non-empty text.");
      const traceRaw = row.trace && typeof row.trace === "object" && !Array.isArray(row.trace)
        ? row.trace as Record<string, unknown>
        : {};
      const derivedFrom = Array.isArray(row.derivedFrom) ? row.derivedFrom.map(String) : [];
      return {
        text,
        derivedFrom,
        trace: {
          releaseId: typeof traceRaw.releaseId === "string" ? traceRaw.releaseId : releaseId,
          componentIds: Array.isArray(traceRaw.componentIds)
            ? traceRaw.componentIds.map(String)
            : Array.isArray(payload.componentIds) ? payload.componentIds.map(String) : [],
          artifactIds: Array.isArray(traceRaw.artifactIds) ? traceRaw.artifactIds.map(String) : [],
          sourceVersionIds: Array.isArray(traceRaw.sourceVersionIds) ? traceRaw.sourceVersionIds.map(String) : [],
          evidenceIds: Array.isArray(traceRaw.evidenceIds)
            ? traceRaw.evidenceIds.map(String)
            : Array.isArray(payload.evidenceIds) ? payload.evidenceIds.map(String) : [],
        },
      };
    });
    const audit = await this.attributionAuditService.createAudit({
      releaseId,
      title,
      createdBy: context.sessionId || context.agentRole || "mcp-agent",
      segments,
      projectId,
    });
    return {
      result: {
        projectId,
        audit,
        message: "归因审计已写入；不修改已发布 OKF。",
      },
      componentIds: uniqueSorted(segments.flatMap((segment) => segment.trace.componentIds ?? [])),
      forceHit: true,
    };
  }

  async kbListFeedbackClusters(projectId: string): Promise<ToolResult> {
    const clusters = await this.flywheel().listFeedbackClusters(projectId);
    return {
      result: {
        projectId,
        count: clusters.length,
        clusters,
      },
      componentIds: uniqueSorted(clusters.flatMap((cluster) => cluster.affectedComponents.map((item) => item.componentId))),
      forceHit: true,
    };
  }

  async kbRollbackRelease(projectId: string, payload: Record<string, unknown>, context: KnowledgeQueryContext): Promise<ToolResult> {
    const role = (context.agentRole ?? "").toLowerCase();
    if (role !== "admin") {
      throw new Error("kb_rollback_release requires agentRole=admin.");
    }
    const releaseId = stringArg(payload, "releaseId");
    const release = await this.releaseService.getRelease(releaseId);
    if (!release) throw new Error(`Unknown release: ${releaseId}`);
    if (release.projectId !== projectId) {
      throw new Error(`Release ${releaseId} does not belong to project ${projectId}.`);
    }
    const rolled = await this.releaseService.rollback(releaseId, context.sessionId || "mcp-admin");
    return {
      result: {
        projectId,
        releaseId: rolled.releaseId,
        version: rolled.version,
        status: "rolled_back_channel",
        message: "已将 release channel 指回指定已发布版本；不改写历史 release 快照。",
        boundary: {
          publishedAssetsImmutable: true,
          channelRepointOnly: true,
        },
      },
      componentIds: [],
      forceHit: true,
    };
  }

  private async resolveCorrectionComponent(projectId: string, componentId?: string, knowledgePath?: string): Promise<AssetComponent | null> {
    const params: unknown[] = [projectId];
    const where = ["p.project_id = $1"];
    if (componentId) {
      params.push(componentId);
      where.push(`c.component_id = $${params.length}`);
    } else if (knowledgePath) {
      const normalized = normalize(knowledgePath);
      params.push(knowledgePath, normalized, `%${knowledgePath}%`);
      where.push(`(
        c.component_id = $${params.length - 2}
        OR c.legacy_path = $${params.length - 2}
        OR c.artifact_id = $${params.length - 2}
        OR c.title = $${params.length - 2}
        OR lower(c.component_id) = $${params.length - 1}
        OR lower(c.legacy_path) = $${params.length - 1}
        OR lower(c.artifact_id) = $${params.length - 1}
        OR lower(c.title) = $${params.length - 1}
        OR c.legacy_path ILIKE $${params.length}
        OR c.artifact_id ILIKE $${params.length}
        OR c.title ILIKE $${params.length}
      )`);
    } else {
      return null;
    }
    const { rows } = await this.adapter.query(
      `SELECT c.*
       FROM asset_components c
       JOIN asset_packages p ON p.package_id = c.package_id
       WHERE ${where.join(" AND ")}
       ORDER BY p.created_at DESC, c.component_id
       LIMIT 1`,
      params,
    );
    return rows.length ? mapComponent(rows[0]) : null;
  }

  private async resolveCorrectionTarget(projectId: string, payload: Record<string, unknown>): Promise<CorrectionTarget | null> {
    const componentId = optionalString(payload, "componentId");
    const knowledgePath = optionalString(payload, "knowledgePath");
    const requestedSourcePath = normalizeSourcePath(optionalString(payload, "sourcePath") || "");

    if (componentId) {
      const component = await this.resolveCorrectionComponent(projectId, componentId, undefined);
      if (!component) return null;
      return correctionTargetForComponent(component, requestedSourcePath, "componentId");
    }

    if (knowledgePath) {
      const component = await this.resolveCorrectionComponent(projectId, undefined, knowledgePath);
      if (!component) return null;
      return correctionTargetForComponent(component, requestedSourcePath, "knowledgePath");
    }

    if (requestedSourcePath) {
      const candidates = await this.findCorrectionComponentsBySourcePath(projectId, requestedSourcePath);
      if (candidates.length === 1) {
        return correctionTargetForComponent(candidates[0], requestedSourcePath, "sourcePath_unique");
      }
      if (candidates.length > 1) {
        throw new Error(`sourcePath ${requestedSourcePath} is referenced by multiple components; provide componentId or knowledgePath. Candidates: ${candidates.map((component) => `${component.componentId} (${component.title || component.artifactId})`).join(", ")}`);
      }
    }

    return null;
  }

  private async findCorrectionComponentsBySourcePath(projectId: string, sourcePath: string): Promise<AssetComponent[]> {
    const like = `%${sourcePath}%`;
    const { rows } = await this.adapter.query(
      `SELECT c.*
       FROM asset_components c
       JOIN asset_packages p ON p.package_id = c.package_id
       WHERE p.project_id = $1
         AND (c.source_refs ? $2 OR c.source_refs::text ILIKE $3)
       ORDER BY p.created_at DESC, c.component_id`,
      [projectId, sourcePath, like],
    );
    return rows.map(mapComponent);
  }

  private async resolveSourceCorrectionAnchor(packageId: string, sourcePath: string): Promise<{ bundleId: string; contentHash: string }> {
    const { rows: packageRows } = await this.adapter.query("SELECT source_version_ids FROM asset_packages WHERE package_id = $1", [packageId]);
    const versionIds = packageRows.length ? jsonArray(packageRows[0].source_version_ids) : [];
    if (versionIds.length === 0) return { bundleId: "default", contentHash: "" };
    const placeholders = versionIds.map((_, index) => `$${index + 2}`).join(",");
    const { rows } = await this.adapter.query(
      `SELECT v.bundle_id, COALESCE(sf.content_hash, '') AS content_hash
       FROM source_bundle_versions v
       LEFT JOIN source_files sf ON sf.version_id = v.version_id AND sf.logical_path = $1
       WHERE v.version_id IN (${placeholders})
       ORDER BY v.created_at DESC, v.version_id DESC
       LIMIT 1`,
      [sourcePath, ...versionIds],
    );
    if (!rows.length) return { bundleId: "default", contentHash: "" };
    return { bundleId: String(rows[0].bundle_id ?? "default"), contentHash: String(rows[0].content_hash ?? "") };
  }

  private async findLatestSourceHash(bundleId: string, sourcePath: string): Promise<string> {
    const { rows } = await this.adapter.query(
      `SELECT sf.content_hash
       FROM source_bundle_versions v
       JOIN source_files sf ON sf.version_id = v.version_id
       WHERE v.bundle_id = $1 AND sf.logical_path = $2
       ORDER BY v.created_at DESC, v.version_id DESC
       LIMIT 1`,
      [bundleId, sourcePath],
    );
    return rows.length ? String(rows[0].content_hash ?? "") : "";
  }

  private async getCorrection(projectId: string, correctionId: string): Promise<SourceCorrectionView | null> {
    const { rows } = await this.adapter.query("SELECT * FROM source_corrections WHERE project_id = $1 AND correction_id = $2", [projectId, correctionId]);
    return rows.length ? sourceCorrectionRecord(rows[0]) : null;
  }

  /** 同实体已有未退休纠正且核心内容不同 → 冲突，禁止静默覆盖。 */
  private async findConflictingSourceCorrection(input: {
    projectId: string;
    componentId: string;
    sourcePath: string;
    factKey: string | null;
    correctValue: Record<string, unknown>;
  }): Promise<{ correctionId: string; createdBy: string } | null> {
    const { rows } = await this.adapter.query(
      `SELECT correction_id, created_by, correct_value
       FROM source_corrections
       WHERE project_id = $1
         AND component_id = $2
         AND source_path = $3
         AND COALESCE(fact_key, '') = COALESCE($4, '')
         AND state IN ('pending_review', 'active')
       ORDER BY updated_at DESC
       LIMIT 8`,
      [input.projectId, input.componentId, input.sourcePath, input.factKey],
    );
    const incoming = normalizeCorrectionFingerprint(input.correctValue);
    for (const row of rows) {
      const existing = normalizeCorrectionFingerprint(jsonObject(row.correct_value));
      if (existing === incoming) continue;
      return { correctionId: String(row.correction_id), createdBy: String(row.created_by ?? "") };
    }
    return null;
  }

  private async listCorrections(projectId: string, limit: number): Promise<SourceCorrectionView[]> {
    const { rows } = await this.adapter.query(
      `SELECT *
       FROM source_corrections
       WHERE project_id = $1
       ORDER BY updated_at DESC, created_at DESC
       LIMIT $2`,
      [projectId, limit],
    );
    return rows.map(sourceCorrectionRecord);
  }

  private async latestBuild(projectId: string): Promise<Record<string, unknown> | null> {
    const { rows } = await this.adapter.query(
      `SELECT run_id, project_id, source_version_id, package_id, status, current_stage, completed_stages, started_at, finished_at, error, config_json
       FROM knowledge_build_runs
       WHERE project_id = $1
       ORDER BY started_at DESC, run_id DESC
       LIMIT 1`,
      [projectId],
    );
    if (!rows.length) return null;
    const row = rows[0];
    return {
      runId: String(row.run_id ?? ""),
      projectId: String(row.project_id ?? ""),
      sourceVersionId: String(row.source_version_id ?? ""),
      packageId: row.package_id ? String(row.package_id) : null,
      status: String(row.status ?? ""),
      currentStage: String(row.current_stage ?? ""),
      completedStages: jsonArray(row.completed_stages),
      startedAt: String(row.started_at ?? ""),
      finishedAt: row.finished_at ? String(row.finished_at) : null,
      error: String(row.error ?? ""),
      config: jsonObject(row.config_json),
    };
  }

  private async countOpenBlockingTasks(projectId: string): Promise<number> {
    const { rows } = await this.adapter.query(
      `SELECT COUNT(*)::int AS c
       FROM review_tasks
       WHERE project_id = $1 AND status = 'open' AND severity = 'blocking'`,
      [projectId],
    );
    return Number(rows[0]?.c ?? 0);
  }

  private async countOpenReviewTasks(projectId: string): Promise<number> {
    const { rows } = await this.adapter.query(
      `SELECT COUNT(*)::int AS c
       FROM review_tasks
       WHERE project_id = $1 AND status = 'open'`,
      [projectId],
    );
    return Number(rows[0]?.c ?? 0);
  }

  private async countNegativeFeedback(projectId: string): Promise<number> {
    const { rows } = await this.adapter.query(
      `SELECT COUNT(*)::int AS c
       FROM agent_events
       WHERE project_id = $1
         AND feedback_type <> 'hit'`,
      [projectId],
    );
    return Number(rows[0]?.c ?? 0);
  }

  private async latestAgentFeedback(projectId: string): Promise<Record<string, unknown> | null> {
    const { rows } = await this.adapter.query(
      `SELECT event_id, release_id, query, hit_component_ids, quality_flags, status, feedback_type, suggested_action, task_id, created_at
       FROM agent_events
       WHERE project_id = $1
       ORDER BY created_at DESC, event_id DESC
       LIMIT 1`,
      [projectId],
    );
    if (!rows.length) return null;
    const row = rows[0];
    return {
      eventId: String(row.event_id ?? ""),
      releaseId: String(row.release_id ?? ""),
      query: String(row.query ?? ""),
      hitComponentIds: jsonArray(row.hit_component_ids),
      qualityFlags: jsonArray(row.quality_flags),
      status: String(row.status ?? ""),
      feedbackType: String(row.feedback_type ?? ""),
      suggestedAction: String(row.suggested_action ?? ""),
      taskId: String(row.task_id ?? ""),
      createdAt: String(row.created_at ?? ""),
    };
  }

  private async latestKnowledgeEvent(projectId: string, eventType: string): Promise<Record<string, unknown> | null> {
    const { rows } = await this.adapter.query(
      `SELECT event_id, event_type, entity_type, entity_id, payload_json, created_at
       FROM knowledge_events
       WHERE project_id = $1 AND event_type = $2
       ORDER BY created_at DESC, event_id DESC
       LIMIT 1`,
      [projectId, eventType],
    );
    if (!rows.length) return null;
    const row = rows[0];
    return {
      eventId: String(row.event_id ?? ""),
      type: String(row.event_type ?? ""),
      entityType: String(row.entity_type ?? ""),
      entityId: String(row.entity_id ?? ""),
      payload: jsonObject(row.payload_json),
      createdAt: String(row.created_at ?? ""),
    };
  }

  private async resolvePublishTarget(projectId: string, packageId?: string, runId?: string): Promise<PublishTarget | null> {
    const params: unknown[] = [projectId];
    const where = ["r.project_id = $1", "r.status = 'completed'", "r.package_id IS NOT NULL"];
    if (packageId) {
      params.push(packageId);
      where.push(`r.package_id = $${params.length}`);
    }
    if (runId) {
      params.push(runId);
      where.push(`r.run_id = $${params.length}`);
    }
    const { rows } = await this.adapter.query(
      `SELECT r.run_id, r.package_id, r.config_json, p.source_version_ids
       FROM knowledge_build_runs r
       JOIN asset_packages p ON p.package_id = r.package_id
       WHERE ${where.join(" AND ")}
       ORDER BY r.finished_at DESC NULLS LAST, r.started_at DESC
       LIMIT 1`,
      params,
    );
    if (!rows.length) return null;
    const row = rows[0];
    const pkgId = String(row.package_id ?? "");
    const { rows: components } = await this.adapter.query("SELECT component_id FROM asset_components WHERE package_id = $1 ORDER BY component_id", [pkgId]);
    return {
      runId: String(row.run_id ?? ""),
      packageId: pkgId,
      only: String(jsonObject(row.config_json).only ?? ""),
      componentIds: components.map((component) => String(component.component_id ?? "")).filter(Boolean),
    };
  }

  private async publishSkipped(
    projectId: string,
    reason: string,
    reasonDetails: unknown[],
    context: KnowledgeQueryContext,
    target: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await emitKnowledgeEvent(this.db, {
      eventType: "publish.skipped",
      entityType: "release",
      entityId: String(target.releaseId ?? target.runId ?? ""),
      payload: { projectId, reason, reasonDetails, target, actor: context.sessionId ?? "mcp-agent", mode: "mcp_publish_if_ready" },
    });
    await emitKnowledgeEvent(this.db, {
      eventType: "release.auto_publish_skipped",
      entityType: "release",
      entityId: String(target.releaseId ?? target.runId ?? ""),
      payload: { projectId, reason, reasonDetails, ...target, mode: "mcp_publish_if_ready" },
    });
    return { status: "skipped", reason, reasonDetails, target: slimPublishTarget(target) };
  }

  private async nextMcpReleaseVersion(projectId: string): Promise<string> {
    const prefix = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/gu, ".");
    const { rows } = await this.adapter.query(
      "SELECT COUNT(*)::int AS c FROM releases WHERE project_id = $1 AND version LIKE $2",
      [projectId, `${prefix}.mcp.%`],
    );
    return `${prefix}.mcp.${String(Number(rows[0]?.c ?? 0) + 1).padStart(3, "0")}`;
  }
}
