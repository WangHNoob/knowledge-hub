import type { FastifyInstance } from "fastify";

import type { DatabaseHandle } from "../types";
import type { DiagnosticLogger } from "../services/diagnosticService";
import type { KnowledgeService } from "../services/knowledgeService";
import type { SourceBundleService } from "../services/sourceBundleService";
import type { KbBuilderPipelineService } from "../services/kbBuilderService";
import type { ReleaseService } from "../services/releaseService";
import type { KnowledgeQueryService } from "../services/knowledgeQueryService";

export interface RouteContext {
  db: DatabaseHandle;
  dataDir: string;
  diagnostics: DiagnosticLogger;
  service: KnowledgeService;
  bundleService: SourceBundleService;
  kbBuilderService: KbBuilderPipelineService;
  releaseService: ReleaseService;
  queryService: KnowledgeQueryService;
}

export type RouteRegistrar = (app: FastifyInstance, ctx: RouteContext) => void | Promise<void>;
