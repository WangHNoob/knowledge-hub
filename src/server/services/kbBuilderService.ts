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
} from "../types";
import { createSourceBundleService } from "./sourceBundleService";
import { createKnowledgeService } from "./knowledgeService";
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

const STAGE_ORDER: PipelineStage[] = ["convert", "extract", "tables", "graph", "viz"];

export function createKbBuilderPipelineService(db: DatabaseHandle, dataDir: string) {
  return new KbBuilderPipelineService(db, dataDir);
}

export class KbBuilderPipelineService {
  private readonly adapter;

  constructor(private readonly db: DatabaseHandle, private readonly dataDir: string) {
    this.adapter = db.adapter;
  }

  async build(options: BuildPipelineOptions): Promise<{ run: KnowledgeBuildRun; package: AssetPackage; qualitySummary: Record<string, unknown> }> {
    const sourceService = createSourceBundleService(this.db, this.dataDir);
    const version = await sourceService.getVersion(options.versionId);
    if (!version || version.bundleId !== options.bundleId) throw new Error(`Unknown source version: ${options.versionId}`);
    const profile = await this.getQualityProfile(options.qualityProfileId);
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
      model: options.model,
      wikiSpecsHash: "",
      qualityProfileId: profile.profileId,
      status: "running",
      startedAt: now,
      finishedAt: null,
      error: "",
      outputUri: "",
      config: { force: options.force, only: options.only, requestedBy: options.requestedBy },
    });

    try {
      const workspace = await materializeSourceVersion({
        db: this.db,
        sourceService,
        versionId: options.versionId,
        workspaceRoot,
        runId,
      });
      const specDir = ensureWikiSpecs(workspace.dataDir);
      const specs = loadWikiSpecs(specDir);

      if (stages.includes("convert")) await runConvertStage({ dataDir: workspace.dataDir, force: options.force, only: options.only });
      if (stages.includes("extract")) await runExtractStage({ dataDir: workspace.dataDir, specs, model: options.model, force: options.force, only: options.only });
      if (stages.includes("tables")) await runTableStage({ dataDir: workspace.dataDir, force: options.force });
      if (stages.includes("graph")) await runGraphStage({ dataDir: workspace.dataDir });
      if (stages.includes("viz")) await runVizStage({ dataDir: workspace.dataDir });

      const sourceLogicalPaths = new Set(workspace.files.map((file) => file.logicalPath));
      const quality = evaluateQualityGate({ dataDir: workspace.dataDir, specs, sourceLogicalPaths, profile: profile.config });
      mkdirSync(join(workspace.dataDir, "wiki"), { recursive: true });
      writeFileSync(join(workspace.dataDir, "wiki", "quality_report.json"), `${JSON.stringify(quality, null, 2)}\n`);

      const packageId = `pkg_${runId}`;
      const artifacts = collectPipelineArtifacts(workspace.dataDir, workspace.workspaceDir, quality.componentQuality);
      const pkg = await this.insertPackageAndArtifacts(packageId, runId, options.versionId, workspace.files.map((file) => file.logicalPath), artifacts, quality);
      await this.completeRun(runId, packageId, specs.hash, workspace.workspaceDir);
      await this.insertReviewTasks(packageId, artifacts, quality.findings);
      return { run: await this.requireRun(runId), package: pkg, qualitySummary: pkg.qualitySummary };
    } catch (error) {
      await this.failRun(runId, error);
      throw error;
    }
  }

  async listRuns(): Promise<KnowledgeBuildRun[]> {
    const { rows } = await this.adapter.query("SELECT * FROM knowledge_build_runs ORDER BY started_at DESC");
    return rows.map(mapRun);
  }

  async getRun(runId: string): Promise<KnowledgeBuildRun | null> {
    const { rows } = await this.adapter.query("SELECT * FROM knowledge_build_runs WHERE run_id = $1", [runId]);
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
        (run_id, source_version_id, package_id, adapter, stages, model, wiki_specs_hash, quality_profile_id, status, started_at, finished_at, error, output_uri, config_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        run.runId, run.sourceVersionId, run.packageId, run.adapter, JSON.stringify(run.stages), run.model,
        run.wikiSpecsHash, run.qualityProfileId, run.status, run.startedAt, run.finishedAt, run.error,
        run.outputUri, JSON.stringify(run.config),
      ],
    );
  }

  private async completeRun(runId: string, packageId: string, wikiSpecsHash: string, outputUri: string): Promise<void> {
    await this.adapter.query(
      "UPDATE knowledge_build_runs SET package_id = $2, status = $3, finished_at = $4, wiki_specs_hash = $5, output_uri = $6 WHERE run_id = $1",
      [runId, packageId, "completed", new Date().toISOString(), wikiSpecsHash, outputUri],
    );
  }

  private async failRun(runId: string, error: unknown): Promise<void> {
    await this.adapter.query(
      "UPDATE knowledge_build_runs SET status = $2, finished_at = $3, error = $4 WHERE run_id = $1",
      [runId, "failed", new Date().toISOString(), error instanceof Error ? error.message : String(error)],
    );
  }

  private async insertPackageAndArtifacts(
    packageId: string,
    runId: string,
    versionId: string,
    sourceRefs: string[],
    artifacts: CollectedArtifact[],
    quality: QualityGateResult,
  ): Promise<AssetPackage> {
    const now = new Date().toISOString();
    const qualitySummary = {
      overallScore: quality.overallScore,
      blockingCount: quality.blockingCount,
      warningCount: quality.warningCount,
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
            JSON.stringify(artifact.quality),
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

function ensureWikiSpecs(dataDir: string): string {
  const specDir = join(dataDir, "processed", "wiki_specs");
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
