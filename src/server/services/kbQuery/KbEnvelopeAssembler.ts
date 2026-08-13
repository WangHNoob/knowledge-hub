import type { AssetComponent, DatabaseHandle, KnowledgeEnvelope, ReleaseRecord, TrustScore } from "../../types";
import { mapComponent } from "../../db/mappers";
import { scoreFromQuality, trustFromQuality } from "../trustScore";
import type { OkfBundleReader } from "./OkfBundleReader";
import type { OkfCitation } from "./types";
import {
  emptyTrustSummary,
  latestIso,
  lintStatusFromTrust,
  round,
  ruleProfileHashFromRelease,
  trustLevel,
  uniqueSorted,
} from "./utils";

const EVIDENCE_REQUIRED_COMPONENT_KINDS = new Set(["wiki_page"]);

/**
 * KnowledgeEnvelope 组装辅助：trust 汇总 / 证据计数 / 质量标记。
 * 从 KnowledgeQueryService 拆出（纯移动，行为不变），runTool 与各工具域共用。
 */
export interface EnvelopeAssemblerCtx {
  adapter: DatabaseHandle["adapter"];
  okfReader: OkfBundleReader;
}

export class KbEnvelopeAssembler {
  constructor(private readonly ctx: EnvelopeAssemblerCtx) {}

  okfEvidenceRecordsForComponents(release: ReleaseRecord, componentIds: string[]): OkfCitation[] {
    if (componentIds.length === 0) return [];
    const wanted = new Set(componentIds);
    return this.ctx.okfReader.readOkfPages(release).flatMap((page) => wanted.has(page.componentId) ? page.citations : []);
  }

  async evidenceRecordsForComponents(componentIds: string[]): Promise<Record<string, unknown>[]> {
    if (componentIds.length === 0) return [];
    const placeholders = componentIds.map((_, index) => `$${index + 1}`).join(",");
    const { rows } = await this.ctx.adapter.query(
      `SELECT * FROM evidence_records WHERE component_id IN (${placeholders}) ORDER BY created_at DESC, evidence_id`,
      componentIds,
    );
    return rows;
  }

  async evidenceCountsForComponents(release: ReleaseRecord, componentIds: string[]): Promise<Map<string, number>> {
    const idsByComponent = new Map<string, Set<string>>();
    if (componentIds.length === 0) return new Map();
    for (const record of this.okfEvidenceRecordsForComponents(release, componentIds)) {
      const bucket = idsByComponent.get(record.componentId) ?? new Set<string>();
      bucket.add(record.evidenceId);
      idsByComponent.set(record.componentId, bucket);
    }
    for (const record of await this.evidenceRecordsForComponents(componentIds)) {
      const componentId = String(record.component_id ?? "");
      if (!componentId) continue;
      const bucket = idsByComponent.get(componentId) ?? new Set<string>();
      bucket.add(String(record.evidence_id ?? `${componentId}:${bucket.size + 1}`));
      idsByComponent.set(componentId, bucket);
    }
    return new Map([...idsByComponent.entries()].map(([componentId, ids]) => [componentId, ids.size] as const));
  }

  async negativeFeedbackCountForComponents(projectId: string, componentIds: string[]): Promise<number> {
    if (componentIds.length === 0) return 0;
    const { rows } = await this.ctx.adapter.query(
      `SELECT COUNT(*)::int AS c
       FROM agent_events
       WHERE project_id = $1
         AND feedback_type IN ('low_quality_hit', 'evidence_insufficient', 'bad_hit', 'stale_knowledge', 'knowledge_gap')
         AND hit_component_ids ?| $2::text[]`,
      [projectId, componentIds],
    );
    return Number(rows[0]?.c ?? 0);
  }

  async correctionStatusForComponents(projectId: string, componentIds: string[]): Promise<"none" | "pending" | "applied" | "published"> {
    if (componentIds.length === 0) return "none";
    const placeholders = componentIds.map((_, index) => `$${index + 2}`).join(",");
    const { rows } = await this.ctx.adapter.query(
      `SELECT state, COUNT(*)::int AS c
       FROM source_corrections
       WHERE project_id = $1
         AND component_id IN (${placeholders})
         AND state <> 'retired'
       GROUP BY state`,
      [projectId, ...componentIds],
    );
    const states = new Set(rows.map((row) => String(row.state ?? "")));
    if (states.has("pending_review")) return "pending";
    if (states.has("active")) return "applied";
    return "none";
  }

  async artifactIdsForComponents(componentIds: string[]): Promise<string[]> {
    if (componentIds.length === 0) return [];
    const placeholders = componentIds.map((_, index) => `$${index + 1}`).join(",");
    const { rows } = await this.ctx.adapter.query(`SELECT artifact_id FROM asset_components WHERE component_id IN (${placeholders})`, componentIds);
    return rows.map((row) => String(row.artifact_id));
  }

  async trustSummaryForComponents(release: ReleaseRecord, componentIds: string[]): Promise<KnowledgeEnvelope["trust"]> {
    if (componentIds.length === 0) {
      return {
        averageScore: null,
        minScore: null,
        summary: emptyTrustSummary(release),
        components: [],
      };
    }
    const components = await this.componentsByIds(componentIds);
    const okfTrust = this.okfTrustByComponent(release, componentIds);
    const evidenceCounts = await this.evidenceCountsForComponents(release, componentIds);
    const [negativeFeedbackCount, correctionStatus] = await Promise.all([
      this.negativeFeedbackCountForComponents(release.projectId, componentIds),
      this.correctionStatusForComponents(release.projectId, componentIds),
    ]);
    const out = components.map((component) => ({
      componentId: component.componentId,
      artifactId: component.artifactId,
      title: component.title,
      kind: component.kind,
      trust: okfTrust.get(component.componentId) ?? trustFromQuality(component.quality),
    }));
    const scores = out.map((component) => component.trust?.score).filter((score): score is number => typeof score === "number" && Number.isFinite(score));
    return {
      averageScore: scores.length ? round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : null,
      minScore: scores.length ? Math.min(...scores) : null,
      summary: {
        level: trustLevel(scores.length ? Math.min(...scores) : null),
        evidenceCount: [...evidenceCounts.values()].reduce((sum, count) => sum + count, 0),
        sourceRefs: uniqueSorted(components.flatMap((component) => component.sourceRefs)),
        lastReviewedAt: latestIso(out.map((component) => component.trust?.lastTrustedAuditAt ?? "")),
        lastPublishedAt: release.publishedAt,
        negativeFeedbackCount,
        lintStatus: lintStatusFromTrust(out.map((component) => component.trust ?? null)),
        correctionStatus,
        ruleProfileHash: ruleProfileHashFromRelease(release),
      },
      components: out,
    };
  }

  okfTrustByComponent(release: ReleaseRecord, componentIds: string[]): Map<string, TrustScore | null> {
    const wanted = new Set(componentIds);
    const out = new Map<string, TrustScore | null>();
    for (const page of this.ctx.okfReader.readOkfPages(release)) {
      if (wanted.has(page.componentId)) out.set(page.componentId, page.trust);
    }
    const graph = this.ctx.okfReader.readOkfGraph(release);
    if (graph && wanted.has(graph.componentId)) out.set(graph.componentId, graph.trust ?? null);
    for (const entry of this.ctx.okfReader.readOkfTableSchemas(release)) {
      if (wanted.has(entry.componentId)) out.set(entry.componentId, entry.trust ?? null);
    }
    return out;
  }

  async qualityFlagsForComponents(componentIds: string[], evidenceRecords: Record<string, unknown>[], okfEvidenceComponentIds = new Set<string>(), trustByComponent = new Map<string, { score?: number | null } | null>()): Promise<string[]> {
    if (componentIds.length === 0) return [];
    const components = await this.componentsByIds(componentIds);
    const componentsWithEvidence = new Set(evidenceRecords.map((record) => String(record.component_id)));
    const flags: string[] = [];
    for (const component of components) {
      const trustScore = trustByComponent.get(component.componentId)?.score ?? scoreFromQuality(component.quality);
      if (trustScore !== null && trustScore < 0.7) flags.push(`low_trust:${component.componentId}`);
      if (EVIDENCE_REQUIRED_COMPONENT_KINDS.has(component.kind) && !componentsWithEvidence.has(component.componentId) && !okfEvidenceComponentIds.has(component.componentId)) {
        flags.push(`evidence_missing:${component.componentId}`);
      }
    }
    return uniqueSorted(flags);
  }

  async componentsByIds(componentIds: string[]): Promise<AssetComponent[]> {
    if (componentIds.length === 0) return [];
    const placeholders = componentIds.map((_, index) => `$${index + 1}`).join(",");
    const { rows } = await this.ctx.adapter.query(`SELECT * FROM asset_components WHERE component_id IN (${placeholders})`, componentIds);
    return rows.map(mapComponent);
  }
}
