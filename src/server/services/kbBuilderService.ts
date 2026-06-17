import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
} from "../types";
import { createSourceBundleService } from "./sourceBundleService";
import { createKnowledgeService } from "./knowledgeService";
import { createLegislationService } from "./legislationService";
import { materializeSourceVersion } from "./kbBuilder/materialize";
import { loadWikiSpecs } from "./kbBuilder/specs";
import { runConvertStage } from "./kbBuilder/convertStage";
import { runExtractStage } from "./kbBuilder/extractStage";
import { runTableStage } from "./kbBuilder/tableStage";
import { runGraphStage } from "./kbBuilder/graphStage";
import { runVizStage } from "./kbBuilder/vizStage";
import { evaluateQualityGate } from "./kbBuilder/qualityGate";
import { collectPipelineArtifacts } from "./kbBuilder/collector";
import type { BuildPipelineOptions, CollectedArtifact, QualityGateResult } from "./kbBuilder/types";
import { modelName, normalizeModelConfig, redactModelConfig, type PipelineModelConfig } from "./kbBuilder/modelConfig";
import type { DiagnosticLogger } from "./diagnosticService";

const STAGE_ORDER: PipelineStage[] = ["convert", "extract", "tables", "graph", "viz"];
const TRACKED_STAGES: ReadonlySet<string> = new Set<string>(STAGE_ORDER);

export function createKbBuilderPipelineService(db: DatabaseHandle, dataDir: string, diagnostics?: DiagnosticLogger) {
  return new KbBuilderPipelineService(db, dataDir, diagnostics);
}

type SourceBundleService = ReturnType<typeof createSourceBundleService>;

interface BuildRunContext {
  runId: string;
  options: BuildPipelineOptions;
  profile: QualityGateProfile;
  stages: PipelineStage[];
  workspaceRoot: string;
  sourceService: SourceBundleService;
  modelConfig: PipelineModelConfig;
  ruleProfile: KnowledgeRuleProfile;
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
    const runId = `run_${new Date().toISOString().replace(/[-:.TZ]/g, "")}_${nanoid(6)}`;
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
        modelConfig: redactModelConfig(modelConfig),
        ruleProfile: {
          profileId: ruleProfile.profileId,
          name: ruleProfile.name,
          hash: ruleProfile.hash,
        },
      },
    });

    return { runId, options, profile, stages, workspaceRoot, sourceService, modelConfig, ruleProfile };
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
      const specs = await this.withStage(runId, options, "specs", async () => {
        const specDir = ensureWikiSpecs(workspace.dataDir, ruleProfile.config);
        return loadWikiSpecs(specDir);
      });

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
      if (stages.includes("tables")) await this.withStage(runId, options, "tables", async () => runTableStage({ dataDir: workspace.dataDir, force: options.force, rules: ruleProfile.config }));
      await this.ensureRunActive(runId);
      if (stages.includes("graph")) await this.withStage(runId, options, "graph", async () => runGraphStage({ dataDir: workspace.dataDir, rules: ruleProfile.config }));
      await this.ensureRunActive(runId);
      if (stages.includes("viz")) await this.withStage(runId, options, "viz", async () => runVizStage({ dataDir: workspace.dataDir }));
      await this.ensureRunActive(runId);

      const sourceLogicalPaths = new Set(workspace.files.map((file) => file.logicalPath));
      const quality = await this.withStage(runId, options, "quality", async () => {
        const result = evaluateQualityGate({ dataDir: workspace.dataDir, specs, sourceLogicalPaths, profile: mergeQualityRules(profile.config, ruleProfile.config) });
        mkdirSync(join(workspace.dataDir, "wiki"), { recursive: true });
        writeFileSync(join(workspace.dataDir, "wiki", "quality_report.json"), `${JSON.stringify(result, null, 2)}\n`);
        return result;
      });

      const packageId = `pkg_${runId}`;
      const artifacts = await this.withStage(runId, options, "collect", async () => collectPipelineArtifacts(workspace.dataDir, workspace.workspaceDir, quality.componentQuality));
      const pkg = await this.withStage(runId, options, "persist", async () => {
        const inserted = await this.insertPackageAndArtifacts(packageId, runId, options.versionId, workspace.files.map((file) => file.logicalPath), artifacts, quality, ruleProfile);
        await this.completeRun(runId, packageId, specs.hash, workspace.workspaceDir);
        await this.insertReviewTasks(packageId, artifacts, quality.findings);
        return inserted;
      });
      await runSpan?.complete({ packageId, artifactCount: artifacts.length, overallScore: quality.overallScore });
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

  private async insertPackageAndArtifacts(
    packageId: string,
    runId: string,
    versionId: string,
    sourceRefs: string[],
    artifacts: CollectedArtifact[],
    quality: QualityGateResult,
    ruleProfile: KnowledgeRuleProfile,
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

      for (const artifact of artifacts) {
        const componentId = `cmp_${slug(packageId)}_${slug(artifact.legacyPath)}`;
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
            JSON.stringify(artifact.sourceRefs.length ? artifact.sourceRefs : sourceRefs),
            JSON.stringify({
              ...artifact.quality,
              legislationProfile: {
                profileId: ruleProfile.profileId,
                hash: ruleProfile.hash,
              },
            }),
          ],
        );
      }
      await this.adapter.query("COMMIT");
    } catch (error) {
      await this.adapter.query("ROLLBACK");
      throw error;
    }

    return this.requirePackage(packageId);
  }

  private async insertReviewTasks(packageId: string, artifacts: CollectedArtifact[], findings: QualityFinding[]): Promise<void> {
    const qualityReport = artifacts.find((artifact) => artifact.kind === "quality_report") ?? artifacts[0];
    for (const finding of findings) {
      const artifact = artifacts.find((item) => item.legacyPath === finding.componentId) ?? qualityReport;
      if (!artifact) continue;
      await this.adapter.query(
        `INSERT INTO review_tasks (task_id, package_id, component_id, severity, status, title, description, suggested_action, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          `task_${slug(packageId)}_${slug(finding.ruleId)}_${nanoid(6)}`,
          packageId,
          componentIdFor(packageId, artifact.legacyPath),
          finding.severity,
          "open",
          finding.title,
          finding.description,
          finding.suggestedAction,
          new Date().toISOString(),
        ],
      );
    }
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
  return `cmp_${slug(packageId)}_${slug(legacyPath)}`;
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

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "item";
}
