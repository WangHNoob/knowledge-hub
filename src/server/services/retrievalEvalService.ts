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

/** golden↔release 绑定（flywheel：EV-027 机制性护栏）。 */
export interface RetrievalEvalBinding {
  boundReleaseId: string;
  currentReleaseId: string;
  ok: boolean;
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
  /** golden 集绑定的 kbReleaseId 与当前发布的一致性（未绑定则缺省）。 */
  binding?: RetrievalEvalBinding;
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
    const gold = JSON.parse(readFileSync(goldPath, "utf8")) as { cases?: RetrievalGoldCase[]; meta?: Record<string, unknown> };
    const cases = Array.isArray(gold.cases) ? gold.cases : [];
    const query = createKnowledgeQueryService(this.db, this.dataDir, this.diagnostics, this.governanceProfileService);

    // golden↔release 绑定（EV-027 机制性护栏）：golden 声明的 kbReleaseId 与
    // 当前发布通道不一致 → binding.ok=false，发布门禁据此拦截自动发布。
    const boundReleaseId = typeof gold.meta?.kbReleaseId === "string" && gold.meta.kbReleaseId.trim()
      ? gold.meta.kbReleaseId.trim()
      : "";
    let binding: RetrievalEvalBinding | undefined;
    if (boundReleaseId) {
      const { rows: currentRows } = await this.db.adapter.query(
        `SELECT r.release_id
           FROM release_channels c
           JOIN releases r ON r.release_id = c.current_release_id
          WHERE c.project_id = $1`,
        [projectId],
      );
      const currentReleaseId = currentRows[0] ? String(currentRows[0].release_id) : "";
      binding = {
        boundReleaseId,
        currentReleaseId,
        ok: currentReleaseId !== "" && boundReleaseId === currentReleaseId,
      };
    }

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
      ...(binding ? { binding } : {}),
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
