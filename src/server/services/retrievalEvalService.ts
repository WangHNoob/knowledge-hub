import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import type { DatabaseHandle } from "../types";
import type { DiagnosticLogger } from "./diagnosticService";
import { emitKnowledgeEvent } from "./eventService";
import type { GovernanceProfileService } from "./governanceProfileService";
import { createKnowledgeQueryService } from "./knowledgeQueryService";

export interface RetrievalGoldCase {
  id: string;
  query: string;
  expectComponentIds?: string[];
  expectTitleSubstrings?: string[];
  minTrust?: number;
}

export interface RetrievalEvalCaseResult {
  id: string;
  query: string;
  hit: boolean;
  citation: boolean;
  trust: boolean;
  topTitles: string[];
}

export interface RetrievalEvalSummary {
  projectId: string;
  k: number;
  total: number;
  hitAtK: number;
  citationCoverage: number;
  trustPassRate: number;
  goldPath: string;
  cases: RetrievalEvalCaseResult[];
}

export function createRetrievalEvalService(
  db: DatabaseHandle,
  dataDir: string,
  diagnostics?: DiagnosticLogger,
  governanceProfileService?: GovernanceProfileService,
): RetrievalEvalService {
  return new RetrievalEvalService(db, dataDir, diagnostics, governanceProfileService);
}

export class RetrievalEvalService {
  constructor(
    private readonly db: DatabaseHandle,
    private readonly dataDir: string,
    private readonly diagnostics?: DiagnosticLogger,
    private readonly governanceProfileService?: GovernanceProfileService,
  ) {}

  async run(input: {
    projectId?: string;
    goldPath?: string;
    k?: number;
    emitEvent?: boolean;
  } = {}): Promise<RetrievalEvalSummary> {
    const projectId = input.projectId ?? "default_project";
    const goldPath = resolve(process.cwd(), input.goldPath ?? "evals/retrieval-gold.json");
    const k = input.k ?? 5;
    if (!existsSync(goldPath)) {
      return {
        projectId,
        k,
        total: 0,
        hitAtK: 1,
        citationCoverage: 1,
        trustPassRate: 1,
        goldPath,
        cases: [],
      };
    }
    const gold = JSON.parse(readFileSync(goldPath, "utf8")) as { cases?: RetrievalGoldCase[] };
    const cases = Array.isArray(gold.cases) ? gold.cases : [];
    const query = createKnowledgeQueryService(this.db, this.dataDir, this.diagnostics, this.governanceProfileService);

    let hit = 0;
    let citationOk = 0;
    let trustOk = 0;
    const rows: RetrievalEvalCaseResult[] = [];

    for (const testCase of cases) {
      const envelope = await query.runTool("kb_search", { query: testCase.query, limit: k, projectId }, {
        sessionId: "eval-retrieval",
        agentRole: "admin",
        projectId,
      });
      const items = Array.isArray((envelope.result as { items?: unknown[] })?.items)
        ? (envelope.result as { items: Array<Record<string, unknown>> }).items
        : [];
      const componentIds = items.map((item) => String(item.componentId ?? ""));
      const titles = items.map((item) => String(item.title ?? ""));
      const expectIds = testCase.expectComponentIds ?? [];
      const expectTitles = testCase.expectTitleSubstrings ?? [];
      const idHit = expectIds.length === 0 || expectIds.some((id) => componentIds.includes(id));
      const titleHit = expectTitles.length === 0 || expectTitles.some((needle) => titles.some((title) => title.includes(needle)));
      const caseHit = idHit && titleHit && items.length > 0;
      if (caseHit) hit += 1;

      const evidenceIds = Array.isArray(envelope.trace?.evidenceIds) ? envelope.trace.evidenceIds : [];
      const caseCitation = evidenceIds.length > 0 || items.some((item) => Array.isArray(item.evidenceIds) && item.evidenceIds.length > 0);
      if (caseCitation) citationOk += 1;

      const minTrust = testCase.minTrust ?? 0;
      const trusts = items.map((item) => {
        const trust = item.trust as { score?: number } | null;
        return typeof trust?.score === "number" ? trust.score : 0;
      });
      const caseTrust = trusts.length === 0 || trusts.some((score) => score + 0.0001 >= minTrust);
      if (caseTrust) trustOk += 1;

      rows.push({
        id: testCase.id,
        query: testCase.query,
        hit: caseHit,
        citation: caseCitation,
        trust: caseTrust,
        topTitles: titles.slice(0, 3),
      });
    }

    const total = cases.length || 1;
    const summary: RetrievalEvalSummary = {
      projectId,
      k,
      total: cases.length,
      hitAtK: cases.length === 0 ? 1 : hit / total,
      citationCoverage: cases.length === 0 ? 1 : citationOk / total,
      trustPassRate: cases.length === 0 ? 1 : trustOk / total,
      goldPath,
      cases: rows,
    };

    if (input.emitEvent !== false) {
      await emitKnowledgeEvent(this.db, {
        eventType: "eval.retrieval_completed",
        entityType: "project",
        entityId: projectId,
        payload: {
          projectId,
          hitAtK: summary.hitAtK,
          citationCoverage: summary.citationCoverage,
          trustPassRate: summary.trustPassRate,
          total: summary.total,
          goldPath,
        },
      });
    }

    return summary;
  }
}
