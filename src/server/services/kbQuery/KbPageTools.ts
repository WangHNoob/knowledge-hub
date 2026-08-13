import { existsSync, readFileSync } from "node:fs";

import type { ReleaseRecord } from "../../types";
import type { OkfSearchResultItem } from "../okf/searchIndex";
import type { KbGraphTools } from "./KbGraphTools";
import type { OkfBundleReader } from "./OkfBundleReader";
import type { OkfPage, TableSchemaEntry, ToolResult } from "./types";
import {
  aliasKey,
  dependencyCandidates,
  dependencyHint,
  dependencyLines,
  extractDependencyText,
  extractSection,
  looksLikeDependencyToken,
  normalize,
  pageLookupKeys,
  resolveCandidateTables,
  same,
  schemaEntriesForAliasTarget,
  uniqueOrdered,
  uniqueSorted,
  uniqueTableEntries,
} from "./utils";

/**
 * 页面域 MCP 工具（kb_get_page / kb_get_section / kb_list_pages /
 * kb_get_index / kb_get_page_tables）与页面-配表关联解析。
 * 从 KnowledgeQueryService 拆出（纯移动，行为不变）。
 */
export interface KbPageCtx {
  okfReader: OkfBundleReader;
  graphTools: KbGraphTools;
}

export interface KbSearchLike {
  kbSearchIndex(release: ReleaseRecord, query: string, limit: number, agentRole?: string): Promise<OkfSearchResultItem[]>;
}

export interface KbTableLike {
  tableSchemas(release: ReleaseRecord): Promise<TableSchemaEntry[]>;
}

export class KbPageTools {
  /** late-bound：主服务构造后 bindDomains 填充 */
  private search: KbSearchLike | null = null;
  private table: KbTableLike | null = null;

  constructor(private readonly ctx: KbPageCtx) {}

  bindDomains(search: KbSearchLike, table: KbTableLike): void {
    this.search = search;
    this.table = table;
  }

  async kbGetPage(release: ReleaseRecord, page: string): Promise<ToolResult> {
    const okfPage = await this.findOkfPage(release, page);
    if (!okfPage) return { result: { page, found: false }, componentIds: [] };
    return {
      result: {
        page,
        found: true,
        componentId: okfPage.componentId,
        title: okfPage.title,
        artifactId: okfPage.artifactId,
        okfPath: okfPage.okfPath,
        type: okfPage.type,
        trust: okfPage.trust,
        markdown: okfPage.markdown,
      },
      componentIds: [okfPage.componentId],
      artifactIds: [okfPage.artifactId],
    };
  }

  async kbGetSection(release: ReleaseRecord, page: string, section: string): Promise<ToolResult> {
    const pageResult = await this.kbGetPage(release, page);
    if (pageResult.componentIds.length === 0) return { result: { page, section, found: false }, componentIds: [] };
    const markdown = String((pageResult.result as Record<string, unknown>).markdown ?? "");
    const extracted = extractSection(markdown, section);
    return {
      result: { page, section, found: Boolean(extracted), markdown: extracted ?? "" },
      componentIds: pageResult.componentIds,
      artifactIds: pageResult.artifactIds,
    };
  }

  async kbListPages(release: ReleaseRecord): Promise<ToolResult> {
    const pages = this.ctx.okfReader.readOkfPages(release);
    return {
      result: {
        pages: pages.map((page) => ({
          componentId: page.componentId,
          title: page.title,
          artifactId: page.artifactId,
          okfPath: page.okfPath,
          kind: page.kind,
          type: page.type,
          trust: page.trust,
        })),
      },
      componentIds: pages.map((page) => page.componentId),
      artifactIds: pages.map((page) => page.artifactId),
    };
  }

  /** 读取发布物目录 index.md（按模块分组、含一句话描述与关联配表），供 Agent 先查目录再定位。 */
  async kbGetIndex(release: ReleaseRecord): Promise<ToolResult> {
    const full = this.ctx.okfReader.okfBundleFile(release, "index.md");
    if (!existsSync(full)) {
      return { result: { found: false, reason: "release bundle has no index.md" }, componentIds: [], forceHit: true };
    }
    const content = readFileSync(full, "utf8");
    return {
      result: { found: true, okfPath: "/index.md", releaseId: release.releaseId, content },
      componentIds: [],
      forceHit: true,
    };
  }

  async kbGetPageTables(release: ReleaseRecord, page: string): Promise<ToolResult> {
    const pageResult = await this.kbGetPage(release, page);
    const foundPage = pageResult.componentIds.length > 0;
    const schemas = await this.table!.tableSchemas(release);
    const pageInfo = pageResult.result as Record<string, unknown>;
    const resolved = foundPage
      ? await this.resolvePageTables(release, {
        pageTitle: String(pageInfo.title ?? page),
        artifactId: String(pageInfo.artifactId ?? ""),
        markdown: String(pageInfo.markdown ?? ""),
        schemas,
      })
      : { tables: [], unresolved: [], source: "not_found" as const };
    return {
      result: {
        page,
        found: foundPage,
        source: resolved.source,
        tables: resolved.tables.map(({ schema, component }) => ({
          table: schema.table_name,
          componentId: component.componentId,
          fields: schema.fields,
          rowCount: schema.row_count,
          trust: component.trust ?? null,
        })),
        unresolvedDependencies: resolved.unresolved,
        unresolvedDependencyHints: resolved.unresolved.map(dependencyHint),
      },
      componentIds: uniqueSorted([...pageResult.componentIds, ...resolved.tables.map((table) => table.component.componentId)]),
    };
  }

  async alignSearchItemsWithPageTables(release: ReleaseRecord, items: OkfSearchResultItem[]): Promise<OkfSearchResultItem[]> {
    if (items.length === 0) return items;
    const schemas = await this.table!.tableSchemas(release);
    const pagesByComponent = new Map(this.ctx.okfReader.readOkfPages(release).map((page) => [page.componentId, page] as const));
    const aligned: OkfSearchResultItem[] = [];
    for (const item of items) {
      const page = pagesByComponent.get(item.componentId);
      if (!page) {
        aligned.push(item);
        continue;
      }
      const resolved = await this.resolvePageTables(release, {
        pageTitle: page.title,
        artifactId: page.artifactId,
        markdown: page.markdown,
        schemas,
      });
      const tableDependencies = resolved.tables.map(({ schema }) => schema.table_name);
      const matchedFields = tableDependencies.length > 0 ? item.matchedFields : item.matchedFields.filter((field) => field !== "tables");
      const whyBase = tableDependencies.length > 0
        ? item.why
        : item.why.filter((line) => !line.startsWith("tables 命中") && !line.startsWith("配置表意图命中结构化表依赖"));
      aligned.push({
        ...item,
        matchedFields,
        tableDependencies,
        why: resolved.unresolved.length
          ? uniqueOrdered([...whyBase, `未解析为具体表：${resolved.unresolved.slice(0, 5).join(", ")}`]).slice(0, 9)
          : whyBase,
      });
    }
    return aligned;
  }

  private async resolvePageTables(
    release: ReleaseRecord,
    input: {
      pageTitle: string;
      artifactId: string;
      markdown: string;
      schemas: TableSchemaEntry[];
    },
  ): Promise<{
    tables: TableSchemaEntry[];
    unresolved: string[];
    source: "explicit_dependencies" | "graph" | "not_found";
  }> {
    const schemasByName = new Map(input.schemas.map((entry) => [aliasKey(entry.schema.table_name), entry] as const));
    const aliases = this.actionableTableAliases(release, schemasByName);
    const explicit = extractDependencyText(input.markdown);
    const explicitLines = dependencyLines(explicit.text);
    const candidates = dependencyCandidates(explicit.text);
    const explicitTables = candidates.flatMap((candidate) => resolveCandidateTables(candidate, schemasByName, aliases));
    const unresolved = uniqueSorted(explicitLines.filter((candidate) =>
      looksLikeDependencyToken(candidate) &&
      dependencyCandidates(candidate).every((part) => resolveCandidateTables(part, schemasByName, aliases).length === 0)
    ));
    if (explicit.hasDependencySection) {
      return {
        tables: uniqueTableEntries(explicitTables),
        unresolved,
        source: "explicit_dependencies",
      };
    }

    const graphTables = await this.pageConfiguredTables(release, input.pageTitle, input.artifactId);
    const tables = [...graphTables].flatMap((table) => resolveCandidateTables(table, schemasByName, aliases));
    return {
      tables: uniqueTableEntries(tables),
      unresolved: [],
      source: tables.length ? "graph" : "not_found",
    };
  }

  private actionableTableAliases(
    release: ReleaseRecord,
    schemasByName: Map<string, TableSchemaEntry>,
  ): Map<string, TableSchemaEntry[]> {
    const aliases = new Map<string, TableSchemaEntry[]>();
    for (const row of this.ctx.okfReader.readOkfTableAliases(release)) {
      const table = row.table ?? row.canonical ?? row.canonicalName ?? "";
      const schemas = schemaEntriesForAliasTarget(table, schemasByName);
      if (schemas.length === 0) continue;
      for (const value of uniqueSorted([table, ...(row.aliases ?? [])])) {
        const key = aliasKey(value);
        if (!key) continue;
        aliases.set(key, uniqueTableEntries([...(aliases.get(key) ?? []), ...schemas]));
      }
    }
    return aliases;
  }

  private async pageConfiguredTables(release: ReleaseRecord, pageTitle: string, artifactId?: string): Promise<Set<string>> {
    try {
      const graph = await this.ctx.graphTools.readGraph(release);
      const artifactWithoutWiki = artifactId?.replace(/^wiki\//u, "");
      const pageNode = graph.nodes.find((node) =>
        same(node.label, pageTitle) ||
        same(node.id, pageTitle) ||
        same(node.wiki_page, artifactId) ||
        same(node.wiki_page, artifactWithoutWiki)
      );
      const sourceIds = new Set([pageTitle, artifactId, artifactWithoutWiki, pageNode?.id].filter((value): value is string => Boolean(value)));
      return new Set(graph.edges
        .filter((edge) => sourceIds.has(edge.source) && edge.relation === "configured_in")
        .flatMap((edge) => [edge.target, edge.target.replace(/^table:/u, "")]));
    } catch {
      return new Set();
    }
  }

  async findOkfPage(release: ReleaseRecord, page: string): Promise<OkfPage | null> {
    const normalized = normalize(page);
    const pages = this.ctx.okfReader.readOkfPages(release);
    const exact = pages.find((item) => pageLookupKeys(item).some((key) => normalize(key) === normalized));
    if (exact) return exact;
    const search = await this.search!.kbSearchIndex(release, page, 1);
    const hit = search[0];
    if (!hit) return null;
    if (hit.score < 1 || hit.why.some((line) => line.startsWith("缺少核心词"))) return null;
    return pages.find((item) => item.componentId === hit.componentId) ?? null;
  }
}
