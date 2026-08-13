import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import type { ReleaseRecord } from "../../types";
import type { OkfDenseIndex } from "../okf/hybridSearch";
import type { OkfSearchIndex } from "../okf/searchIndex";
import {
  objectArg,
  parseOkfPage,
  walkMarkdown,
} from "./utils";
import type {
  OkfGraphAsset,
  OkfPage,
  OkfTableAliasEntry,
  OkfTableSchemaEntry,
} from "./types";

/**
 * OKF（Open Knowledge Format）bundle 读取器：从发布物的冻结 manifest 中解析
 * bundle 目录并读取 pages / graph / tables / aliases / search index / dense index。
 *
 * 从 KnowledgeQueryService 拆出（纯移动，行为不变）：所有 OKF 文件读取集中于此，
 * 便于独立测试与路径包含防护的单一维护点。
 */
export class OkfBundleReader {
  constructor(private readonly dataDir: string) {}

  private readOkfJsonAsset<T>(release: ReleaseRecord, manifestKey: string, fallbackUri: string): T | null {
    const okf = objectArg((release.manifest as Record<string, unknown>).okf);
    const uri = typeof okf[manifestKey] === "string" && String(okf[manifestKey]).trim() ? String(okf[manifestKey]) : fallbackUri;
    const full = this.okfBundleFile(release, uri);
    if (!existsSync(full)) return null;
    return JSON.parse(readFileSync(full, "utf8")) as T;
  }

  okfBundleDir(release: ReleaseRecord): string {
    const okf = objectArg((release.manifest as Record<string, unknown>).okf);
    const bundleUri = typeof okf.bundleUri === "string" && okf.bundleUri.trim() ? okf.bundleUri : `releases/${release.releaseId}/okf_bundle`;
    const bundleDir = isAbsolute(bundleUri) ? bundleUri : join(this.dataDir, ...bundleUri.split(/[\\/]/u));
    const contained = (() => {
      const rel = relative(this.dataDir, bundleDir);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    })();
    if (!contained) throw new Error(`Refusing to read OKF bundle outside data dir: ${bundleUri}`);
    if (!existsSync(bundleDir)) throw new Error(`Current release OKF bundle not found: ${bundleUri}`);
    return bundleDir;
  }

  okfBundleFile(release: ReleaseRecord, uri: string): string {
    const bundleDir = this.okfBundleDir(release);
    const full = join(bundleDir, ...uri.replace(/^\/+/u, "").split(/[\\/]/u));
    const rel = relative(bundleDir, full);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Refusing to read OKF asset outside bundle: ${uri}`);
    return full;
  }

  readOkfPages(release: ReleaseRecord): OkfPage[] {
    const bundleDir = this.okfBundleDir(release);
    return walkMarkdown(bundleDir)
      .map((absolute) => {
        const rel = relative(bundleDir, absolute).replace(/\\/g, "/");
        if (rel === "index.md" || rel === "log.md") return null;
        return parseOkfPage(`/${rel}`, readFileSync(absolute, "utf8"));
      })
      .filter((page): page is OkfPage => Boolean(page?.componentId));
  }

  readOkfGraph(release: ReleaseRecord): OkfGraphAsset | null {
    return this.readOkfJsonAsset<OkfGraphAsset>(release, "graphUri", "graph/graph.json");
  }

  readOkfTableSchemas(release: ReleaseRecord): OkfTableSchemaEntry[] {
    const manifest = this.readOkfJsonAsset<{ tables?: OkfTableSchemaEntry[] }>(release, "tableSchemasUri", "tables/schemas.json");
    return Array.isArray(manifest?.tables) ? manifest.tables.filter((entry) => Boolean(entry.componentId && entry.schema?.table_name)) : [];
  }

  readOkfTableAliases(release: ReleaseRecord): OkfTableAliasEntry[] {
    const manifest = this.readOkfJsonAsset<{ aliases?: OkfTableAliasEntry[] }>(release, "tableAliasesUri", "tables/aliases.json");
    return Array.isArray(manifest?.aliases) ? manifest.aliases : [];
  }

  readOkfSearchIndex(release: ReleaseRecord): OkfSearchIndex | null {
    const index = this.readOkfJsonAsset<OkfSearchIndex>(release, "searchIndexUri", "search/index.json");
    return index?.okfAssetType === "search_index" && Array.isArray(index.pages) ? index : null;
  }

  readOkfDenseIndex(release: ReleaseRecord): OkfDenseIndex | null {
    return this.readOkfJsonAsset<OkfDenseIndex>(release, "denseIndexUri", "search/dense.json");
  }
}
