import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import xlsx from "xlsx";

import type { AssetComponent, AssetPackage, DatabaseHandle, ReleaseRecord, TrustScore } from "../../types";
import { mapComponent, mapPackage } from "../../db/mappers";
import { trustFromQuality } from "../trustScore";
import type { OkfBundleReader } from "./OkfBundleReader";
import type { KnowledgeAssetRef, TableReadResult, TableSchema, TableSchemaEntry, ToolResult } from "./types";
import {
  aliasKey,
  boundedLimitArg,
  inferTableFieldMapping,
  manifestComponentIds,
  normalize,
  normalizeCellValue,
  rawRowFromGridRow,
  releaseSourceVersionIds,
  same,
  schemaEntriesForAliasTarget,
  uniqueSorted,
  uniqueTableEntries,
} from "./utils";

/**
 * 表格域 MCP 工具（kb_list_tables / kb_get_table_schema / kb_query_table /
 * kb_validate_table / kb_check_table_value / kb_get_table_raw / kb_get_quality）
 * 与配表读取管线（schema 解析 / 别名 / 原始网格 / 映射行）。
 * 从 KnowledgeQueryService 拆出（纯移动，行为不变）。
 */
export interface KbTableCtx {
  adapter: DatabaseHandle["adapter"];
  dataDir: string;
  sourceService: ReturnType<typeof import("../sourceBundleService").createSourceBundleService>;
  okfReader: OkfBundleReader;
}

export class KbTableTools {
  constructor(private readonly ctx: KbTableCtx) {}

  async kbListTables(release: ReleaseRecord, query?: string, limit = 50): Promise<ToolResult> {
    const schemas = await this.tableSchemas(release);
    const normalizedQuery = query ? aliasKey(query) : "";
    const schemasByName = new Map(schemas.map((entry) => [aliasKey(entry.schema.table_name), entry] as const));
    const aliases = normalizedQuery ? this.actionableTableAliases(release, schemasByName) : new Map<string, TableSchemaEntry[]>();
    const matched = schemas
      .filter(({ schema }) =>
        !normalizedQuery ||
        [schema.table_name, schema.rel_path, ...(schema.fields ?? [])].some((value) => aliasKey(String(value)).includes(normalizedQuery)) ||
        [...aliases.entries()].some(([alias, entries]) =>
          entries.some((entry) => entry.schema.table_name === schema.table_name) &&
          (alias.includes(normalizedQuery) || normalizedQuery.includes(alias))
        )
      )
      .sort((a, b) => a.schema.table_name.localeCompare(b.schema.table_name));
    const rows = matched.slice(0, boundedLimitArg(limit, 50, 200));
    return {
      result: {
        query: query ?? null,
        totalMatched: matched.length,
        tables: rows.map(({ schema, component }) => ({
          table: schema.table_name,
          componentId: component.componentId,
          relPath: schema.rel_path,
          fields: schema.fields,
          rowCount: schema.row_count,
          trust: component.trust ?? null,
        })),
      },
      componentIds: rows.map(({ component }) => component.componentId),
    };
  }

  async kbGetTableSchema(release: ReleaseRecord, table: string): Promise<ToolResult> {
    const found = await this.findTableSchema(release, table);
    if (!found) return { result: { found: false, table }, componentIds: [] };
    return {
      result: { found: true, table, schema: found.schema, trust: found.component.trust ?? null },
      componentIds: [found.component.componentId],
      artifactIds: [found.component.artifactId],
    };
  }

  async kbQueryTable(release: ReleaseRecord, table: string, limit: number, where: Record<string, unknown>): Promise<ToolResult> {
    const found = await this.findTableSchema(release, table);
    if (!found) return { result: { found: false, table, rows: [] }, componentIds: [] };
    const tableData = await this.readMappedTableRows(release, found.schema, found.sourceVersionIds);
    const filtered = tableData.rows.filter((row) => Object.entries(where).every(([key, value]) => String(row.row[key] ?? row[key] ?? "") === String(value)));
    return {
      result: {
        found: true,
        table: found.schema.table_name,
        rows: filtered.slice(0, Math.max(1, Math.min(limit || 20, 200))),
        totalRows: filtered.length,
        fieldMap: tableData.fieldMap,
        mappedFields: tableData.mappedFields,
        missingFields: tableData.missingFields,
        unmappedRawColumns: tableData.unmappedRawColumns,
        headerRowGuess: tableData.headerRowGuess,
        diagnostics: tableData.diagnostics,
        trust: found.component.trust ?? null,
      },
      componentIds: [found.component.componentId],
      artifactIds: [found.component.artifactId],
      sourceVersionIds: releaseSourceVersionIds(release),
    };
  }

  async kbValidateTable(release: ReleaseRecord, table: string): Promise<ToolResult> {
    const found = await this.findTableSchema(release, table);
    if (!found) return { result: { valid: false, table, errors: ["table schema not found"] }, componentIds: [] };
    const tableData = await this.readMappedTableRows(release, found.schema, found.sourceVersionIds);
    return {
      result: {
        valid: tableData.missingFields.length === 0,
        table: found.schema.table_name,
        mappedFields: tableData.mappedFields,
        missingFields: tableData.missingFields,
        unmappedRawColumns: tableData.unmappedRawColumns,
        headerRowGuess: tableData.headerRowGuess,
        rowCount: tableData.rowCount,
        diagnostics: tableData.diagnostics,
        trust: found.component.trust ?? null,
      },
      componentIds: [found.component.componentId],
      artifactIds: [found.component.artifactId],
    };
  }

  async kbCheckTableValue(release: ReleaseRecord, table: string, field: string, value: unknown): Promise<ToolResult> {
    const found = await this.findTableSchema(release, table);
    if (!found) return { result: { found: false, table, matches: [] }, componentIds: [] };
    const tableData = await this.readMappedTableRows(release, found.schema, found.sourceVersionIds);
    const matches = tableData.rows.filter((row) => String(row.row[field] ?? row[field] ?? "") === String(value));
    return {
      result: {
        found: true,
        table: found.schema.table_name,
        field,
        value,
        matches,
        fieldMap: tableData.fieldMap,
        mappedFields: tableData.mappedFields,
        missingFields: tableData.missingFields,
        diagnostics: tableData.diagnostics,
        trust: found.component.trust ?? null,
      },
      componentIds: [found.component.componentId],
      artifactIds: [found.component.artifactId],
    };
  }

  async kbGetTableRaw(release: ReleaseRecord, table: string, headerRows: number): Promise<ToolResult> {
    const found = await this.findTableSchema(release, table);
    if (!found) return { result: { found: false, table }, componentIds: [] };
    const { sheet, grid } = await this.readTableGrid(release, found.schema, found.sourceVersionIds);
    const hdr = Math.max(0, Math.min(headerRows || 0, grid.length));
    return {
      result: {
        found: true,
        table: found.schema.table_name,
        relPath: found.schema.rel_path,
        sheet,
        totalRows: grid.length,
        ncols: grid.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0),
        headerRows: hdr,
        header: hdr > 0 ? grid.slice(0, hdr) : [],
        rows: grid,
        note: "原始网格(array-of-arrays)，保留列序与空列；第0行通常为列ID。headerRows 由调用方指定则拆分 header/数据，仅作提示，rows 始终为完整网格。",
        trust: found.component.trust ?? null,
      },
      componentIds: [found.component.componentId],
      artifactIds: [found.component.artifactId],
      sourceVersionIds: releaseSourceVersionIds(release),
    };
  }

  async kbGetQuality(release: ReleaseRecord, componentId?: string): Promise<ToolResult> {
    const components = componentId
      ? (await this.releaseComponents(release)).filter((component) => component.componentId === componentId)
      : await this.releaseComponents(release);
    return {
      result: {
        releaseQuality: release.qualityGate,
        components: components.map((component) => ({
          componentId: component.componentId,
          title: component.title,
          kind: component.kind,
          quality: component.quality,
        })),
      },
      componentIds: components.map((component) => component.componentId),
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

  async tableSchemas(release: ReleaseRecord): Promise<TableSchemaEntry[]> {
    const okfSchemas = this.ctx.okfReader.readOkfTableSchemas(release);
    if (okfSchemas.length > 0) {
      return okfSchemas.map((entry) => ({
        component: { componentId: entry.componentId, artifactId: entry.artifactId, trust: entry.trust ?? null },
        schema: entry.schema,
        sourceVersionIds: entry.sourceVersionIds,
      }));
    }
    const components = await this.releaseComponents(release, ["table_schema_json"]);
    const schemas: TableSchemaEntry[] = [];
    for (const component of components) {
      schemas.push({ component: { ...component, trust: trustFromQuality(component.quality) }, schema: JSON.parse(await this.readComponentText(component)) as TableSchema });
    }
    return schemas;
  }

  async findTableSchema(release: ReleaseRecord, table: string): Promise<TableSchemaEntry | null> {
    const schemas = await this.tableSchemas(release);
    const canonical = this.resolveTableAlias(release, table) ?? table;
    return schemas.find(({ schema, component }) =>
      same(schema.table_name, canonical) || same(component.title, canonical) || same(component.artifactId, canonical)
    ) ?? null;
  }

  private resolveTableAlias(release: ReleaseRecord, value: string): string | null {
    const normalized = aliasKey(value);
    for (const row of this.ctx.okfReader.readOkfTableAliases(release)) {
      const table = row.table ?? row.canonical ?? row.canonicalName ?? "";
      if (!table) continue;
      if (aliasKey(table) === normalized) return table;
      if ((row.aliases ?? []).some((alias) => aliasKey(alias) === normalized)) return table;
    }
    return null;
  }

  /**
   * 读取源表的**原始网格**（array-of-arrays），保留列顺序与空列——
   * 不同于 readTableRows 的对象模式（会丢列序/空列）。用于忠实重建配表格式。
   */
  private async readTableGrid(release: ReleaseRecord, schema: TableSchema, sourceVersionIds?: string[]): Promise<{ sheet: string; grid: unknown[][] }> {
    for (const versionId of (sourceVersionIds?.length ? sourceVersionIds : releaseSourceVersionIds(release))) {
      const file = await this.ctx.sourceService.readFile(versionId, schema.rel_path);
      if (!file) continue;
      const workbook = xlsx.read(file.content, { type: "buffer" });
      const sheetName = workbook.SheetNames[0];
      const grid = xlsx.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], { header: 1, defval: "", blankrows: true });
      return { sheet: sheetName, grid };
    }
    throw new Error(`Source table file not found for ${schema.table_name}: ${schema.rel_path}`);
  }

  private async readMappedTableRows(release: ReleaseRecord, schema: TableSchema, sourceVersionIds?: string[]): Promise<TableReadResult> {
    const { sheet, grid } = await this.readTableGrid(release, schema, sourceVersionIds);
    const mapping = inferTableFieldMapping(schema, grid);
    const rows: import("./types").TableMappedRow[] = [];
    for (const gridRow of grid.slice(mapping.dataStartIndex)) {
      if (!gridRow.some((value) => normalizeCellValue(value) !== "")) continue;
      const rawRow = rawRowFromGridRow(gridRow, mapping.rawKeys);
      const canonical: Record<string, unknown> = {};
      for (const [field, fieldMap] of Object.entries(mapping.fieldMap)) {
        canonical[field] = gridRow[fieldMap.columnIndex] ?? "";
      }
      rows.push({ ...canonical, row: canonical, rawRow, fieldMap: mapping.fieldMap });
    }
    return {
      sheet,
      rows,
      fieldMap: mapping.fieldMap,
      mappedFields: Object.keys(mapping.fieldMap),
      missingFields: (schema.fields ?? []).filter((field) => !(field in mapping.fieldMap)),
      unmappedRawColumns: mapping.unmappedRawColumns,
      headerRowGuess: mapping.headerRowIndex + 1,
      dataStartRow: mapping.dataStartIndex + 1,
      rowCount: { schema: schema.row_count ?? 0, data: rows.length },
      diagnostics: mapping.diagnostics,
    };
  }

  private async findPageComponent(release: ReleaseRecord, page: string): Promise<AssetComponent | null> {
    const pages = await this.releaseComponents(release, ["wiki_page", "table_wiki_page", "topic_index"]);
    const normalized = normalize(page);
    return pages.find((component) =>
      normalize(component.componentId) === normalized ||
      normalize(component.title) === normalized ||
      normalize(component.artifactId) === normalized ||
      normalize(component.artifactId.replace(/^wiki\//u, "")) === normalized
    ) ?? null;
  }

  async releaseComponents(release: ReleaseRecord, kinds?: string[]): Promise<AssetComponent[]> {
    const componentIds = manifestComponentIds(release);
    if (componentIds.length === 0) return [];
    const placeholders = componentIds.map((_, index) => `$${index + 1}`).join(",");
    const params: unknown[] = [...componentIds];
    const kindClause = kinds?.length ? ` AND kind IN (${kinds.map((_, index) => `$${params.length + index + 1}`).join(",")})` : "";
    if (kinds?.length) params.push(...kinds);
    const { rows } = await this.ctx.adapter.query(
      `SELECT * FROM asset_components WHERE component_id IN (${placeholders})${kindClause} ORDER BY group_name, title`,
      params,
    );
    return rows.map(mapComponent);
  }

  async releasePackages(release: ReleaseRecord): Promise<AssetPackage[]> {
    if (release.packageIds.length === 0) return [];
    const placeholders = release.packageIds.map((_, index) => `$${index + 1}`).join(",");
    const { rows } = await this.ctx.adapter.query(`SELECT * FROM asset_packages WHERE package_id IN (${placeholders})`, release.packageIds);
    return rows.map(mapPackage);
  }

  async readComponentText(component: AssetComponent): Promise<string> {
    if (component.storageUri.startsWith("legacy://")) throw new Error(`Legacy component is not materialized locally: ${component.componentId}`);
    const packages = await this.releasePackages({ packageIds: [component.packageId] } as ReleaseRecord);
    const runId = packages[0]?.createdByRunId ?? "";
    const candidates = [
      isAbsolute(component.storageUri) ? component.storageUri : "",
      runId ? join(this.ctx.dataDir, "kb-build-runs", runId, component.storageUri) : "",
      join(this.ctx.dataDir, component.storageUri),
    ].filter(Boolean);
    const path = candidates.find((candidate) => existsSync(candidate));
    if (!path) throw new Error(`Artifact file not found for component ${component.componentId}: ${component.storageUri}`);
    return readFileSync(path, "utf8");
  }

  /** 读取组件产物文件（公共 API，供下载/预览路由使用）。 */
  async getComponentFile(packageId: string, componentId: string): Promise<{
    componentId: string;
    kind: string;
    legacyPath: string;
    storageUri: string;
    content: string;
    truncated: boolean;
  }> {
    const { rows } = await this.ctx.adapter.query(
      "SELECT * FROM asset_components WHERE component_id = $1 AND package_id = $2",
      [componentId, packageId],
    );
    if (rows.length === 0) throw new Error(`Component not found in package: ${componentId}`);
    const component = mapComponent(rows[0]);
    if (component.storageUri.startsWith("legacy://")) {
      throw new Error(`Legacy component is not materialized locally: ${componentId}`);
    }

    const packages = await this.releasePackages({ packageIds: [component.packageId] } as ReleaseRecord);
    const runId = packages[0]?.createdByRunId ?? "";
    const runRoot = runId ? join(this.ctx.dataDir, "kb-build-runs", runId) : "";
    const candidates = [
      isAbsolute(component.storageUri) ? component.storageUri : "",
      runRoot ? join(runRoot, component.storageUri) : "",
      join(this.ctx.dataDir, component.storageUri),
    ].filter(Boolean);

    const resolved = candidates.find((candidate) => existsSync(candidate));
    if (!resolved) throw new Error(`Artifact file not found for component ${componentId}: ${component.storageUri}`);

    // Path-containment guard: resolved file must stay under the run workspace or the data dir.
    const allowedRoots = [runRoot, this.ctx.dataDir].filter(Boolean);
    const contained = allowedRoots.some((root) => {
      const rel = relative(root, resolved);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    });
    if (!contained) throw new Error(`Refusing to read file outside allowed roots: ${componentId}`);

    const MAX_BYTES = 512 * 1024;
    const raw = readFileSync(resolved, "utf8");
    const truncated = raw.length > MAX_BYTES;
    return {
      componentId: component.componentId,
      kind: component.kind,
      legacyPath: component.legacyPath,
      storageUri: component.storageUri,
      content: truncated ? `${raw.slice(0, MAX_BYTES)}\n\n…[truncated ${raw.length - MAX_BYTES} chars]` : raw,
      truncated,
    };
  }
}
