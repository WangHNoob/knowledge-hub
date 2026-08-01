#!/usr/bin/env node
/**
 * Offline retrieval eval against the current published release.
 * Usage: npx tsx scripts/eval-retrieval.ts [--gold evals/retrieval-gold.json] [--project default_project] [--k 5]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "../src/server/config";
import { createDatabase } from "../src/server/db";
import { createGovernanceProfileService } from "../src/server/services/governanceProfileService";
import { createKnowledgeQueryService } from "../src/server/services/knowledgeQueryService";

interface GoldCase {
  id: string;
  query: string;
  expectComponentIds?: string[];
  expectTitleSubstrings?: string[];
  minTrust?: number;
}

interface GoldFile {
  cases: GoldCase[];
}

function argValue(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]!;
  return fallback;
}

const goldPath = resolve(process.cwd(), argValue("--gold", "evals/retrieval-gold.json"));
const projectId = argValue("--project", "default_project");
const k = Number(argValue("--k", "5"));
const gold = JSON.parse(readFileSync(goldPath, "utf8")) as GoldFile;

const db = await createDatabase({ databaseUrl: config.databaseUrl });
const query = createKnowledgeQueryService(
  db,
  resolve(process.cwd(), config.dataDir),
  undefined,
  createGovernanceProfileService(db),
);

let hit = 0;
let citationOk = 0;
let trustOk = 0;
const rows: Array<Record<string, unknown>> = [];

for (const testCase of gold.cases) {
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

const total = gold.cases.length || 1;
const summary = {
  projectId,
  k,
  total: gold.cases.length,
  hitAtK: hit / total,
  citationCoverage: citationOk / total,
  trustPassRate: trustOk / total,
  cases: rows,
};

console.log(JSON.stringify(summary, null, 2));
await db.close();
process.exit(summary.hitAtK >= 0 ? 0 : 1);
