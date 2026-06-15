import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { QualityFinding, QualityGateConfig, QualitySeverity } from "../../types";
import type { QualityGateResult } from "./types";
import type { WikiSpecSet } from "./specs";

export function evaluateQualityGate(options: {
  dataDir: string;
  specs: WikiSpecSet;
  sourceLogicalPaths: Set<string>;
  profile: QualityGateConfig;
}): QualityGateResult {
  const findings: QualityFinding[] = [];
  const componentQuality: Record<string, Record<string, unknown>> = {};
  const pageScores: number[] = [];

  for (const [type, pageType] of Object.entries(options.specs.manifest.pageTypes)) {
    const dir = join(options.dataDir, "wiki", pageType.dir);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".md")).sort()) {
      const rel = `wiki/${pageType.dir}/${file}`;
      const markdown = readFileSync(join(dir, file), "utf8");
      const meta = readJson(join(options.dataDir, "wiki", "_meta", file.replace(/\.md$/u, ".json")), {});
      const frontmatter = parseFrontmatter(markdown);
      const spec = options.specs.specs[type] ?? { requiredSections: [], requiredFacts: [] };
      const quality = evaluateWikiPage(markdown, meta, spec.requiredSections, spec.requiredFacts);
      pageScores.push(quality.wikiSpecScore);
      componentQuality[rel] = {
        confidence: quality.wikiSpecScore,
        structureScore: quality.structureScore,
        factsScore: quality.factsScore,
        emptySectionScore: quality.emptySectionScore,
      };

      const wikiRule = rule(options.profile, "wikiSpecCompleteness");
      const minWikiScore = numberValue(wikiRule.minScore, 0.75);
      if (ruleEnabled(wikiRule) && quality.wikiSpecScore < minWikiScore) {
        findings.push(finding(
          "wikiSpecCompleteness",
          severity(wikiRule, "blocking"),
          rel,
          `Wiki spec incomplete: ${rel}`,
          `Score ${quality.wikiSpecScore}; missing sections: ${quality.missingSections.join(", ") || "none"}.`,
          "补齐 wiki spec 要求的章节，并避免必填章节为空。",
          1 - quality.wikiSpecScore,
        ));
      }

      const factsRule = rule(options.profile, "requiredFacts");
      const minFactsScore = numberValue(factsRule.minScore, 0.7);
      if (ruleEnabled(factsRule) && quality.factsScore < minFactsScore) {
        findings.push(finding(
          "requiredFacts",
          severity(factsRule, "warning"),
          rel,
          `Required facts missing: ${rel}`,
          `Missing facts: ${quality.missingFacts.join(", ") || "none"}.`,
          "补齐 spec 要求的 facts 字段。",
          1 - quality.factsScore,
        ));
      }

      const sourceRule = rule(options.profile, "frontmatterSource");
      if (ruleEnabled(sourceRule)) {
        const source = frontmatter.source;
        const metaSource = stringValue((meta as Record<string, unknown>).source);
        if (!source || !options.sourceLogicalPaths.has(source) || (metaSource && metaSource !== source)) {
          findings.push(finding(
            "frontmatterSource",
            severity(sourceRule, "blocking"),
            rel,
            `Source trace invalid: ${rel}`,
            `frontmatter source=${source ?? ""}; meta source=${metaSource ?? ""}.`,
            "修正 wiki frontmatter/source meta，或重新从正确资料版本构建。",
            1,
          ));
        }
      }
    }
  }

  const graphFinding = evaluateGraph(options.dataDir, options.specs, options.profile);
  if (graphFinding) findings.push(graphFinding);

  const conceptFindings = evaluateConceptOveruse(options.dataDir, options.profile);
  findings.push(...conceptFindings);

  const overallScore = round(pageScores.length ? pageScores.reduce((sum, value) => sum + value, 0) / pageScores.length : 0);
  return {
    overallScore,
    blockingCount: findings.filter((item) => item.severity === "blocking").length,
    warningCount: findings.filter((item) => item.severity === "warning").length,
    findings,
    componentQuality,
  };
}

function evaluateWikiPage(
  markdown: string,
  meta: unknown,
  requiredSections: string[],
  requiredFacts: string[],
) {
  const presentSections = new Set([...markdown.matchAll(/^##\s+(.+?)\s*$/gmu)].map((match) => match[1].trim()));
  const metaFacts = factsFromMeta(meta);
  const missingSections = requiredSections.filter((section) => !presentSections.has(section));
  const missingFacts = requiredFacts.filter((fact) => !Object.prototype.hasOwnProperty.call(metaFacts, fact));
  const emptyRequiredSections = requiredSections.filter((section) => sectionIsEmpty(markdown, section));
  const structureScore = ratio(requiredSections.length - missingSections.length, requiredSections.length);
  const factsScore = ratio(requiredFacts.length - missingFacts.length, requiredFacts.length);
  const emptySectionScore = requiredSections.length ? round(1 - emptyRequiredSections.length / requiredSections.length) : 1;
  const wikiSpecScore = round(structureScore * 0.45 + factsScore * 0.35 + emptySectionScore * 0.2);
  return { structureScore, factsScore, emptySectionScore, wikiSpecScore, missingSections, missingFacts };
}

function evaluateGraph(dataDir: string, specs: WikiSpecSet, profile: QualityGateConfig): QualityFinding | null {
  const graphRule = rule(profile, "graphIntegrity");
  if (!ruleEnabled(graphRule)) return null;
  const graphPath = join(dataDir, "wiki", "graph.json");
  if (!existsSync(graphPath)) {
    return finding("graphIntegrity", severity(graphRule, "blocking"), "wiki/graph.json", "Graph missing", "wiki/graph.json does not exist.", "重新运行 graph 阶段。", 1);
  }

  const graph = readJson<{ nodes?: any[]; edges?: any[] }>(graphPath, {});
  const nodeIds = new Set((graph.nodes ?? []).map((node) => node.id));
  const dangling = (graph.edges ?? []).find((edge) => !nodeIds.has(edge.source) || !nodeIds.has(edge.target));
  if (dangling) {
    return finding("graphIntegrity", severity(graphRule, "blocking"), "wiki/graph.json", "Dangling graph edge", `${dangling.source} -> ${dangling.target}`, "修复 meta 关系或表注册表。", 1);
  }
  const invalidRelation = (graph.edges ?? []).find((edge) => edge.edge_kind === "semantic" && !specs.relationTypes.has(edge.relation));
  if (invalidRelation) {
    return finding("graphIntegrity", severity(graphRule, "blocking"), "wiki/graph.json", "Invalid relation type", invalidRelation.relation, "改用 manifest 中定义的关系类型。", 1);
  }
  return null;
}

function evaluateConceptOveruse(dataDir: string, profile: QualityGateConfig): QualityFinding[] {
  const conceptRule = rule(profile, "conceptOveruse");
  if (!ruleEnabled(conceptRule)) return [];
  const graphPath = join(dataDir, "wiki", "graph.json");
  if (!existsSync(graphPath)) return [];
  const graph = readJson<{ nodes?: any[]; edges?: any[] }>(graphPath, {});
  const nodes = graph.nodes ?? [];
  if (nodes.length === 0) return [];
  const conceptCount = nodes.filter((node) => node.type === "concept").length;
  const ratioValue = conceptCount / nodes.length;
  const maxRatio = numberValue(conceptRule.maxRatio, 0.35);
  if (ratioValue <= maxRatio) return [];
  return [finding(
    "conceptOveruse",
    severity(conceptRule, "warning"),
    "wiki/graph.json",
    "Concept nodes overused",
    `Concept ratio ${round(ratioValue)} exceeds ${maxRatio}.`,
    "细化实体类型，避免把系统、活动、配表实体抽成 concept。",
    ratioValue - maxRatio,
  )];
}

function parseFrontmatter(markdown: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(markdown);
  if (!match) return {};
  return Object.fromEntries(
    match[1]
      .split(/\r?\n/)
      .map((line) => /^([^:]+):\s*(.*)$/u.exec(line))
      .filter((value): value is RegExpExecArray => Boolean(value))
      .map((value) => [value[1].trim(), value[2].trim()]),
  );
}

function factsFromMeta(meta: unknown): Record<string, unknown> {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
  const facts = (meta as Record<string, unknown>).facts;
  return facts && typeof facts === "object" && !Array.isArray(facts) ? facts as Record<string, unknown> : {};
}

function sectionIsEmpty(markdown: string, section: string): boolean {
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`^##\\s+${escaped}\\s*$([\\s\\S]*?)(?=^##\\s+|$)`, "mu").exec(markdown);
  return Boolean(match && match[1].trim().length === 0);
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function rule(profile: QualityGateConfig, ruleId: string): Record<string, unknown> {
  return profile.rules[ruleId] ?? {};
}

function ruleEnabled(ruleConfig: Record<string, unknown>): boolean {
  return ruleConfig.enabled !== false;
}

function severity(ruleConfig: Record<string, unknown>, fallback: QualitySeverity): QualitySeverity {
  return ruleConfig.severity === "warning" || ruleConfig.severity === "info" || ruleConfig.severity === "blocking"
    ? ruleConfig.severity
    : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function ratio(hit: number, total: number): number {
  return total === 0 ? 1 : round(hit / total);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function finding(
  ruleId: string,
  severityValue: QualitySeverity,
  componentId: string,
  title: string,
  description: string,
  suggestedAction: string,
  scoreImpact: number,
): QualityFinding {
  return { ruleId, severity: severityValue, componentId, title, description, suggestedAction, scoreImpact: round(scoreImpact) };
}
