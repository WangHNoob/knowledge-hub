import type { DatabaseHandle, ReleaseRecord } from "../../types";
import { jsonObject } from "../../db/mappers";
import { isComponentVisibleToRole } from "../knowledgeAcl";
import { fuseSearchWithRrf, searchDenseIndex } from "../okf/hybridSearch";
import { searchOkfIndex, type OkfSearchResultItem } from "../okf/searchIndex";
import type { KbGraphTools } from "./KbGraphTools";
import type { OkfBundleReader } from "./OkfBundleReader";
import type { ToolResult } from "./types";
import {
  boundedLimitArg,
  classifySearchMatch,
  nextStepForTarget,
  pageSuggestedTools,
  scoreText,
  searchCard,
  searchGuidance,
  snippet,
  uniqueSorted,
} from "./utils";

/**
 * 搜索域 MCP 工具（kb_search / kb_resolve_topic）与检索管线
 * （索引检索 + Markdown 降级 + 结果卡片组装）。
 * 从 KnowledgeQueryService 拆出（纯移动，行为不变）；page/table/graph
 * 域经 ctx late-binding 互相引用（构造时只存引用，不调用）。
 */
export interface KbSearchCtx {
  adapter: DatabaseHandle["adapter"];
  okfReader: OkfBundleReader;
  graphTools: KbGraphTools;
  shared: {
    evidenceCountsForComponents: (release: ReleaseRecord, componentIds: string[]) => Promise<Map<string, number>>;
  };
}

/** 页面域对外契约（避免循环 import 类型）。 */
export interface KbPageLike {
  alignSearchItemsWithPageTables(release: ReleaseRecord, items: OkfSearchResultItem[]): Promise<OkfSearchResultItem[]>;
  kbGetPage(release: ReleaseRecord, page: string): Promise<ToolResult>;
}
/** 表格域对外契约。 */
export interface KbTableLike {
  findTableSchema(release: ReleaseRecord, table: string): Promise<{ component: { componentId: string; artifactId: string; trust?: import("../../types").TrustScore | null }; schema: { table_name: string } } | null>;
}

export class KbSearchTools {
  /** late-bound：主服务构造时按 search → page → table 顺序 bindDomains 填充 */
  private page: KbPageLike | null = null;
  private table: KbTableLike | null = null;

  constructor(private readonly ctx: KbSearchCtx) {}

  bindDomains(page: KbPageLike, table: KbTableLike): void {
    this.page = page;
    this.table = table;
  }

  async kbSearch(release: ReleaseRecord, query: string, limit = 10, agentRole?: string): Promise<ToolResult> {
    const boundedLimit = boundedLimitArg(limit, 10, 50);
    const indexItems = await this.kbSearchIndex(release, query, boundedLimit, agentRole);
    if (indexItems.length > 0) {
      const match = classifySearchMatch(query, indexItems);
      return {
        result: await this.searchResultPayload(release, query, indexItems),
        componentIds: indexItems.map((item) => item.componentId),
        artifactIds: indexItems.map((item) => item.artifactId),
        qualityFlags: match.qualityFlags,
      };
    }
    return this.kbSearchMarkdownFallback(release, query, boundedLimit, agentRole);
  }

  async kbSearchIndex(release: ReleaseRecord, query: string, limit: number, agentRole?: string): Promise<OkfSearchResultItem[]> {
    const index = this.ctx.okfReader.readOkfSearchIndex(release);
    if (!index) return [];
    const lexical = searchOkfIndex(index, query, Math.max(limit * 2, 20));
    const dense = this.ctx.okfReader.readOkfDenseIndex(release);
    let candidates: OkfSearchResultItem[];
    if (!dense || dense.vectors.length === 0) {
      candidates = lexical.slice(0, Math.max(limit * 2, 20));
    } else {
      const denseRanks = searchDenseIndex(dense, query, Math.max(limit * 2, 20));
      const pageById = new Map(index.pages.map((page) => [page.componentId, page] as const));
      candidates = fuseSearchWithRrf(lexical, denseRanks, pageById, Math.max(limit * 2, 20));
    }
    const visible = await this.filterSearchItemsByDbVisibility(candidates, agentRole);
    return this.page!.alignSearchItemsWithPageTables(release, visible.slice(0, limit));
  }

  private async filterSearchItemsByDbVisibility(items: OkfSearchResultItem[], agentRole?: string): Promise<OkfSearchResultItem[]> {
    if (items.length === 0) return items;
    const ids = items.map((item) => item.componentId);
    const placeholders = ids.map((_, index) => `$${index + 1}`).join(",");
    const { rows } = await this.ctx.adapter.query(
      `SELECT component_id, quality FROM asset_components WHERE component_id IN (${placeholders})`,
      ids,
    );
    const qualityById = new Map(rows.map((row) => [String(row.component_id), jsonObject(row.quality)] as const));
    return items.filter((item) => isComponentVisibleToRole(qualityById.get(item.componentId) ?? {}, agentRole));
  }

  private async kbSearchMarkdownFallback(release: ReleaseRecord, query: string, limit: number, agentRole?: string): Promise<ToolResult> {
    const needle = query.toLowerCase();
    const pages = this.ctx.okfReader.readOkfPages(release);
    const items: OkfSearchResultItem[] = [];
    for (const page of pages) {
      const haystack = `${page.title}\n${page.okfPath}\n${page.artifactId}\n${page.markdown}`.toLowerCase();
      if (!needle || !haystack.includes(needle.split(/\s+/u)[0])) continue;
      const score = scoreText(haystack, needle);
      if (score <= 0) continue;
      items.push({
        componentId: page.componentId,
        title: page.title,
        artifactId: page.artifactId,
        okfPath: page.okfPath,
        kind: page.kind,
        type: page.type,
        trust: page.trust,
        snippet: snippet(page.body, needle),
        score,
        matchedTerms: query.toLowerCase().split(/\s+/u).filter(Boolean),
        matchedFields: ["body"],
        why: ["兼容模式：Markdown 正文关键词命中"],
        tableDependencies: [],
      });
    }
    items.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    const visible = await this.filterSearchItemsByDbVisibility(items, agentRole);
    const limited = await this.page!.alignSearchItemsWithPageTables(release, visible.slice(0, limit));
    const match = classifySearchMatch(query, limited);
    return {
      result: await this.searchResultPayload(release, query, limited),
      componentIds: limited.map((item) => item.componentId),
      artifactIds: limited.map((item) => item.artifactId),
      qualityFlags: match.qualityFlags,
    };
  }

  private async searchResultPayload(release: ReleaseRecord, query: string, items: OkfSearchResultItem[]): Promise<Record<string, unknown>> {
    const evidenceCounts = await this.ctx.shared.evidenceCountsForComponents(release, items.map((item) => item.componentId));
    const match = classifySearchMatch(query, items);
    return {
      query,
      total: items.length,
      retrieval: {
        mode: items.some((item) => item.matchedFields.includes("dense")) ? "hybrid_rrf" : "lexical",
        lexical: true,
        dense: items.some((item) => item.matchedFields.includes("dense")),
      },
      items,
      match,
      cards: items.map((item, index) => searchCard(item, index, evidenceCounts.get(item.componentId) ?? 0, match)),
      guidance: searchGuidance(query, items, evidenceCounts, match),
    };
  }

  async kbResolveTopic(release: ReleaseRecord, topic: string): Promise<ToolResult> {
    const search = await this.kbSearch(release, topic);
    const items = ((search.result as { items?: unknown[] }).items ?? []) as Array<Record<string, unknown>>;
    const table = await this.table!.findTableSchema(release, topic);
    const entity = this.ctx.graphTools.findGraphNodeSafe(release, topic);
    const page = items[0] ?? null;
    const targets = [
      ...(table ? [{
        type: "table",
        id: table.schema.table_name,
        title: table.schema.table_name,
        componentId: table.component.componentId,
        suggestedTools: ["kb_get_table_schema", "kb_query_table", "kb_validate_table"],
        why: [`表名/别名解析到 ${table.schema.table_name}`],
      }] : []),
      ...(entity ? [{
        type: "entity",
        id: entity.node.id,
        title: entity.node.label,
        componentId: entity.componentId,
        suggestedTools: ["kb_get_entity", "kb_get_neighbors", "kb_get_relations"],
        why: [`图谱实体命中 ${entity.node.label}`],
      }] : []),
      ...items.slice(0, 5).map((item) => ({
        type: "page",
        id: String(item.componentId ?? ""),
        title: String(item.title ?? ""),
        componentId: String(item.componentId ?? ""),
        okfPath: String(item.okfPath ?? ""),
        suggestedTools: pageSuggestedTools(item),
        why: Array.isArray(item.why) ? item.why : [],
        trust: item.trust ?? null,
      })),
    ];
    const resolved = targets[0] ?? page;
    return {
      result: {
        topic,
        resolved,
        resolvedType: targets[0]?.type ?? (page ? "page" : "none"),
        targets,
        suggestedTools: uniqueSorted(targets.flatMap((target) => target.suggestedTools)),
        nextStep: targets[0] ? nextStepForTarget(targets[0]) : "kb_search returned no target; add aliases or source material, then rebuild and publish.",
      },
      componentIds: uniqueSorted([...search.componentIds, ...targets.map((target) => String(target.componentId ?? ""))]),
      artifactIds: search.artifactIds,
    };
  }
}
