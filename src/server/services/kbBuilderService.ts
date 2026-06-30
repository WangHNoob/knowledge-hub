import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { nanoid } from "nanoid";

import type {
  AssetPackage,
  DatabaseHandle,
  KnowledgeBuildRun,
  PipelineStage,
  QualityGateConfig,
  QualityGateProfile,
  QualityFinding,
  KnowledgeRuleConfig,
  KnowledgeRuleProfile,
  SourceFileChange,
} from "../types";
import { createSourceBundleService } from "./sourceBundleService";
import { createKnowledgeService } from "./knowledgeService";
import { createLegislationService } from "./legislationService";
import { createTableAliasService } from "./tableAliasService";
import { materializeSourceVersion } from "./kbBuilder/materialize";
import { loadWikiSpecs } from "./kbBuilder/specs";
import { runConvertStage } from "./kbBuilder/convertStage";
import { runExtractStage, type PromptAnnotationExample } from "./kbBuilder/extractStage";
import { runTableStage } from "./kbBuilder/tableStage";
import { runGraphStage } from "./kbBuilder/graphStage";
import { runVizStage } from "./kbBuilder/vizStage";
import { evaluateQualityGate, type QualityRuleDismissal } from "./kbBuilder/qualityGate";
import { collectPipelineArtifacts } from "./kbBuilder/collector";
import { generateAliasDrafts, scanGamedataTableNames, writeAliasFile } from "./kbBuilder/aliasPrep";
import { createLlmClient } from "./kbBuilder/llmClient";
import type { BuildPipelineOptions, CollectedArtifact, QualityGateResult } from "./kbBuilder/types";
import { modelName, normalizeModelConfig, redactModelConfig, type PipelineModelConfig } from "./kbBuilder/modelConfig";
import type { DiagnosticLogger } from "./diagnosticService";
import { computeTrustScore } from "./trustScore";
import { emitKnowledgeEvent } from "./eventService";

/**
 * 生成 runId / packageId 里嵌入的紧凑时间戳，按东八区（Asia/Shanghai）墙钟时间。
 * 仅用于人类可读的标识符；DB 的 created_at 仍存 UTC（TIMESTAMPTZ）。
 */
function shanghaiStamp(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace(/[-:.TZ]/g, "");
}

const STAGE_ORDER: PipelineStage[] = ["convert", "extract", "tables", "graph", "viz"];
const TRACKED_STAGES: ReadonlySet<string> = new Set<string>(STAGE_ORDER);
const AUTO_EVIDENCE_COMPONENT_KINDS = new Set(["wiki_page"]);

interface FlywheelBuildSummary {
  annotationExamplesInjected: number;
  annotationOverridesInjected: number;
  annotationExampleRefs: Array<{
    exampleId: string;
    componentId: string;
    taskId: string;
    ruleId: string;
    applyMode: "hint" | "override";
    pageType: string;
    createdBy: string;
    createdAt: string;
    sourcePath: string;
    componentRef: string;
    valuePreview: string;
    influence: string;
  }>;
  activeRuleDismissals: number;
  appliedRuleDismissals: number;
  newAnnotationTasks: number;
  dismissedRules: Array<{ ruleId: string; componentRef: string }>;
}

export function createKbBuilderPipelineService(db: DatabaseHandle, dataDir: string, diagnostics?: DiagnosticLogger) {
  return new KbBuilderPipelineService(db, dataDir, diagnostics);
}

type SourceBundleService = ReturnType<typeof createSourceBundleService>;

interface ScopedRebuildTarget {
  componentId: string;
  sourceRefs: string[];
  legacyPath: string;
  sourceVersionIds: string[];
}

interface BuildRunContext {
  runId: string;
  options: BuildPipelineOptions;
  profile: QualityGateProfile;
  stages: PipelineStage[];
  workspaceRoot: string;
  sourceService: SourceBundleService;
  modelConfig: PipelineModelConfig;
  ruleProfile: KnowledgeRuleProfile;
  sourceChanges: SourceFileChange[];
}

export class KbBuilderPipelineService {
  private readonly adapter;

  constructor(private readonly db: DatabaseHandle, private readonly dataDir: string, private readonly diagnostics?: DiagnosticLogger) {
    this.adapter = db.adapter;
  }

  async startBuild(options: BuildPipelineOptions): Promise<KnowledgeBuildRun> {
    const context = await this.createRun(options);
    void this.executeRun(context).catch((error) => {
      void this.diagnostics?.write({
        traceId: context.options.traceId,
        level: "error",
        category: "kb_build",
        message: "background build failed",
        status: "failed",
        actor: context.options.requestedBy,
        entityType: "build_run",
        entityId: context.runId,
        runId: context.runId,
        error
      });
    });
    return this.requireRun(context.runId);
  }

  async build(options: BuildPipelineOptions): Promise<{ run: KnowledgeBuildRun; package: AssetPackage; qualitySummary: Record<string, unknown> }> {
    return this.executeRun(await this.createRun(options));
  }

  private async createRun(options: BuildPipelineOptions): Promise<BuildRunContext> {
    const sourceService = createSourceBundleService(this.db, this.dataDir);
    const version = await sourceService.getVersion(options.versionId);
    if (!version || version.bundleId !== options.bundleId) throw new Error(`Unknown source version: ${options.versionId}`);
    const profile = await this.getQualityProfile(options.qualityProfileId);
    const ruleProfile = await createLegislationService(this.db).getActiveProfile();
    const modelConfig = normalizeModelConfig(options.modelConfig, options.model);
    const sourceChanges = await sourceService.diff(options.versionId);
    const runId = `run_${shanghaiStamp()}_${nanoid(6)}`;
    const stages = STAGE_ORDER.filter((stage) => options.stages.includes(stage));
    const workspaceRoot = join(this.dataDir, "kb-build-runs");
    const now = new Date().toISOString();

    await this.insertRun({
      runId,
      sourceVersionId: options.versionId,
      packageId: null,
      adapter: "native",
      stages,
      model: modelName(modelConfig),
      wikiSpecsHash: "",
      qualityProfileId: profile.profileId,
      status: "running",
      currentStage: "",
      completedStages: [],
      startedAt: now,
      finishedAt: null,
      error: "",
      outputUri: "",
      config: {
        force: options.force,
        only: options.only,
        requestedBy: options.requestedBy,
        traceId: options.traceId,
        rebuildTaskId: options.rebuildTaskId,
        modelConfig: redactModelConfig(modelConfig),
        incremental: incrementalConfig(version.parentVersionId, sourceChanges),
        ruleProfile: {
          profileId: ruleProfile.profileId,
          name: ruleProfile.name,
          hash: ruleProfile.hash,
        },
      },
    });

    return { runId, options, profile, stages, workspaceRoot, sourceService, modelConfig, ruleProfile, sourceChanges };
  }

  private async executeRun(context: BuildRunContext): Promise<{ run: KnowledgeBuildRun; package: AssetPackage; qualitySummary: Record<string, unknown> }> {
    const { runId, options, profile, stages, workspaceRoot, sourceService, modelConfig, ruleProfile } = context;
    const runSpan = this.diagnostics?.startSpan({
      traceId: options.traceId,
      category: "kb_build",
      message: "knowledge build run",
      actor: options.requestedBy,
      entityType: "build_run",
      entityId: runId,
      runId,
      context: {
        bundleId: options.bundleId,
        versionId: options.versionId,
        stages,
        model: modelName(modelConfig),
        qualityProfileId: profile.profileId,
        ruleProfileId: ruleProfile.profileId,
        ruleProfileHash: ruleProfile.hash
      }
    });
    try {
      const workspace = await this.withStage(runId, options, "materialize", async () => materializeSourceVersion({
        db: this.db,
        sourceService,
        versionId: options.versionId,
        workspaceRoot,
        runId,
      }));
      const annotationExamples = await this.loadAnnotationExamplesForPrompt();
      const ruleDismissals = await this.loadActiveRuleDismissals();
      const specs = await this.withStage(runId, options, "specs", async () => {
        const specDir = ensureWikiSpecs(workspace.dataDir, ruleProfile.config);
        return loadWikiSpecs(specDir);
      });

      await this.ensureRunActive(runId);
      if (stages.includes("extract") || stages.includes("tables")) {
        await this.withStage(runId, options, "aliases", async () => this.prepareTableAliases(workspace.dataDir, modelConfig, options, runId));
      }
      await this.ensureRunActive(runId);
      if (stages.includes("convert")) await this.withStage(runId, options, "convert", async () => runConvertStage({ dataDir: workspace.dataDir, force: options.force, only: options.only }));
      await this.ensureRunActive(runId);
      if (stages.includes("extract")) await this.withStage(runId, options, "extract", async () => runExtractStage({
        dataDir: workspace.dataDir,
        specs,
        model: modelName(modelConfig),
        modelConfig,
        force: options.force,
        only: options.only,
        annotationExamples,
        onProgress: (info) => {
          void this.diagnostics?.write({
            traceId: options.traceId,
            category: "kb_build",
            status: "event",
            level: "info",
            message: info.message,
            actor: options.requestedBy,
            entityType: "build_run",
            entityId: runId,
            runId,
            context: { stage: "extract", index: info.index, total: info.total },
          });
        },
      }));
      await this.ensureRunActive(runId);
      if (stages.includes("tables")) await this.withStage(runId, options, "tables", async () => runTableStage({
        dataDir: workspace.dataDir,
        force: options.force,
        rules: ruleProfile.config,
        cacheRoot: join(this.dataDir, ".kh-cache", "tables"),
        changedPaths: context.sourceChanges.filter((change) => change.kind !== "removed").map((change) => change.logicalPath),
        removedPaths: context.sourceChanges.filter((change) => change.kind === "removed").map((change) => change.logicalPath),
      }));
      await this.ensureRunActive(runId);
      if (stages.includes("graph")) await this.withStage(runId, options, "graph", async () => runGraphStage({ dataDir: workspace.dataDir, rules: ruleProfile.config }));
      await this.ensureRunActive(runId);
      if (stages.includes("viz")) await this.withStage(runId, options, "viz", async () => runVizStage({ dataDir: workspace.dataDir }));
      await this.ensureRunActive(runId);

      const sourceLogicalPaths = new Set(workspace.files.map((file) => file.logicalPath));
      const quality = await this.withStage(runId, options, "quality", async () => {
        const result = evaluateQualityGate({ dataDir: workspace.dataDir, specs, sourceLogicalPaths, profile: mergeQualityRules(profile.config, ruleProfile.config), ruleDismissals });
        mkdirSync(join(workspace.dataDir, "wiki"), { recursive: true });
        writeFileSync(join(workspace.dataDir, "wiki", "quality_report.json"), `${JSON.stringify(result, null, 2)}\n`);
        return result;
      });
      const flywheelSummary = buildFlywheelSummary(annotationExamples, ruleDismissals, quality);

      const packageId = `pkg_${runId}`;
      const artifacts = await this.withStage(runId, options, "collect", async () => collectPipelineArtifacts(workspace.dataDir, workspace.workspaceDir, quality.componentQuality));
      const pkg = await this.withStage(runId, options, "persist", async () => {
        const inserted = await this.insertPackageAndArtifacts(packageId, runId, options.versionId, workspace.files.map((file) => file.logicalPath), artifacts, quality, ruleProfile, flywheelSummary);
        flywheelSummary.newAnnotationTasks = await this.insertReviewTasks(packageId, artifacts, quality.findings);
        await this.updateRunFlywheelSummary(runId, flywheelSummary);
        return inserted;
      });
      await this.completeRun(runId, packageId, specs.hash, workspace.workspaceDir);
      await runSpan?.complete({ packageId, artifactCount: artifacts.length, overallScore: quality.overallScore });
      await emitKnowledgeEvent(this.db, {
        eventType: "build.completed",
        entityType: "build_run",
        entityId: runId,
        payload: {
          runId,
          packageId,
          sourceVersionId: options.versionId,
          requestedBy: options.requestedBy,
          only: options.only,
          overallScore: quality.overallScore,
          blockingCount: quality.blockingCount,
          warningCount: quality.warningCount,
        },
      });
      return { run: await this.requireRun(runId), package: pkg, qualitySummary: pkg.qualitySummary };
    } catch (error) {
      await this.failRun(runId, error);
      await runSpan?.fail(error);
      throw error;
    }
  }

  private async withStage<T>(runId: string, options: BuildPipelineOptions, stage: string, fn: () => Promise<T> | T): Promise<T> {
    const tracked = TRACKED_STAGES.has(stage);
    if (tracked) await this.markStageStarted(runId, stage);
    const span = this.diagnostics?.startSpan({
      traceId: options.traceId,
      category: stage === "extract" && options.modelConfig?.provider === "openai-compatible" ? "llm" : "kb_build",
      message: `kb build stage ${stage}`,
      actor: options.requestedBy,
      entityType: "build_run",
      entityId: runId,
      runId,
      context: { stage, versionId: options.versionId }
    });
    try {
      const result = await fn();
      if (tracked) await this.markStageCompleted(runId, stage);
      await span?.complete({ stage });
      return result;
    } catch (error) {
      await span?.fail(error, { stage });
      throw error;
    }
  }

  private async markStageStarted(runId: string, stage: string): Promise<void> {
    await this.adapter.query(
      "UPDATE knowledge_build_runs SET current_stage = $2 WHERE run_id = $1 AND status = 'running'",
      [runId, stage],
    );
  }

  private async markStageCompleted(runId: string, stage: string): Promise<void> {
    const run = await this.getRun(runId);
    if (!run) return;
    const completedStages = Array.from(new Set([...run.completedStages, stage]));
    await this.adapter.query(
      "UPDATE knowledge_build_runs SET completed_stages = $2, current_stage = $3 WHERE run_id = $1 AND status = 'running'",
      [runId, JSON.stringify(completedStages), ""],
    );
  }

  async listRuns(): Promise<KnowledgeBuildRun[]> {
    const { rows } = await this.adapter.query("SELECT * FROM knowledge_build_runs ORDER BY started_at DESC");
    return rows.map(mapRun);
  }

  async getRun(runId: string): Promise<KnowledgeBuildRun | null> {
    const { rows } = await this.adapter.query("SELECT * FROM knowledge_build_runs WHERE run_id = $1", [runId]);
    return rows.length ? mapRun(rows[0]) : null;
  }

  async stopRun(runId: string, requestedBy: string): Promise<KnowledgeBuildRun> {
    const run = await this.getRun(runId);
    if (!run) throw new Error(`Unknown build run: ${runId}`);
    if (run.status !== "running") return run;
    await this.adapter.query(
      "UPDATE knowledge_build_runs SET status = $2, finished_at = $3, error = $4 WHERE run_id = $1 AND status = 'running'",
      [runId, "failed", new Date().toISOString(), `Stopped by ${requestedBy}`],
    );
    return this.requireRun(runId);
  }

  async deleteRun(runId: string): Promise<boolean> {
    const run = await this.getRun(runId);
    if (!run) throw new Error(`Unknown build run: ${runId}`);
    if (run.status === "running") throw new Error("Stop the running build before deleting it.");
    await this.adapter.query("DELETE FROM knowledge_build_runs WHERE run_id = $1", [runId]);
    return true;
  }

  async startRebuildFromReviewTask(taskId: string, requestedBy: string, traceId?: string): Promise<KnowledgeBuildRun> {
    const existing = await this.findExistingRebuildRun(taskId);
    if (existing) return existing;
    const { rows } = await this.adapter.query(
      `SELECT
         t.task_id,
         t.rule_id,
         t.status,
         c.component_id,
         c.source_refs,
         c.legacy_path,
         p.source_version_ids
       FROM review_tasks t
       JOIN asset_components c ON c.component_id = t.component_id
       JOIN asset_packages p ON p.package_id = t.package_id
       WHERE t.task_id = $1`,
      [taskId],
    );
    if (rows.length === 0) throw new Error(`Unknown review task: ${taskId}`);
    const row = rows[0];
    if (String(row.rule_id) !== "agent_feedback.rebuild_candidate") {
      throw new Error("Only agent feedback rebuild candidate tasks can start scoped rebuilds.");
    }
    if (String(row.status) !== "open") throw new Error("Only open rebuild candidate tasks can start scoped rebuilds.");

    const run = await this.startScopedRebuildForComponent({
      componentId: String(row.component_id),
      requestedBy,
      traceId,
      rebuildTaskId: taskId,
    });
    await this.adapter.query(
      `UPDATE review_tasks
       SET resolution_note = $2
       WHERE task_id = $1`,
      [taskId, `已启动 scoped rebuild: ${run.runId}${typeof run.config.only === "string" && run.config.only ? ` (${run.config.only})` : ""}`],
    );
    return run;
  }

  async startScopedRebuildForComponent(input: {
    componentId: string;
    requestedBy: string;
    traceId?: string;
    rebuildTaskId?: string;
    sourcePath?: string;
  }): Promise<KnowledgeBuildRun> {
    if (input.rebuildTaskId) {
      const existing = await this.findExistingRebuildRun(input.rebuildTaskId);
      if (existing) return existing;
    }
    const target = await this.findScopedRebuildTarget(input.componentId);
    const versionId = target.sourceVersionIds[0];
    if (!versionId) throw new Error("The owning package has no source version to rebuild from.");
    const version = await createSourceBundleService(this.db, this.dataDir).getVersion(versionId);
    if (!version) throw new Error(`Unknown source version: ${versionId}`);

    const only = scopedOnlyFilter([input.sourcePath ?? "", ...target.sourceRefs], target.legacyPath);
    const run = await this.startBuild({
      bundleId: version.bundleId,
      versionId,
      requestedBy: input.requestedBy,
      stages: STAGE_ORDER,
      model: "deterministic",
      modelConfig: { provider: "deterministic", model: "deterministic" },
      force: true,
      only,
      qualityProfileId: "default",
      traceId: input.traceId,
      rebuildTaskId: input.rebuildTaskId,
      generateAliases: false,
    });
    return run;
  }

  private async findScopedRebuildTarget(componentId: string): Promise<ScopedRebuildTarget> {
    const { rows } = await this.adapter.query(
      `SELECT
         c.component_id,
         c.source_refs,
         c.legacy_path,
         p.source_version_ids
       FROM asset_components c
       JOIN asset_packages p ON p.package_id = c.package_id
       WHERE c.component_id = $1`,
      [componentId],
    );
    if (rows.length === 0) throw new Error(`Unknown component: ${componentId}`);
    const row = rows[0];
    return {
      componentId: String(row.component_id),
      sourceRefs: jsonValue<string[]>(row.source_refs, []),
      legacyPath: String(row.legacy_path ?? ""),
      sourceVersionIds: jsonValue<string[]>(row.source_version_ids, []),
    };
  }

  private async findExistingRebuildRun(taskId: string): Promise<KnowledgeBuildRun | null> {
    const { rows } = await this.adapter.query(
      `SELECT *
       FROM knowledge_build_runs
       WHERE config_json ->> 'rebuildTaskId' = $1
         AND status IN ('running', 'completed')
       ORDER BY started_at DESC
       LIMIT 1`,
      [taskId],
    );
    return rows.length ? mapRun(rows[0]) : null;
  }

  async getActiveQualityProfile(): Promise<QualityGateProfile> {
    const { rows } = await this.adapter.query("SELECT * FROM quality_gate_profiles WHERE active = true ORDER BY updated_at DESC LIMIT 1");
    if (!rows.length) throw new Error("No active quality gate profile.");
    return mapProfile(rows[0]);
  }

  async updateActiveQualityProfile(config: QualityGateConfig, user: string): Promise<QualityGateProfile> {
    const now = new Date().toISOString();
    await this.adapter.query("BEGIN");
    try {
      await this.adapter.query("UPDATE quality_gate_profiles SET active = false WHERE active = true");
      await this.adapter.query(
        `INSERT INTO quality_gate_profiles (profile_id, name, active, config_json, created_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (profile_id) DO UPDATE SET active = EXCLUDED.active, config_json = EXCLUDED.config_json, created_by = EXCLUDED.created_by, updated_at = EXCLUDED.updated_at`,
        ["default", "默认知识质量门禁", true, JSON.stringify(config), user, now],
      );
      await this.adapter.query("COMMIT");
    } catch (error) {
      await this.adapter.query("ROLLBACK");
      throw error;
    }
    return this.getActiveQualityProfile();
  }

  private async getQualityProfile(profileId: string): Promise<QualityGateProfile> {
    if (profileId === "default") return this.getActiveQualityProfile();
    const { rows } = await this.adapter.query("SELECT * FROM quality_gate_profiles WHERE profile_id = $1", [profileId]);
    if (!rows.length) throw new Error(`Unknown quality profile: ${profileId}`);
    return mapProfile(rows[0]);
  }

  private async insertRun(run: KnowledgeBuildRun): Promise<void> {
    await this.adapter.query(
      `INSERT INTO knowledge_build_runs
        (run_id, source_version_id, package_id, adapter, stages, model, wiki_specs_hash, quality_profile_id, status, current_stage, completed_stages, started_at, finished_at, error, output_uri, config_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        run.runId, run.sourceVersionId, run.packageId, run.adapter, JSON.stringify(run.stages), run.model,
        run.wikiSpecsHash, run.qualityProfileId, run.status, run.currentStage, JSON.stringify(run.completedStages),
        run.startedAt, run.finishedAt, run.error, run.outputUri, JSON.stringify(run.config),
      ],
    );
  }

  private async completeRun(runId: string, packageId: string, wikiSpecsHash: string, outputUri: string): Promise<void> {
    await this.adapter.query(
      "UPDATE knowledge_build_runs SET package_id = $2, status = $3, finished_at = $4, wiki_specs_hash = $5, output_uri = $6, current_stage = $7 WHERE run_id = $1 AND status = 'running'",
      [runId, packageId, "completed", new Date().toISOString(), wikiSpecsHash, outputUri, ""],
    );
  }

  private async failRun(runId: string, error: unknown): Promise<void> {
    await this.adapter.query(
      "UPDATE knowledge_build_runs SET status = $2, finished_at = $3, error = $4 WHERE run_id = $1 AND status = 'running'",
      [runId, "failed", new Date().toISOString(), error instanceof Error ? error.message : String(error)],
    );
  }

  private async ensureRunActive(runId: string): Promise<void> {
    const run = await this.requireRun(runId);
    if (run.status !== "running") throw new Error(run.error || `Build run ${runId} is no longer running.`);
  }

  /**
   * Exports the curated persistent table-alias store into the run workspace so the
   * extract/table stages resolve names. Normal builds are read-only for the alias
   * store; they only write the per-run table_aliases.json snapshot. The optional
   * generateAliases mode is an explicit maintenance action that may seed LLM drafts.
   */
  private async prepareTableAliases(
    dataDir: string,
    modelConfig: PipelineModelConfig,
    options: BuildPipelineOptions,
    runId: string
  ): Promise<{ tables: number; drafted: number }> {
    const aliasService = createTableAliasService(this.db);

    let drafted = 0;
    let tables = 0;
    // Only enumerate every gamedata table and write alias drafts when explicitly asked.
    // Normal builds only inject the curated aliases (e.g. an imported cn_en_map) so the
    // translation table stays stable instead of ballooning to thousands of empty rows.
    const client = options.generateAliases ? createLlmClient(modelConfig) : null;
    if (options.generateAliases) {
      const names = scanGamedataTableNames(dataDir);
      tables = names.length;
      await aliasService.ensureTables(names);
      if (client) {
      const missing = (await aliasService.listMissing()).filter((name) => names.includes(name));
      if (missing.length > 0) {
        const drafts = await generateAliasDrafts(client, missing, {
          onProgress: (done, total) => {
            void this.diagnostics?.write({
              traceId: options.traceId,
              category: "kb_build",
              status: "event",
              level: "info",
              message: `生成表别名初稿 ${done}/${total}`,
              actor: options.requestedBy,
              entityType: "build_run",
              entityId: runId,
              runId,
              context: { stage: "aliases", done, total }
            });
          },
          onWarn: (message) => {
            void this.diagnostics?.write({
              traceId: options.traceId,
              category: "kb_build",
              status: "event",
              level: "warn",
              message,
              actor: options.requestedBy,
              entityType: "build_run",
              entityId: runId,
              runId,
              context: { stage: "aliases" }
            });
          }
        });
        if (drafts.length > 0) await aliasService.upsertMany(drafts, "llm", "llm");
        drafted = drafts.length;
      }
      }
    }

    writeAliasFile(dataDir, await aliasService.exportRows());
    return { tables, drafted };
  }

  private async insertPackageAndArtifacts(
    packageId: string,
    runId: string,
    versionId: string,
    sourceRefs: string[],
    artifacts: CollectedArtifact[],
    quality: QualityGateResult,
    ruleProfile: KnowledgeRuleProfile,
    flywheelSummary: FlywheelBuildSummary,
  ): Promise<AssetPackage> {
    const now = new Date().toISOString();
    const qualitySummary = {
      overallScore: quality.overallScore,
      blockingCount: quality.blockingCount,
      warningCount: quality.warningCount,
      legislationProfile: {
        profileId: ruleProfile.profileId,
        hash: ruleProfile.hash,
      },
      flywheel: flywheelSummary,
    };

    await this.adapter.query("BEGIN");
    try {
      await this.adapter.query(
        `INSERT INTO asset_packages
          (package_id, name, kind, status, description, created_by_run_id, source_version_ids, legacy_paths, quality_summary, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          packageId,
          `知识库构建：${versionId}`,
          "kb_builder_pipeline",
          "draft",
          "由原生 kb-builder pipeline 生成的知识资产包。",
          runId,
          JSON.stringify([versionId]),
          JSON.stringify(["processed", "wiki", "table_schemas"]),
          JSON.stringify(qualitySummary),
          now,
        ],
      );

      const componentRows: Array<{ componentId: string; artifact: CollectedArtifact; sourceRefs: string[] }> = [];
      for (const artifact of artifacts) {
        const componentId = componentIdFor(packageId, artifact.legacyPath);
        const componentSourceRefs = artifact.sourceRefs.length ? artifact.sourceRefs : sourceRefs;
        const componentQuality: Record<string, unknown> = {
          ...artifact.quality,
          legislationProfile: {
            profileId: ruleProfile.profileId,
            hash: ruleProfile.hash,
          },
        };
        componentQuality.trust = computeTrustScore({
          component: {
            artifactId: artifact.artifactId,
            kind: artifact.kind,
            legacyPath: artifact.legacyPath,
            quality: componentQuality,
            sourceRefs: componentSourceRefs,
          },
          now,
        });
        await this.adapter.query(
          `INSERT INTO asset_components
            (component_id, package_id, artifact_id, group_name, kind, title, status, legacy_path, storage_uri, source_refs, quality)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            componentId,
            packageId,
            artifact.artifactId,
            artifact.group,
            artifact.kind,
            artifact.title,
            "draft",
            artifact.legacyPath,
            artifact.storageUri,
            JSON.stringify(componentSourceRefs),
            JSON.stringify(componentQuality),
          ],
        );
        componentRows.push({ componentId, artifact, sourceRefs: componentSourceRefs });
      }
      await this.insertAutomaticEvidence(packageId, versionId, componentRows, now);
      await this.adapter.query("COMMIT");
    } catch (error) {
      await this.adapter.query("ROLLBACK");
      throw error;
    }

    return this.requirePackage(packageId);
  }

  private async insertAutomaticEvidence(
    packageId: string,
    versionId: string,
    components: Array<{ componentId: string; artifact: CollectedArtifact; sourceRefs: string[] }>,
    now: string,
  ): Promise<void> {
    for (const { componentId, artifact, sourceRefs } of components) {
      if (!AUTO_EVIDENCE_COMPONENT_KINDS.has(artifact.kind)) continue;
      const refs = sourceRefs.length > 0 ? sourceRefs : ["source bundle"];
      for (const sourceRef of refs.slice(0, 3)) {
        const digest = createHash("sha1").update(`${componentId}:${sourceRef}`).digest("hex").slice(0, 10);
        await this.adapter.query(
          `INSERT INTO evidence_records
             (evidence_id, package_id, component_id, source_version_id, quote, note, confidence, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (evidence_id) DO NOTHING`,
          [
            `ev_${slug(componentId)}_${digest}`,
            packageId,
            componentId,
            versionId,
            `Generated from source reference: ${sourceRef}`,
            `Auto-linked during kb-builder persist stage for ${artifact.legacyPath}.`,
            0.72,
            now,
          ],
        );
      }
    }
  }

  private async insertReviewTasks(packageId: string, artifacts: CollectedArtifact[], findings: QualityFinding[]): Promise<number> {
    const qualityReport = artifacts.find((artifact) => artifact.kind === "quality_report") ?? artifacts[0];
    let inserted = 0;
    for (const finding of findings) {
      const artifact = artifacts.find((item) => item.legacyPath === finding.componentId) ?? qualityReport;
      if (!artifact) continue;
      await this.adapter.query(
        `INSERT INTO review_tasks (
           task_id, package_id, component_id, severity, status, task_kind, rule_id,
           title, description, suggested_action, candidates, confidence, context_snapshot, created_at
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          `task_${slug(packageId)}_${slug(finding.ruleId)}_${nanoid(6)}`,
          packageId,
          componentIdFor(packageId, artifact.legacyPath),
          finding.severity,
          "open",
          "annotation",
          finding.ruleId,
          finding.title,
          finding.description,
          finding.suggestedAction,
          JSON.stringify(reviewTaskCandidates(finding)),
          Math.max(0, Math.min(1, 1 - finding.scoreImpact)),
          JSON.stringify({
            ruleId: finding.ruleId,
            componentRef: finding.componentId ?? artifact.legacyPath,
            artifactLegacyPath: artifact.legacyPath,
            title: finding.title,
            description: finding.description,
          }),
          new Date().toISOString(),
        ],
      );
      inserted += 1;
    }
    return inserted;
  }

  private async loadAnnotationExamplesForPrompt(limit = 12): Promise<PromptAnnotationExample[]> {
    const { rows } = await this.adapter.query(
      `SELECT example_id, component_id, task_id, apply_mode, page_type, rule_id, context_snapshot, correct_value, created_by, created_at
       FROM annotation_examples
       WHERE active = true
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit],
    );
    return rows.map((row) => ({
      exampleId: String(row.example_id ?? ""),
      componentId: String(row.component_id ?? ""),
      taskId: String(row.task_id ?? ""),
      createdBy: String(row.created_by ?? ""),
      createdAt: row.created_at ? String(row.created_at) : "",
      applyMode: row.apply_mode === "override" ? "override" : "hint",
      pageType: String(row.page_type ?? ""),
      ruleId: String(row.rule_id ?? ""),
      contextSnapshot: jsonValue<Record<string, unknown>>(row.context_snapshot, {}),
      correctValue: jsonValue<Record<string, unknown>>(row.correct_value, {}),
    }));
  }

  private async loadActiveRuleDismissals(): Promise<QualityRuleDismissal[]> {
    const { rows } = await this.adapter.query(
      `SELECT component_id, component_ref, rule_id
       FROM rule_dismissals
       WHERE active = true`
    );
    return rows.map((row) => ({
      componentId: String(row.component_id ?? ""),
      componentRef: String(row.component_ref ?? ""),
      ruleId: String(row.rule_id ?? ""),
    }));
  }

  private async updateRunFlywheelSummary(runId: string, flywheelSummary: FlywheelBuildSummary): Promise<void> {
    const run = await this.requireRun(runId);
    await this.adapter.query(
      "UPDATE knowledge_build_runs SET config_json = $2 WHERE run_id = $1",
      [runId, JSON.stringify({ ...run.config, flywheel: flywheelSummary })],
    );
  }

  private async requireRun(runId: string): Promise<KnowledgeBuildRun> {
    const run = await this.getRun(runId);
    if (!run) throw new Error(`Unknown build run: ${runId}`);
    return run;
  }

  private async requirePackage(packageId: string): Promise<AssetPackage> {
    const detail = await createKnowledgeService(this.db).getPackageDetail(packageId);
    return detail.package;
  }
}

function incrementalConfig(parentVersionId: string | null, changes: SourceFileChange[]): Record<string, unknown> {
  const addedPaths = changes.filter((change) => change.kind === "added").map((change) => change.logicalPath).sort();
  const modifiedPaths = changes.filter((change) => change.kind === "modified").map((change) => change.logicalPath).sort();
  const removedPaths = changes.filter((change) => change.kind === "removed").map((change) => change.logicalPath).sort();
  return {
    parentVersionId,
    changedPaths: [...addedPaths, ...modifiedPaths, ...removedPaths].sort(),
    addedPaths,
    modifiedPaths,
    removedPaths,
  };
}

function ensureWikiSpecs(dataDir: string, rules?: KnowledgeRuleConfig): string {
  const specDir = join(dataDir, "processed", "wiki_specs");
  if (rules) {
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, "manifest.json"), JSON.stringify({
      page_types: Object.fromEntries(Object.entries(rules.pageTypes).map(([id, spec]) => [id, { dir: spec.dir, template: spec.template }])),
      entity_types: rules.entityTypes.map((item) => item.id),
      relation_types: rules.relationTypes.map((item) => item.id),
    }, null, 2));
    for (const [id, spec] of Object.entries(rules.pageTypes)) {
      writeFileSync(join(specDir, spec.template || `${id}.md`), renderRuleSpecTemplate(spec.requiredSections, spec.requiredFacts));
    }
    return specDir;
  }
  if (existsSync(join(specDir, "manifest.json"))) return specDir;
  mkdirSync(specDir, { recursive: true });
  writeFileSync(join(specDir, "manifest.json"), JSON.stringify({
    page_types: {
      system: { dir: "systems", template: "system_rule.md" },
      concept: { dir: "concepts", template: "concept.md" },
      table: { dir: "tables", template: "table_schema.md" },
    },
    entity_types: ["system", "activity", "table", "resource", "attribute", "concept", "ui_element", "progression", "field"],
    relation_types: ["depends_on", "unlocks", "configured_in", "configured_by_field", "produces", "consumes", "belongs_to", "references", "has_field", "fk_to"],
  }, null, 2));
  writeFileSync(join(specDir, "system_rule.md"), "## Overview\n## Data Dependencies\n| key | required |\n| --- | --- |\n| config_table | yes |\n");
  writeFileSync(join(specDir, "concept.md"), "## Overview\n");
  writeFileSync(join(specDir, "table_schema.md"), "## Overview\n");
  return specDir;
}

function renderRuleSpecTemplate(requiredSections: string[], requiredFacts: string[]): string {
  const sections = requiredSections.length ? requiredSections : ["Overview"];
  const lines = sections.map((section) => `## ${section}`);
  if (requiredFacts.length > 0) {
    lines.push("", "## Data Dependencies", "| key | required |", "| --- | --- |", ...requiredFacts.map((fact) => `| ${fact} | yes |`));
  }
  return `${lines.join("\n")}\n`;
}

function mergeQualityRules(profile: QualityGateConfig, rules: KnowledgeRuleConfig): QualityGateConfig {
  return {
    minPackageScore: profile.minPackageScore,
    rules: {
      ...profile.rules,
      ...rules.qualityRules,
    },
  };
}

function componentIdFor(packageId: string, legacyPath: string): string {
  // slug() drops every non-[a-z0-9] char, so distinct non-ASCII paths (e.g.
  // Chinese filenames like "阵法特权.md") collapse to the same slug and collide
  // on asset_components_pkey. Append a hash of the raw path to keep the id
  // readable but unique per legacyPath.
  const digest = createHash("sha1").update(legacyPath).digest("hex").slice(0, 10);
  return `cmp_${slug(packageId)}_${slug(legacyPath)}_${digest}`;
}

function mapRun(row: Record<string, unknown>): KnowledgeBuildRun {
  return {
    runId: row.run_id as string,
    sourceVersionId: row.source_version_id as string,
    packageId: row.package_id as string | null,
    adapter: "native",
    stages: jsonValue<PipelineStage[]>(row.stages, []),
    model: row.model as string,
    wikiSpecsHash: row.wiki_specs_hash as string,
    qualityProfileId: row.quality_profile_id as string,
    status: row.status as KnowledgeBuildRun["status"],
    currentStage: (row.current_stage as string) ?? "",
    completedStages: jsonValue<string[]>(row.completed_stages, []),
    startedAt: String(row.started_at),
    finishedAt: row.finished_at ? String(row.finished_at) : null,
    error: row.error as string,
    outputUri: row.output_uri as string,
    config: jsonValue<Record<string, unknown>>(row.config_json, {}),
  };
}

function mapProfile(row: Record<string, unknown>): QualityGateProfile {
  return {
    profileId: row.profile_id as string,
    name: row.name as string,
    active: Boolean(row.active),
    config: jsonValue<QualityGateConfig>(row.config_json, { minPackageScore: 0.75, rules: {} }),
    createdBy: row.created_by as string,
    updatedAt: String(row.updated_at),
  };
}

function jsonValue<T>(value: unknown, fallback: T): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return (value ?? fallback) as T;
}

function reviewTaskCandidates(finding: QualityFinding): Array<{ id: string; label: string; value: Record<string, unknown>; confidence: number; rationale: string }> {
  return [{
    id: "apply_suggested_action",
    label: "按建议修复",
    value: {
      ruleId: finding.ruleId,
      action: finding.suggestedAction,
      componentRef: finding.componentId ?? "",
    },
    confidence: Math.max(0, Math.min(1, 1 - finding.scoreImpact)),
    rationale: finding.description,
  }];
}

function buildFlywheelSummary(
  annotationExamples: PromptAnnotationExample[],
  ruleDismissals: QualityRuleDismissal[],
  quality: QualityGateResult,
): FlywheelBuildSummary {
  return {
    annotationExamplesInjected: annotationExamples.length,
    annotationOverridesInjected: annotationExamples.filter((example) => example.applyMode === "override").length,
    annotationExampleRefs: annotationExamples.map((example) => ({
      exampleId: example.exampleId ?? "",
      componentId: example.componentId ?? "",
      taskId: example.taskId ?? "",
      ruleId: example.ruleId,
      applyMode: example.applyMode ?? "hint",
      pageType: example.pageType,
      createdBy: example.createdBy ?? "",
      createdAt: example.createdAt ?? "",
      sourcePath: annotationExampleSourcePath(example),
      componentRef: annotationExampleComponentRef(example),
      valuePreview: compactJson(example.correctValue),
      influence: annotationExampleInfluence(example),
    })),
    activeRuleDismissals: ruleDismissals.length,
    appliedRuleDismissals: quality.dismissedRules?.length ?? 0,
    newAnnotationTasks: quality.findings.length,
    dismissedRules: quality.dismissedRules ?? [],
  };
}

function annotationExampleSourcePath(example: PromptAnnotationExample): string {
  return stringValue(example.contextSnapshot.sourceFile)
    || stringValue(example.contextSnapshot.sourcePath)
    || stringValue(example.contextSnapshot.componentRef)
    || stringValue(example.contextSnapshot.artifactLegacyPath);
}

function annotationExampleComponentRef(example: PromptAnnotationExample): string {
  return stringValue(example.contextSnapshot.componentRef)
    || stringValue(example.contextSnapshot.artifactLegacyPath)
    || example.componentId
    || "";
}

function annotationExampleInfluence(example: PromptAnnotationExample): string {
  const mode = example.applyMode === "override" ? "确定性覆盖" : "提示样例";
  const action = overrideActionLabel(example.correctValue);
  return action ? `${mode} · ${action}` : mode;
}

function overrideActionLabel(value: Record<string, unknown>): string {
  const raw = jsonValue<Record<string, unknown>>(value.override, value);
  if (typeof raw.setType === "string") return `设置类型 ${raw.setType}`;
  if (typeof raw.setTitle === "string") return "设置标题";
  if (raw.setFacts && typeof raw.setFacts === "object") return `补 facts ${Object.keys(raw.setFacts).join(", ")}`;
  if (Array.isArray(raw.removeFacts)) return `移除 facts ${raw.removeFacts.join(", ")}`;
  if (raw.replaceSection && typeof raw.replaceSection === "object") return "替换章节";
  if (typeof raw.replaceBody === "string") return "替换正文";
  if (typeof raw.value === "string") return "补字段值";
  return "";
}

function compactJson(value: unknown): string {
  const text = JSON.stringify(value ?? {});
  return text.length > 220 ? `${text.slice(0, 217)}...` : text;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function scopedOnlyFilter(sourceRefs: string[], legacyPath: string): string | null {
  const sourceRef = sourceRefs.find((ref) => ref.startsWith("gamedocs/") || ref.startsWith("gamedata/"));
  if (sourceRef) return sourceRef;
  if (legacyPath.startsWith("gamedocs/") || legacyPath.startsWith("gamedata/")) return legacyPath;
  return null;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "item";
}
