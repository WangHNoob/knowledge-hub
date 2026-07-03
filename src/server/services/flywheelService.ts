import { nanoid } from "nanoid";

import type { DiagnosticLogger } from "./diagnosticService";
import type { GovernanceProfileService } from "./governanceProfileService";
import type { KbBuilderPipelineService } from "./kbBuilderService";
import type { KnowledgeService } from "./knowledgeService";
import type { LintRemediationService } from "./lintRemediationService";
import type { ProjectService } from "./projectService";
import type { ReleaseService } from "./releaseService";
import type { SourceBundleService } from "./sourceBundleService";
import type { PipelineModelConfig } from "./kbBuilder/modelConfig";
import type {
  AgentEvent,
  AgentFeedbackCluster,
  DatabaseHandle,
  FeedbackClusterType,
  FlywheelAutomationItem,
  FlywheelMetrics,
  FlywheelPrimaryAction,
  FlywheelState,
  FlywheelStatus,
  FlywheelSyncResult,
  HumanException,
  KnowledgeBuildRun,
  KnowledgeLintRemediation,
  ReleaseRecord,
  ReviewSeverity,
  ReviewTask,
} from "../types";

/**
 * 低置信阈值：LLM 打分低于此值的标注任务需要人来选正确答案。
 */
const LOW_CONFIDENCE_THRESHOLD = 0.55;
/**
 * 负反馈聚合阈值兜底：治理 profile 未解析出 highFrequencyThreshold 时用此默认值。
 * 项目级治理规则（governanceProfileService）优先，见 listExceptions/listFeedbackClusters。
 */
const DEFAULT_HIGH_FREQUENCY_THRESHOLD = 2;

export interface FlywheelServiceDeps {
  db: DatabaseHandle;
  knowledgeService: KnowledgeService;
  bundleService: SourceBundleService;
  kbBuilderService: KbBuilderPipelineService;
  releaseService: ReleaseService;
  projectService: ProjectService;
  lintRemediationService: LintRemediationService;
  governanceProfileService: GovernanceProfileService;
  diagnostics?: DiagnosticLogger;
}

export function createFlywheelService(deps: FlywheelServiceDeps): FlywheelService {
  return new FlywheelService(deps);
}

/**
 * 轻量知识运营台的聚合层：把构建、治理、发布、Agent 反馈收敛成
 * 「一句话状态 + 一个主动作」（getStatus）、「必须人工处理的例外」（listExceptions）
 * 和「一键同步并发布」（sync）。只做读聚合与编排，写路径仍走既有确定性服务。
 */
export class FlywheelService {
  private readonly db: DatabaseHandle;
  private readonly adapter;
  private readonly knowledge: KnowledgeService;
  private readonly bundles: SourceBundleService;
  private readonly builder: KbBuilderPipelineService;
  private readonly releases: ReleaseService;
  private readonly projects: ProjectService;
  private readonly remediations: LintRemediationService;
  private readonly governance: GovernanceProfileService;
  private readonly diagnostics?: DiagnosticLogger;

  constructor(deps: FlywheelServiceDeps) {
    this.db = deps.db;
    this.adapter = deps.db.adapter;
    this.knowledge = deps.knowledgeService;
    this.bundles = deps.bundleService;
    this.builder = deps.kbBuilderService;
    this.releases = deps.releaseService;
    this.projects = deps.projectService;
    this.remediations = deps.lintRemediationService;
    this.governance = deps.governanceProfileService;
    this.diagnostics = deps.diagnostics;
  }

  async getStatus(projectId = "default_project"): Promise<FlywheelStatus> {
    const [runs, currentRelease, releases, exceptions, automation, sourceChanges, agentFeedbackOpen, autoGovernedToday, remediation] =
      await Promise.all([
        this.builder.listRuns(projectId),
        this.releases.getCurrent(projectId),
        this.knowledge.listReleases(projectId),
        this.listExceptions(projectId),
        this.recentAutomation(projectId),
        this.countUnbuiltSourceChanges(projectId),
        this.countOpenAgentFeedback(projectId),
        this.countAutoGovernedToday(projectId),
        this.remediations.summary(projectId),
      ]);

    const runningBuilds = runs.filter((run) => run.status === "running").length;
    const draftReleases = releases.filter((release) => release.status === "draft").length;
    const pendingExceptions = exceptions.length;

    const metrics: FlywheelMetrics = {
      sourceChanges,
      runningBuilds,
      pendingExceptions,
      currentReleaseVersion: currentRelease?.version ?? "",
      agentFeedbackOpen,
      autoGovernedToday,
    };

    const state = resolveState({ runningBuilds, sourceChanges, pendingExceptions, draftReleases, currentRelease });
    const primaryAction = resolvePrimaryAction({ state, exceptions, agentFeedbackOpen, currentRelease });
    const { headline, summary } = describeState({ state, metrics, currentRelease });

    return { state, headline, summary, primaryAction, metrics, attentionItems: exceptions, recentAutomation: automation, remediation };
  }

  /**
   * 例外中心：只返回必须人工介入的问题（阻断审核、LLM 低置信、发布被跳过、高频负反馈、
   * 不能自动治理的 lint 治理项）。普通 warning、已自动治理、纯观察项不进入此列表。
   */
  async listExceptions(projectId = "default_project"): Promise<HumanException[]> {
    const [tasks, events, skips, needsHumanRemediations, failedRemediations, profile] = await Promise.all([
      this.knowledge.listReviewTasks({ status: "open", projectId }),
      this.knowledge.listAgentEvents(projectId),
      this.listPendingPublishSkips(projectId),
      this.remediations.listRemediations({ projectId, status: "needs_human" }),
      this.remediations.listRemediations({ projectId, status: "failed" }),
      this.governance.resolve(projectId),
    ]);

    const out: HumanException[] = [];
    for (const task of tasks) {
      const exception = exceptionFromTask(task);
      if (exception) out.push(exception);
    }
    for (const skip of skips) out.push(skip);
    for (const cluster of clusterNegativeFeedback(events, profile.feedback.highFrequencyThreshold)) out.push(cluster);
    for (const remediation of [...needsHumanRemediations, ...failedRemediations]) out.push(exceptionFromRemediation(remediation));

    return out.sort((a, b) => attentionRank(a) - attentionRank(b) || b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * 阶段5：把 MCP 原始反馈事件聚合成策划能理解的知识问题簇。
   * 按「反馈类别 + 命中组件」聚合，输出业务化标题、示例查询和单一主动作。
   */
  async listFeedbackClusters(projectId = "default_project"): Promise<AgentFeedbackCluster[]> {
    const profile = await this.governance.resolve(projectId);
    if (!profile.feedback.autoClusterEnabled) return [];
    const threshold = profile.feedback.highFrequencyThreshold;
    const events = (await this.knowledge.listAgentEvents(projectId)).filter(isNegativeFeedback);
    if (events.length === 0) return [];

    // 聚合键：反馈类别 + 首个命中组件（未命中则按归一化查询）。
    const groups = new Map<string, AgentEvent[]>();
    for (const event of events) {
      const type = clusterType(event);
      const component = event.hitComponentIds[0] ?? "";
      const key = component ? `${type}::${component}` : `${type}::q::${normalizeQuery(event.query)}`;
      const list = groups.get(key) ?? [];
      list.push(event);
      groups.set(key, list);
    }

    const openTaskIds = new Set(
      (await this.knowledge.listReviewTasks({ status: "open", projectId })).map((task) => task.taskId),
    );

    const clusters: AgentFeedbackCluster[] = [];
    for (const [key, list] of groups) {
      const head = list[0];
      if (!head) continue;
      const type = clusterType(head);
      const count = list.length;
      const isMiss = list.some((event) => event.status === "miss");
      const severity: ReviewSeverity = count >= threshold && isMiss ? "blocking" : count >= threshold ? "warning" : "info";
      const queryExamples = [...new Set(list.map((event) => stripToolPrefix(event.query)).filter(Boolean))].slice(0, 3);
      const affectedComponents = dedupeComponents(list);
      const hasOpenTask = list.some((event) => event.taskId && openTaskIds.has(event.taskId));
      clusters.push({
        clusterId: `cluster_${slugKey(key)}`,
        projectId,
        type,
        title: clusterTitle(type, queryExamples[0] ?? head.query, count, affectedComponents),
        queryExamples,
        affectedComponents,
        count,
        severity,
        recommendedAction: clusterRecommendedAction(type),
        status: hasOpenTask ? "needs_human" : "open",
        primaryAction: clusterPrimaryAction(type),
        lastSeenAt: list.map((event) => event.createdAt).sort().at(-1) ?? head.createdAt,
      });
    }

    return clusters.sort((a, b) => severityWeight(b.severity) - severityWeight(a.severity) || b.count - a.count || b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  /**
   * 一键同步并发布：定位当前项目最新资料版本 → 生成 build-plan → 启动构建（增量优先，
   * 多文件变更回退全量）→ 通过 publishOnComplete 让发布自动化在构建完成后发布 revision。
   * 构建为后台异步任务，因此本方法返回 status="started"，前端轮询 getStatus 观测结果。
   */
  async sync(input: { projectId?: string; requestedBy: string; traceId?: string; mode?: "incremental" | "full" }): Promise<FlywheelSyncResult> {
    const projectId = input.projectId ?? "default_project";
    const syncId = `sync_${Date.now()}_${nanoid(6)}`;
    const bundle = await this.projects.getDefaultBundle(projectId);
    if (!bundle) return needsAttention(syncId, "该项目还没有资料库，请先创建资料库并导入资料。");

    const versions = await this.bundles.listVersions(bundle.bundleId);
    const latest = versions[0];
    if (!latest) return needsAttention(syncId, "该项目还没有任何资料版本，请先导入资料再同步。");

    const plan = await this.bundles.buildPlan(latest.versionId, projectId);
    // 单一文件变更且推荐增量时才走增量（builder 的 only 只支持单一路径）；否则全量。
    const canIncremental = plan.recommendedMode === "incremental" && plan.targets.length === 1;
    const mode: "incremental" | "full" = input.mode === "incremental" && canIncremental ? "incremental" : input.mode ?? (canIncremental ? "incremental" : "full");
    const effectiveMode: "incremental" | "full" = mode === "incremental" && canIncremental ? "incremental" : "full";
    const only = effectiveMode === "incremental" ? plan.targets[0] ?? null : null;
    const releaseVersion = await this.nextReleaseVersion(projectId);
    const modelConfig = await this.resolveBuildModelConfig(projectId);

    let run: KnowledgeBuildRun;
    try {
      run = await this.builder.startBuild({
        projectId,
        bundleId: bundle.bundleId,
        versionId: latest.versionId,
        requestedBy: input.requestedBy,
        traceId: input.traceId,
        stages: ["convert", "extract", "tables", "graph", "viz"],
        model: modelConfig.model,
        modelConfig,
        force: false,
        only,
        qualityProfileId: "default",
        publishOnComplete: true,
        releaseVersion,
      });
    } catch (error) {
      await this.diagnostics?.write({
        traceId: input.traceId ?? "",
        level: "error",
        category: "flywheel",
        message: "flywheel sync failed to start build",
        status: "failed",
        actor: input.requestedBy,
        entityType: "source_version",
        entityId: latest.versionId,
        error,
        context: { projectId, syncId, bundleId: bundle.bundleId },
      });
      return {
        syncId,
        status: "failed",
        buildRunIds: [],
        packageIds: [],
        published: false,
        mode: effectiveMode,
        message: error instanceof Error ? error.message : "启动构建失败。",
        attentionItems: [],
        automationEvents: [],
      };
    }

    await this.diagnostics?.write({
      traceId: input.traceId ?? "",
      level: "info",
      category: "flywheel",
      message: "flywheel sync started build-and-publish",
      status: "event",
      actor: input.requestedBy,
      entityType: "build_run",
      entityId: run.runId,
      runId: run.runId,
      context: { projectId, syncId, mode: effectiveMode, only, releaseVersion, changedFiles: plan.targets.length, provider: modelConfig.provider, model: modelConfig.model },
    });

    return {
      syncId,
      status: "started",
      buildRunIds: [run.runId],
      packageIds: [],
      published: false,
      mode: effectiveMode,
      message: effectiveMode === "incremental"
        ? `已启动增量构建并将在完成后自动发布 ${releaseVersion}。`
        : `已启动全量构建并将在完成后自动发布 ${releaseVersion}。`,
      attentionItems: [],
      automationEvents: [run.runId],
    };
  }

  // ---- 聚合辅助 ----

  /** 最新资料版本若尚未构建成资产，则统计其相对上一版本的变更文件数；否则 0。 */
  private async countUnbuiltSourceChanges(projectId: string): Promise<number> {
    const bundle = await this.projects.getDefaultBundle(projectId);
    if (!bundle) return 0;
    const versions = await this.bundles.listVersions(bundle.bundleId);
    const latest = versions[0];
    if (!latest) return 0;
    if (await this.versionIsBuilt(projectId, latest.versionId)) return 0;
    const plan = await this.bundles.buildPlan(latest.versionId, projectId);
    return plan.targets.length;
  }

  private async versionIsBuilt(projectId: string, versionId: string): Promise<boolean> {
    const { rows } = await this.adapter.query(
      `SELECT 1 FROM asset_packages
       WHERE project_id = $1 AND source_version_ids @> $2::jsonb
       LIMIT 1`,
      [projectId, JSON.stringify([versionId])],
    );
    return rows.length > 0;
  }

  private async countOpenAgentFeedback(projectId: string): Promise<number> {
    const events = await this.knowledge.listAgentEvents(projectId);
    return events.filter(isNegativeFeedback).length;
  }

  private async countAutoGovernedToday(projectId: string): Promise<number> {
    const since = startOfShanghaiDayIso();
    const { rows } = await this.adapter.query(
      `SELECT COUNT(*)::int AS c
       FROM knowledge_events
       WHERE project_id = $1
         AND created_at >= $2
         AND event_type IN (
           'release.auto_publish_succeeded',
           'agent.feedback.rebuild_started',
           'annotation.writeback_rebuild_started',
           'source_correction.confirmed'
         )`,
      [projectId, since],
    );
    return Number(rows[0]?.c ?? 0);
  }

  private async recentAutomation(projectId: string, limit = 6): Promise<FlywheelAutomationItem[]> {
    const events = await this.knowledge.listFlywheelEvents(projectId);
    return events.slice(0, limit).map((event) => ({
      id: event.eventId,
      title: automationTitle(event.eventType, event.payload),
      status: automationStatus(event.eventType),
      createdAt: event.createdAt,
    }));
  }

  /** 最近被跳过、且此后没有成功发布覆盖的自动发布尝试 → 发布阻断例外。 */
  private async listPendingPublishSkips(projectId: string): Promise<HumanException[]> {
    const events = await this.knowledge.listFlywheelEvents(projectId);
    const succeededReleaseIds = new Set(
      events
        .filter((event) => event.eventType === "release.auto_publish_succeeded")
        .map((event) => String(event.payload.releaseId ?? "")),
    );
    const seen = new Set<string>();
    const out: HumanException[] = [];
    for (const event of events) {
      if (event.eventType !== "release.auto_publish_skipped") continue;
      const releaseId = String(event.payload.releaseId ?? "");
      const dedupKey = releaseId || event.eventId;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      if (releaseId && succeededReleaseIds.has(releaseId)) continue;
      const reason = String(event.payload.reason ?? "自动发布被质量门禁或发布策略拦截。");
      out.push({
        id: `skip-${event.eventId}`,
        type: "publish_blocker",
        attentionLevel: "blocking",
        severity: "blocking",
        title: "自动发布被跳过，需要人工确认",
        body: reason,
        whyHumanNeeded: "自动发布未通过质量门禁或发布策略，系统不会在无人确认时推送给 Agent。",
        recommendedAction: "打开发布页检查阻断原因，补齐后手动发布或调整治理规则。",
        primaryAction: { label: "去发布页", type: "open_asset" },
        target: { page: "release", params: releaseId ? { releaseId } : {} },
        technicalIds: { releaseId: releaseId || undefined },
        createdAt: event.createdAt,
      });
    }
    return out;
  }

  private async nextReleaseVersion(projectId: string): Promise<string> {
    const prefix = shanghaiDottedDate();
    const { rows } = await this.adapter.query(
      "SELECT COUNT(*)::int AS c FROM releases WHERE project_id = $1 AND version LIKE $2",
      [projectId, `${prefix}.%`],
    );
    const seq = Number(rows[0]?.c ?? 0) + 1;
    return `${prefix}.${String(seq).padStart(3, "0")}`;
  }

  private async resolveBuildModelConfig(projectId: string): Promise<PipelineModelConfig> {
    const latest = await this.latestCompletedBuildModelConfig(projectId);
    if (latest) return latest;
    const envKey = process.env.OPENAI_API_KEY;
    if (envKey) {
      return {
        provider: "openai-compatible",
        baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
        model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
        apiKey: envKey,
      };
    }
    return { provider: "deterministic", model: "deterministic" };
  }

  private async latestCompletedBuildModelConfig(projectId: string): Promise<PipelineModelConfig | null> {
    const { rows } = await this.adapter.query(
      `SELECT config_json
       FROM knowledge_build_runs
       WHERE project_id = $1
         AND status = 'completed'
         AND config_json ? 'modelConfig'
       ORDER BY started_at DESC
       LIMIT 1`,
      [projectId],
    );
    if (rows.length === 0) return null;
    const config = readJsonObject(rows[0].config_json);
    const model = readJsonObject(config.modelConfig);
    const provider = String(model.provider ?? "");
    if (provider === "anthropic") {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return null;
      return {
        provider,
        baseUrl: String(model.baseUrl || "https://api.anthropic.com/v1"),
        model: String(model.model || "claude-sonnet-4-5"),
        apiKey,
      };
    }
    if (provider === "openai-compatible") {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return null;
      return {
        provider,
        baseUrl: String(model.baseUrl || "https://api.openai.com/v1"),
        model: String(model.model || "gpt-4.1-mini"),
        apiKey,
      };
    }
    return null;
  }
}

// ---- 纯函数：状态机与例外派生 ----

function resolveState(input: {
  runningBuilds: number;
  sourceChanges: number;
  pendingExceptions: number;
  draftReleases: number;
  currentRelease: ReleaseRecord | null;
}): FlywheelState {
  if (input.pendingExceptions > 0) return "needs_attention";
  if (input.runningBuilds > 0) return "building";
  if (input.sourceChanges > 0) return "source_changed";
  if (input.draftReleases > 0) return "ready_to_publish";
  if (input.currentRelease) return "published";
  return "idle";
}

function resolvePrimaryAction(input: {
  state: FlywheelState;
  exceptions: HumanException[];
  agentFeedbackOpen: number;
  currentRelease: ReleaseRecord | null;
}): FlywheelPrimaryAction {
  switch (input.state) {
    case "needs_attention":
      return { label: `查看 ${input.exceptions.length} 个例外`, action: "open_exceptions" };
    case "building":
      return { label: "查看构建进度", action: "open_sources" };
    case "source_changed":
      return { label: "同步资料并发布", action: "sync_and_publish" };
    case "ready_to_publish":
      return { label: "检查并发布版本", action: "open_release" };
    case "published":
      return input.agentFeedbackOpen > 0
        ? { label: "复测 Agent 查询", action: "retest_agent" }
        : { label: "导入新资料", action: "open_sources" };
    case "idle":
    default:
      return { label: "导入资料并构建", action: "open_sources" };
  }
}

function describeState(input: {
  state: FlywheelState;
  metrics: FlywheelMetrics;
  currentRelease: ReleaseRecord | null;
}): { headline: string; summary: string } {
  const version = input.currentRelease?.version ?? input.metrics.currentReleaseVersion;
  switch (input.state) {
    case "needs_attention":
      return {
        headline: `有 ${input.metrics.pendingExceptions} 个例外需要处理`,
        summary: "这些问题系统无法自动处理，处理后飞轮会继续自动运转。其余环节仍在自动进行。",
      };
    case "building":
      return {
        headline: `正在构建知识（${input.metrics.runningBuilds} 个进行中）`,
        summary: "构建完成后会自动运行 Lint、治理并按发布策略发布，无需手动干预。",
      };
    case "source_changed":
      return {
        headline: `资料有 ${input.metrics.sourceChanges} 处变更待同步`,
        summary: "点击一次即可完成构建、治理和发布；稳定规则下无需理解中间环节。",
      };
    case "ready_to_publish":
      return {
        headline: "有构建结果待发布",
        summary: "构建已完成但尚未推送给 Agent，检查无阻断后即可发布。",
      };
    case "published":
      return {
        headline: version ? `知识库已同步，Agent 正在消费 ${version}` : "知识库已同步，Agent 可用",
        summary: input.metrics.agentFeedbackOpen > 0
          ? `Agent 有 ${input.metrics.agentFeedbackOpen} 条反馈可复测，其余一切正常。`
          : "当前没有需要处理的事项，导入新资料后会再次进入同步流程。",
      };
    case "idle":
    default:
      return {
        headline: "还没有知识可供 Agent 消费",
        summary: "从导入资料开始，系统会自动构建、治理并发布第一版知识库。",
      };
  }
}

function exceptionFromTask(task: ReviewTask): HumanException | null {
  const knowledgeTitle = task.title || humanizeComponent(task.componentId);
  if (task.severity === "blocking") {
    return {
      id: `task-${task.taskId}`,
      type: "exception",
      attentionLevel: "blocking",
      severity: "blocking",
      title: knowledgeTitle,
      body: task.suggestedAction || task.description || "该知识存在阻断级问题，发布前必须解决。",
      whyHumanNeeded: "阻断级问题会拦截发布，且无法安全自动修复，需要人工判断。",
      recommendedAction: task.suggestedAction || "打开审核任务，确认修复方式或标注正确答案。",
      primaryAction: { label: "去处理", type: task.taskKind === "annotation" ? "annotate" : "approve" },
      target: { page: "review", params: { taskId: task.taskId } },
      technicalIds: { componentId: task.componentId, packageId: task.packageId, taskId: task.taskId },
      createdAt: task.createdAt,
    };
  }
  const lowConfidence = task.taskKind === "annotation" && task.confidence > 0 && task.confidence < LOW_CONFIDENCE_THRESHOLD;
  if (lowConfidence) {
    return {
      id: `task-${task.taskId}`,
      type: "exception",
      attentionLevel: "needs_decision",
      severity: task.severity,
      title: knowledgeTitle,
      body: task.suggestedAction || task.description || "AI 对该知识的判断置信度较低。",
      whyHumanNeeded: `AI 置信度仅 ${Math.round(task.confidence * 100)}%，需要人来选出正确答案。`,
      recommendedAction: "打开标注任务，从候选中选择正确答案或直接标注。",
      primaryAction: { label: "去标注", type: "annotate" },
      target: { page: "review", params: { taskId: task.taskId } },
      technicalIds: { componentId: task.componentId, packageId: task.packageId, taskId: task.taskId },
      createdAt: task.createdAt,
    };
  }
  return null;
}

/** 把不能自动治理/治理失败的 lint 治理任务转成例外中心条目。 */
function exceptionFromRemediation(remediation: KnowledgeLintRemediation): HumanException {
  const target = remediationTarget(remediation);
  const failed = remediation.status === "failed";
  return {
    id: `remediation-${remediation.remediationId}`,
    type: "lint",
    attentionLevel: failed || remediation.severity === "blocking" ? "blocking" : "needs_decision",
    severity: failed ? "blocking" : remediation.severity,
    title: remediation.title || `${lintDomainLabel(remediation.domain)}治理项`,
    body: failed && remediation.error
      ? `${remediation.diagnosis || remediation.title}。失败原因：${remediation.error}`
      : remediation.diagnosis || remediation.remediation || "Knowledge Lint 发现需要人工处理的问题。",
    whyHumanNeeded: failed
      ? "系统已尝试自动治理，但执行失败，需要人工查看错误并决定是否重建或修正规则。"
      : remediation.actionType === "rebuild"
      ? "该问题需要触发重建或补数据，无法在无人确认时安全自动修复。"
      : "该问题无法映射到确定性自动治理动作，需要人工判断。",
    recommendedAction: remediation.remediation || "打开对应资产或发布页，按建议修复后重新发布。",
    primaryAction: { label: target.label, type: target.type },
    target: { page: target.page, params: target.params },
    technicalIds: { componentId: remediation.targetComponentId || undefined, releaseId: remediation.releaseId },
    createdAt: remediation.createdAt,
  };
}

function remediationTarget(remediation: KnowledgeLintRemediation): {
  label: string;
  type: HumanException["primaryAction"]["type"];
  page: NonNullable<HumanException["target"]>["page"];
  params?: Record<string, string>;
} {
  if (remediation.targetComponentId) {
    return { label: "打开资产", type: "open_asset", page: "assets", params: { componentId: remediation.targetComponentId } };
  }
  if (remediation.actionType === "rebuild") {
    return { label: "去构建", type: "rerun", page: "builder", params: {} };
  }
  return { label: "去发布页", type: "open_asset", page: "release", params: { releaseId: remediation.releaseId } };
}

function lintDomainLabel(domain: KnowledgeLintRemediation["domain"]): string {
  switch (domain) {
    case "links": return "链接";
    case "evidence": return "证据";
    case "graph": return "图谱";
    case "trust": return "可信度";
    case "table_dependencies": return "表依赖";
    case "mcp_feedback": return "MCP 反馈";
    default: return domain;
  }
}

function clusterNegativeFeedback(events: AgentEvent[], highFrequencyThreshold = DEFAULT_HIGH_FREQUENCY_THRESHOLD): HumanException[] {
  const groups = new Map<string, { events: AgentEvent[]; normalized: string }>();
  for (const event of events) {
    if (!isNegativeFeedback(event)) continue;
    const normalized = normalizeQuery(event.query);
    const key = normalized || event.eventId;
    const group = groups.get(key) ?? { events: [], normalized };
    group.events.push(event);
    groups.set(key, group);
  }

  const out: HumanException[] = [];
  for (const [, group] of groups) {
    const head = group.events[0];
    if (!head) continue;
    const count = group.events.length;
    const isMiss = group.events.some((event) => event.status === "miss");
    // 只有高频或明确未命中才需要人工，避免例外中心被普通观察项淹没。
    if (!isMiss && count < highFrequencyThreshold) continue;
    const component = head.components[0];
    const title = head.query || "未解析查询";
    out.push({
      id: `feedback-${head.eventId}`,
      type: "feedback",
      attentionLevel: isMiss ? "needs_decision" : "watch",
      severity: isMiss ? "warning" : "info",
      title: isMiss ? `Agent 查询“${title}”未命中` : `Agent 查询“${title}”命中低质页面（${count} 次）`,
      body: head.suggestedAction || (component?.title ? `相关知识：${component.title}` : "Agent 反馈显示该知识需要补全或修正。"),
      whyHumanNeeded: isMiss
        ? "知识库缺少能回答该查询的内容，需要人确认是否补充资料或标注答案。"
        : "命中的知识可信度不足且反复出现，需要人判断是修正还是补证据。",
      recommendedAction: isMiss ? "复测该查询并确认是否需要补充资料或标注答案。" : "复测该查询，判断是修正命中知识还是补充证据。",
      primaryAction: { label: "复测查询", type: "rerun" },
      target: { page: "agent", params: { query: head.query } },
      technicalIds: { componentId: component?.componentId, eventId: head.eventId },
      createdAt: head.createdAt,
    });
  }
  return out;
}

function isNegativeFeedback(event: AgentEvent): boolean {
  return event.status === "miss" || event.feedbackType !== "hit" || event.qualityFlags.length > 0;
}

function clusterType(event: AgentEvent): FeedbackClusterType {
  if (event.status === "miss" || event.feedbackType === "miss" || event.feedbackType === "knowledge_gap" || event.feedbackType === "repeated_query") return "knowledge_gap";
  if (event.feedbackType === "bad_hit" || event.feedbackType === "relation_inference_failed") return "bad_hit";
  if (event.feedbackType === "stale_knowledge") return "stale_knowledge";
  if (event.feedbackType === "low_quality_hit" || event.feedbackType === "evidence_insufficient" || event.qualityFlags.length > 0) return "low_trust_hit";
  return "bad_hit";
}

function clusterTitle(type: FeedbackClusterType, queryExample: string, count: number, components: Array<{ title: string }>): string {
  const q = queryExample || "相关查询";
  const compName = components[0]?.title;
  switch (type) {
    case "knowledge_gap":
      return `“${q}”查询 ${count} 次，知识库缺少可命中内容`;
    case "bad_hit":
      return compName ? `“${q}”命中了不相关知识（${compName}）` : `“${q}”命中了不相关知识`;
    case "stale_knowledge":
      return compName ? `“${compName}”被反馈为过期或已失效` : `“${q}”命中知识被反馈为过期`;
    case "low_trust_hit":
      return compName ? `“${q}”命中低可信页面（${compName}，${count} 次）` : `“${q}”命中低可信页面（${count} 次）`;
    default:
      return `“${q}”反馈 ${count} 次`;
  }
}

function clusterRecommendedAction(type: FeedbackClusterType): string {
  switch (type) {
    case "knowledge_gap":
      return "补充对应 topic/page/table 或标注正确答案，重建发布后让 Agent 复测同一查询。";
    case "bad_hit":
      return "检查检索排序与标题/别名/索引，修订命中知识或表依赖后重新发布。";
    case "stale_knowledge":
      return "核对来源版本与最后可信审计，更新原始资料或知识资产后重建发布。";
    case "low_trust_hit":
      return "查看 Trust Score 明细，补证据/完整度/审计时效后重新发布。";
    default:
      return "复测该查询，判断需要修正还是补充知识。";
  }
}

function clusterPrimaryAction(type: FeedbackClusterType): AgentFeedbackCluster["primaryAction"] {
  if (type === "knowledge_gap") return { label: "复测查询", type: "rerun" };
  return { label: "标注正确答案", type: "annotate" };
}

function dedupeComponents(events: AgentEvent[]): Array<{ componentId: string; title: string }> {
  const seen = new Map<string, string>();
  for (const event of events) {
    for (const component of event.components) {
      if (!seen.has(component.componentId)) seen.set(component.componentId, component.title || humanizeComponent(component.componentId));
    }
    for (const id of event.hitComponentIds) {
      if (!seen.has(id)) seen.set(id, humanizeComponent(id));
    }
  }
  return [...seen.entries()].slice(0, 4).map(([componentId, title]) => ({ componentId, title }));
}

function stripToolPrefix(query: string): string {
  // feedbackQueryKey 形如 "kb_search:荣耀连战"，业务展示只留查询本身。
  const idx = query.indexOf(":");
  return (idx >= 0 ? query.slice(idx + 1) : query).trim();
}

function severityWeight(severity: ReviewSeverity): number {
  return severity === "blocking" ? 2 : severity === "warning" ? 1 : 0;
}

function slugKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "").slice(0, 48) || "cluster";
}

function attentionRank(item: HumanException): number {
  if (item.attentionLevel === "blocking") return 0;
  if (item.attentionLevel === "needs_decision") return 1;
  return 2;
}

function automationTitle(eventType: string, payload: Record<string, unknown>): string {
  const version = typeof payload.releaseVersion === "string" && payload.releaseVersion ? payload.releaseVersion : "";
  switch (eventType) {
    case "build.completed":
      return "知识构建完成";
    case "release.revision_proposed":
      return "已生成发布修订草案";
    case "release.auto_publish_succeeded":
      return version ? `已自动发布 ${version}` : "已自动发布新版本";
    case "release.auto_publish_skipped":
      return "自动发布被跳过（需人工确认）";
    case "agent.feedback.rebuild_proposed":
      return "已根据 Agent 反馈提议重建";
    case "agent.feedback.rebuild_started":
      return "已根据 Agent 反馈启动重建";
    case "annotation.writeback_requested":
      return "已请求把标注写回资料";
    case "annotation.writeback_rebuild_started":
      return "已根据标注启动重建";
    default:
      return eventType;
  }
}

function automationStatus(eventType: string): FlywheelAutomationItem["status"] {
  if (eventType === "release.auto_publish_skipped") return "skipped";
  if (eventType.endsWith("_started") || eventType.endsWith("_requested") || eventType.endsWith("_proposed")) return "running";
  return "completed";
}

function needsAttention(syncId: string, message: string): FlywheelSyncResult {
  return {
    syncId,
    status: "needs_attention",
    buildRunIds: [],
    packageIds: [],
    published: false,
    mode: "full",
    message,
    attentionItems: [],
    automationEvents: [],
  };
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/gu, " ");
}

function humanizeComponent(componentId: string): string {
  if (!componentId) return "未命名知识";
  const tail = componentId.split(/[\\/]/u).pop() ?? componentId;
  return tail.replace(/\.[^.]+$/u, "").replace(/^cmp_pkg_[a-z0-9]+_/u, "") || componentId;
}

function readJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return {};
}

function shanghaiDottedDate(): string {
  const now = new Date();
  const shanghai = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const y = shanghai.getUTCFullYear();
  const m = String(shanghai.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shanghai.getUTCDate()).padStart(2, "0");
  return `${y}.${m}.${d}`;
}

function startOfShanghaiDayIso(): string {
  const now = new Date();
  const shanghai = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const midnightShanghaiUtcMs = Date.UTC(shanghai.getUTCFullYear(), shanghai.getUTCMonth(), shanghai.getUTCDate()) - 8 * 60 * 60 * 1000;
  return new Date(midnightShanghaiUtcMs).toISOString();
}
