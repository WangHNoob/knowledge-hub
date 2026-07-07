import type { SourceFileEntry, PipelineStage, QualityFinding } from "../../types";
import type { PipelineModelConfig } from "./modelConfig";

export interface RunWorkspace {
  runId: string;
  workspaceDir: string;
  dataDir: string;
  files: SourceFileEntry[];
}

export interface BuildPipelineOptions {
  versionId: string;
  bundleId: string;
  projectId?: string;
  requestedBy: string;
  stages: PipelineStage[];
  model: string;
  modelConfig?: PipelineModelConfig;
  force: boolean;
  only: string | null;
  qualityProfileId: string;
  traceId?: string;
  rebuildTaskId?: string;
  /**
   * Internal writeback mode: scoped annotation rebuilds merge changed artifacts back
   * into the owning package instead of creating a partial package.
   */
  mergeIntoPackageId?: string;
  /** Explicit maintenance mode: may write LLM-drafted aliases into the persistent translation table. Off by default. */
  generateAliases?: boolean;
  /** One-click mode: create and publish a release automatically after this build completes. */
  publishOnComplete?: boolean;
  releaseVersion?: string;
  /**
   * 阶段级局部重建：只把指定阶段产出的组件（如 graph → graph_snapshot/graph_view/topic_index）
   * 合并回 mergeIntoPackageId，其余组件不动。用于"只重建图谱并作为修订发布"。
   * 与 only（来源级过滤）互斥：scopedStage 下 pipeline 全量跑（重建派生所需的 _meta），
   * 仅在 persist 阶段做组件选择。
   */
  scopedStage?: "graph";
}

export interface StageResult {
  stage: PipelineStage;
  status: "completed" | "skipped";
  outputPaths: string[];
  warnings: string[];
}

export interface CollectedArtifact {
  artifactId: string;
  group: "wiki" | "index" | "graph" | "table" | "evidence" | "quality" | "release";
  kind: string;
  title: string;
  legacyPath: string;
  storageUri: string;
  sourceRefs: string[];
  quality: Record<string, unknown>;
}

export interface QualityGateResult {
  overallScore: number;
  blockingCount: number;
  warningCount: number;
  findings: QualityFinding[];
  componentQuality: Record<string, Record<string, unknown>>;
  dismissedRules?: Array<{ ruleId: string; componentRef: string }>;
}
