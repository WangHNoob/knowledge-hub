#!/usr/bin/env node
/**
 * Offline retrieval eval against the current published release.
 * Usage:
 *   npx tsx scripts/eval-retrieval.ts [--gold evals/retrieval-gold.json] [--project default_project] [--k 5]
 *   [--min-hit 0.85] [--min-citation 0]
 */
import { resolve } from "node:path";

import { config } from "../src/server/config";
import { createDatabase } from "../src/server/db";
import { createGovernanceProfileService } from "../src/server/services/governanceProfileService";
import { createRetrievalEvalService } from "../src/server/services/retrievalEvalService";

function argValue(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]!;
  return fallback;
}

const goldPath = resolve(process.cwd(), argValue("--gold", config.retrievalEvalGoldPath));
const projectId = argValue("--project", "default_project");
const k = Number(argValue("--k", "5"));
const minHit = Number(argValue("--min-hit", String(config.retrievalEvalMinHitAtK)));
const minCitation = Number(argValue("--min-citation", String(config.retrievalEvalMinCitationCoverage)));

const db = await createDatabase({ databaseUrl: config.databaseUrl });
const governance = createGovernanceProfileService(db, {
  evalEnabled: true,
  evalGoldPath: goldPath,
  evalMinHitAtK: minHit,
  evalMinCitationCoverage: minCitation,
});
const summary = await createRetrievalEvalService(db, resolve(process.cwd(), config.dataDir), undefined, governance).run({
  projectId,
  goldPath,
  k,
  emitEvent: true,
});

console.log(JSON.stringify(summary, null, 2));
await db.close();

const hitOk = summary.total === 0 || summary.hitAtK + 1e-9 >= minHit;
const citationOk = summary.total === 0 || minCitation <= 0 || summary.citationCoverage + 1e-9 >= minCitation;
process.exit(hitOk && citationOk ? 0 : 1);
