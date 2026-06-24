import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import type { PipelineModelConfig } from "./modelConfig";
import { extractMaxTokens, redactModelConfig } from "./modelConfig";
import { createLlmClient, type JsonSchemaSpec, type LlmClient } from "./llmClient";
import type { WikiSpecSet } from "./specs";
import { loadTableAliases, type TableAliasIndex } from "./tableAliases";
import type { StageResult } from "./types";

interface ExtractedPage {
  type: string;
  title: string;
  source: string;
  facts: Record<string, string>;
  entities: Entity[];
  relationships: Relationship[];
  body: string;
}

interface Entity {
  name: string;
  type: string;
}

interface Relationship {
  source: string;
  relation: string;
  target: string;
}

type ExtractOptions = {
  dataDir: string;
  specs: WikiSpecSet;
  model: string;
  modelConfig?: PipelineModelConfig;
  force: boolean;
  only: string | null;
  onProgress?: (info: { message: string; index: number; total: number }) => void;
};

export async function runExtractStage(options: ExtractOptions): Promise<StageResult> {
  const parsedDir = join(options.dataDir, "processed", "parsed");
  const outputPaths: string[] = [];
  const warnings: string[] = [];
  const wikiRoot = resolve(options.dataDir, "wiki");

  if (!existsSync(parsedDir)) {
    return {
      stage: "extract",
      status: "completed",
      outputPaths,
      warnings: [`missing parsed docs directory: ${parsedDir}`],
    };
  }

  const only = normalizeOnlyFilter(options.only);
  const files = walkMarkdownFiles(parsedDir).filter((absolute) => {
    const rel = relative(parsedDir, absolute).replace(/\\/g, "/");
    return !only || matchesOnlyFilter(rel, only);
  });
  // Build the LLM client once per run so capability state (e.g. whether the
  // model supports response_format) is remembered across every file.
  const client = createLlmClient(resolveModelConfig(options));
  const guidance = buildSpecGuidance(options.specs);
  const usedSlugs = new Map<string, number>();
  const tableAliases = loadTableAliases(options.dataDir);
  const modelConfig = resolveModelConfig(options);
  const aliasFingerprint = tableAliasFingerprint(options.dataDir);
  for (let index = 0; index < files.length; index += 1) {
    const absolute = files[index];
    const rel = relative(parsedDir, absolute).replace(/\\/g, "/");

    const markdown = readFileSync(absolute, "utf8");
    const cacheKey = extractCacheKey({ markdown, rel, specsHash: options.specs.hash, modelConfig, aliasFingerprint });
    const cached = options.force ? null : readExtractCache(options.dataDir, cacheKey);
    const extracted = cached ?? await extractPage(markdown, rel, client, guidance, warnings);
    normalizeTableRefs(extracted, tableAliases);
    writeExtractCache(options.dataDir, cacheKey, extracted);
    const pageType = options.specs.manifest.pageTypes[extracted.type];
    if (!pageType) {
      warnings.push(`${rel}: unknown page type "${extracted.type}", skipped`);
      continue;
    }

    const slug = allocateSlug(slugForPage(rel, extracted.title), pageType.dir, usedSlugs);
    const wikiRel = `wiki/${pageType.dir}/${slug}.md`;
    const metaRel = `wiki/_meta/${slug}.json`;
    const wikiAbs = resolve(options.dataDir, wikiRel);
    const metaAbs = resolve(options.dataDir, metaRel);
    assertContainedOutput(wikiRoot, wikiAbs, wikiRel);
    assertContainedOutput(wikiRoot, metaAbs, metaRel);

    mkdirSync(dirname(wikiAbs), { recursive: true });
    mkdirSync(dirname(metaAbs), { recursive: true });
    writeFileSync(wikiAbs, renderWikiMarkdown(extracted));
    writeFileSync(metaAbs, `${JSON.stringify(toMetaJson(extracted, wikiRel), null, 2)}\n`);
    outputPaths.push(wikiRel, metaRel);
    options.onProgress?.({ message: `extract ${index + 1}/${files.length}: ${rel} → ${extracted.type}${cached ? " (cached)" : ""}`, index, total: files.length });
  }

  outputPaths.sort();
  return { stage: "extract", status: "completed", outputPaths, warnings };
}

async function extractPage(markdown: string, rel: string, client: LlmClient | null, guidance: string, warnings: string[]): Promise<ExtractedPage> {
  const structured = parseStructuredFrontmatter(markdown);
  if (structured) return structured;
  if (!client) return deterministicFallback(markdown, rel);

  try {
    const completion = await client.complete({
      system: `Extract a wiki page from markdown. Return only JSON with type, title, source, facts (an array of {key, value} objects), entities, relationships, and body.\n${guidance}`,
      user: `Source path: processed/parsed/${rel}\n\n${markdown}`,
      maxTokens: extractMaxTokens(),
      jsonSchema: EXTRACTED_PAGE_SCHEMA,
      jsonMode: true,
    });
    return parseExtractedPage(completion.text, markdown, rel);
  } catch (error) {
    if (!(error instanceof ModelJsonParseError)) throw error;
    warnings.push(`${rel}: model returned invalid JSON; used deterministic fallback (${error.detail})`);
    return deterministicFallback(markdown, rel);
  }
}

// Resolve the effective model for extraction: an explicit per-build modelConfig
// wins, then the OPENAI_API_KEY env fallback, otherwise deterministic (no client).
function resolveModelConfig(options: ExtractOptions): PipelineModelConfig {
  const config = options.modelConfig;
  if (config?.provider === "openai-compatible" && config.apiKey) return config;
  if (config?.provider === "anthropic" && config.apiKey) return config;
  if (options.model !== "deterministic" && process.env.OPENAI_API_KEY) {
    return {
      provider: "openai-compatible",
      baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      model: options.model,
      apiKey: process.env.OPENAI_API_KEY,
    };
  }
  return { provider: "deterministic", model: "deterministic" };
}

// Canonical contract for an extracted page. Drives (a) the JSON Schema sent to
// the model for native structured output and (b) what the prompt asks for.
// `facts` is a key/value array, not an open map, because strict structured
// output forbids open-ended objects (additionalProperties must be false).
const GenerationSchema = z.object({
  type: z.string(),
  title: z.string(),
  source: z.string(),
  facts: z.array(z.object({ key: z.string(), value: z.string() })),
  entities: z.array(z.object({ name: z.string(), type: z.string() })),
  relationships: z.array(z.object({ source: z.string(), relation: z.string(), target: z.string() })),
  body: z.string(),
});

// JSON Schema for the wire, tightened to the strict-mode subset both providers
// require: $schema stripped, every object closed (additionalProperties: false)
// with all of its keys marked required.
const EXTRACTED_PAGE_SCHEMA: JsonSchemaSpec = {
  name: "extracted_page",
  schema: tightenSchema(z.toJSONSchema(GenerationSchema)) as Record<string, unknown>,
};

// Lenient validation of the *returned* text. Native structured output should
// already conform, but degraded modes (json_object / plain prompt) may not, so
// every field tolerates wrong types / omissions via .catch and still yields a
// usable page. facts accepts both the key/value array (structured) and a bare
// map (what a model may emit in prompt-only mode).
const optionalString = z.string().trim().min(1).optional().catch(undefined);
const ModelPageSchema = z
  .object({
    type: optionalString,
    title: optionalString,
    source: optionalString,
    facts: z
      .union([
        z.array(
          z
            .object({ key: optionalString, value: z.coerce.string().optional() })
            .catch({ key: undefined, value: undefined }),
        ),
        z.record(z.string(), z.coerce.string()),
      ])
      .optional()
      .catch(undefined),
    entities: z
      .array(z.object({ name: optionalString, type: optionalString }).catch({ name: undefined, type: undefined }))
      .optional()
      .catch(undefined),
    relationships: z
      .array(
        z
          .object({ source: optionalString, relation: optionalString, target: optionalString })
          .catch({ source: undefined, relation: undefined, target: undefined }),
      )
      .optional()
      .catch(undefined),
    body: z.coerce.string().optional().catch(undefined),
  })
  .catch({});

const CachedPageSchema = z.object({
  type: z.string(),
  title: z.string(),
  source: z.string(),
  facts: z.record(z.string(), z.string()),
  entities: z.array(z.object({ name: z.string(), type: z.string() })),
  relationships: z.array(z.object({ source: z.string(), relation: z.string(), target: z.string() })),
  body: z.string(),
});

// Force a generated JSON Schema into the strict-mode subset both OpenAI
// (strict: true) and Anthropic (output_config) accept.
function tightenSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(tightenSchema);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "$schema") continue;
      out[key] = tightenSchema(value);
    }
    if (out.type === "object" && out.properties && typeof out.properties === "object") {
      out.additionalProperties = false;
      out.required = Object.keys(out.properties as Record<string, unknown>);
    }
    return out;
  }
  return node;
}

function parseExtractedPage(text: string, markdown: string, rel: string): ExtractedPage {
  const data = ModelPageSchema.parse(parseModelJson(text, rel));
  const fallback = deterministicFallback(markdown, rel);
  return {
    type: data.type ?? fallback.type,
    title: data.title ?? fallback.title,
    source: data.source ?? fallback.source,
    facts: factsToRecord(data.facts),
    entities: (data.entities ?? []).map((entity) => ({
      name: entity.name ?? fallback.title,
      type: entity.type ?? "concept",
    })),
    relationships: (data.relationships ?? []).map((relationship) => ({
      source: relationship.source ?? fallback.title,
      relation: relationship.relation ?? "references",
      target: relationship.target ?? fallback.title,
    })),
    body: data.body ?? fallback.body,
  };
}

// Normalize facts to a map whether the model returned a {key,value} array
// (structured output) or a bare object (prompt-only mode).
function factsToRecord(
  facts: Array<{ key?: string; value?: string }> | Record<string, string> | undefined,
): Record<string, string> {
  if (!facts) return {};
  if (Array.isArray(facts)) {
    const out: Record<string, string> = {};
    for (const entry of facts) {
      if (entry?.key) out[entry.key] = entry.value ?? "";
    }
    return out;
  }
  return facts;
}

// Steer the model to emit a page `type` from the active legislation profile's
// page types (otherwise extract silently skips every page as "unknown page type"),
// and to follow each type's required sections/facts plus the allowed entity/relation types.
function buildSpecGuidance(specs: WikiSpecSet): string {
  const lines: string[] = [];
  const pageTypeIds = Object.keys(specs.manifest.pageTypes);
  lines.push(`The "type" field MUST be exactly one of these page type ids: ${pageTypeIds.join(", ")}.`);
  lines.push("Pick the single best-fitting type. Do not invent new type values.");
  for (const id of pageTypeIds) {
    const spec = specs.specs[id];
    if (!spec) continue;
    const parts: string[] = [];
    if (spec.requiredSections.length) parts.push(`required sections (use as "## " headings in body): ${spec.requiredSections.join(", ")}`);
    if (spec.requiredFacts.length) parts.push(`required facts (include each as a {key, value} entry): ${spec.requiredFacts.join(", ")}`);
    if (parts.length) lines.push(`- ${id}: ${parts.join("; ")}`);
  }
  if (specs.entityTypes.size) lines.push(`Each entity "type" should be one of: ${[...specs.entityTypes].join(", ")}.`);
  if (specs.relationTypes.size) lines.push(`Each relationship "relation" should be one of: ${[...specs.relationTypes].join(", ")}.`);
  return lines.join("\n");
}

function parseStructuredFrontmatter(markdown: string): ExtractedPage | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(markdown);
  if (!match) return null;

  const parsed = parseFrontmatter(match[1]);
  if (!parsed.type || !parsed.title) return null;

  return {
    type: parsed.type,
    title: parsed.title,
    source: parsed.source ?? "",
    facts: parsed.facts,
    entities: parsed.entities,
    relationships: parsed.relationships,
    body: match[2],
  };
}

function parseFrontmatter(frontmatter: string): Omit<ExtractedPage, "body"> {
  const out: Omit<ExtractedPage, "body"> = {
    type: "",
    title: "",
    source: "",
    facts: {},
    entities: [],
    relationships: [],
  };
  const lines = frontmatter.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const scalar = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!scalar) continue;

    const [, key, value] = scalar;
    if (value !== "") {
      if (key === "type" || key === "title" || key === "source") {
        out[key] = value.trim();
      }
      continue;
    }

    const block: string[] = [];
    while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) {
      block.push(lines[index + 1]);
      index += 1;
    }

    if (key === "facts") out.facts = parseMapBlock(block);
    if (key === "entities") out.entities = parseEntitiesBlock(block);
    if (key === "relationships") out.relationships = parseRelationshipsBlock(block);
  }

  return out;
}

function parseMapBlock(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines) {
    const match = /^\s+([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (match) out[match[1]] = match[2].trim();
  }
  return out;
}

function parseObjectListBlock(lines: string[]): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  let current: Record<string, string> | null = null;

  for (const line of lines) {
    const item = /^\s*-\s+([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (item) {
      current = { [item[1]]: item[2].trim() };
      out.push(current);
      continue;
    }

    const property = /^\s+([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (property && current) {
      current[property[1]] = property[2].trim();
    }
  }

  return out;
}

function parseEntitiesBlock(lines: string[]): Entity[] {
  return parseObjectListBlock(lines)
    .map((entity) => ({ name: entity.name, type: entity.type }))
    .filter((entity): entity is Entity => Boolean(entity.name && entity.type));
}

function parseRelationshipsBlock(lines: string[]): Relationship[] {
  return parseObjectListBlock(lines)
    .map((relationship) => ({
      source: relationship.source,
      relation: relationship.relation,
      target: relationship.target,
    }))
    .filter((relationship): relationship is Relationship =>
      Boolean(relationship.source && relationship.relation && relationship.target),
    );
}

class ModelJsonParseError extends Error {
  readonly detail: string;

  constructor(rel: string, detail: string) {
    super(`Model extraction returned invalid JSON for ${rel}: ${detail}`);
    this.name = "ModelJsonParseError";
    this.detail = detail;
  }
}

function parseModelJson(content: string, rel: string): unknown {
  const candidates = [
    content,
    stripMarkdownFence(content),
    extractFirstJsonObject(content),
  ].filter((candidate): candidate is string => Boolean(candidate?.trim()));

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new ModelJsonParseError(rel, detail);
}

function stripMarkdownFence(content: string): string {
  const trimmed = content.trim();
  const match = /^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/u.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

function extractFirstJsonObject(content: string): string | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return content.slice(start, end + 1).trim();
}

function deterministicFallback(markdown: string, rel: string): ExtractedPage {
  const title = firstHeading(markdown) ?? titleFromPath(rel);
  return {
    type: "concept",
    title,
    source: `processed/parsed/${rel}`,
    facts: {},
    entities: [{ name: title, type: "concept" }],
    relationships: [],
    body: stripFrontmatter(markdown),
  };
}

function renderWikiMarkdown(page: ExtractedPage): string {
  const body = page.body.trim();
  if (/^#\s+/m.test(body)) return `${body}\n`;
  return `# ${page.title}\n\n${body}\n`;
}

function toMetaJson(page: ExtractedPage, wikiPath: string): Record<string, unknown> {
  return {
    type: page.type,
    title: page.title,
    source: page.source,
    facts: page.facts,
    entities: page.entities,
    relationships: page.relationships,
    wiki_path: wikiPath,
  };
}

function normalizeTableRefs(page: ExtractedPage, tableAliases: TableAliasIndex): void {
  const canonicalTables = new Set<string>();
  const configTable = page.facts.config_table;
  if (configTable) {
    for (const table of tableAliases.resolveMany(configTable)) canonicalTables.add(table);
    if (canonicalTables.size > 0) page.facts.config_table = [...canonicalTables].join(", ");
  }

  page.entities = page.entities.map((entity) => {
    const canonical = tableAliases.resolve(entity.name);
    if (!canonical) return entity;
    canonicalTables.add(canonical);
    return { ...entity, name: canonical, type: isTableEntityType(entity.type) ? entity.type : "config_table" };
  });

  page.relationships = page.relationships.map((relationship) => {
    const source = tableAliases.resolve(relationship.source) ?? relationship.source;
    const target = tableAliases.resolve(relationship.target) ?? relationship.target;
    if (source !== relationship.source) canonicalTables.add(source);
    if (target !== relationship.target) canonicalTables.add(target);
    return { ...relationship, source, target };
  });

  for (const table of dependencySectionTables(page.body, tableAliases)) canonicalTables.add(table);

  if (canonicalTables.size > 0) {
    page.facts.config_table = [...canonicalTables].sort().join(", ");
  }
  for (const table of canonicalTables) {
    addUniqueEntity(page.entities, { name: table, type: "config_table" });
    addUniqueRelationship(page.relationships, { source: page.title, relation: "configured_in", target: table });
  }
  page.body = annotateTableAliasesInDependencySections(page.body, tableAliases);
  page.body = alignDataDependenciesSection(page.body, canonicalTables);
}

function isTableEntityType(type: string): boolean {
  return ["table", "config_table"].includes(type);
}

function addUniqueEntity(entities: Entity[], entity: Entity): void {
  if (entities.some((existing) => existing.name === entity.name && existing.type === entity.type)) return;
  entities.push(entity);
}

function addUniqueRelationship(relationships: Relationship[], relationship: Relationship): void {
  if (relationships.some((existing) =>
    existing.source === relationship.source &&
    existing.relation === relationship.relation &&
    existing.target === relationship.target
  )) {
    return;
  }
  relationships.push(relationship);
}

function annotateTableAliasesInDependencySections(body: string, tableAliases: TableAliasIndex): string {
  const replacements = tableAliases.replacements();
  if (replacements.length === 0) return body;
  const lines = body.split(/\r?\n/u);
  let inDependencySection = false;
  return lines.map((line) => {
    const heading = /^(#{1,6})\s+(.+?)\s*$/u.exec(line);
    if (heading) {
      inDependencySection = dependencyHeading(heading[2]);
      return line;
    }
    if (!inDependencySection) return line;
    let next = line;
    for (const { alias, canonical } of replacements) {
      if (!next.includes(alias) || next.includes(canonical)) continue;
      next = next.replace(new RegExp(`${escapeRegExp(alias)}(?!\\s*[（(]${escapeRegExp(canonical)}[）)])`, "gu"), `${alias}（${canonical}）`);
    }
    return next;
  }).join("\n");
}

function dependencySectionTables(body: string, tableAliases: TableAliasIndex): string[] {
  const out = new Set<string>();
  const lines = body.split(/\r?\n/u);
  let inDependencySection = false;
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/u.exec(line);
    if (heading) {
      inDependencySection = dependencyHeading(heading[2]);
      continue;
    }
    if (!inDependencySection) continue;
    for (const table of tableAliases.resolveMany(line)) out.add(table);
  }
  return [...out].sort();
}

function alignDataDependenciesSection(body: string, canonicalTables: Set<string>): string {
  const tables = [...canonicalTables].sort();
  if (tables.length === 0) return body;
  const lines = body.split(/\r?\n/u);
  const headingIndex = lines.findIndex((line) => {
    const heading = /^(#{1,6})\s+(.+?)\s*$/u.exec(line);
    return Boolean(heading && heading[2].trim().toLowerCase() === "data dependencies");
  });
  const dependencyLines = tables.map((table) => `- ${table}`);
  if (headingIndex < 0) {
    return `${body.trimEnd()}\n\n## Data Dependencies\n${dependencyLines.join("\n")}`;
  }

  let endIndex = headingIndex + 1;
  while (endIndex < lines.length && !/^(#{1,6})\s+.+?\s*$/u.test(lines[endIndex])) endIndex += 1;

  const existing = lines.slice(headingIndex + 1, endIndex);
  const existingText = existing.join("\n").trim();
  const hasOnlyEmptyMarker = existingText === "" || /^(?:[(（]?\s*(无|none|n\/a|na|null|no)\s*[)）]?|[-*]\s*(?:无|none|n\/a|na|null|no))$/iu.test(existingText);
  const nextSection = hasOnlyEmptyMarker
    ? dependencyLines
    : [...existing, ...dependencyLines.filter((line) => !existingText.includes(line.slice(2)))];
  return [...lines.slice(0, headingIndex + 1), ...nextSection, ...lines.slice(endIndex)].join("\n");
}

function dependencyHeading(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "data dependencies" || ["配置表依赖", "关联配置表", "数据依赖", "表依赖"].includes(normalized);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function normalizeOnlyFilter(only: string | null): string | null {
  if (!only) return null;
  return only.replace(/\\/g, "/").replace(/^\/+/, "");
}

function matchesOnlyFilter(rel: string, only: string): boolean {
  return rel === only || `processed/parsed/${rel}` === only || basename(rel) === only || rel.endsWith(`/${only}`);
}

function extractCacheKey(input: {
  markdown: string;
  rel: string;
  specsHash: string;
  modelConfig: PipelineModelConfig;
  aliasFingerprint: string;
}): string {
  const hash = createHash("sha256");
  hash.update("extract-cache-v1\0");
  hash.update(input.rel);
  hash.update("\0");
  hash.update(input.markdown);
  hash.update("\0");
  hash.update(input.specsHash);
  hash.update("\0");
  hash.update(JSON.stringify(redactModelConfig(input.modelConfig)));
  hash.update("\0");
  hash.update(input.aliasFingerprint);
  return hash.digest("hex");
}

function readExtractCache(dataDir: string, cacheKey: string): ExtractedPage | null {
  const file = extractCachePath(dataDir, cacheKey);
  if (!existsSync(file)) return null;
  try {
    return CachedPageSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

function writeExtractCache(dataDir: string, cacheKey: string, extracted: ExtractedPage): void {
  const file = extractCachePath(dataDir, cacheKey);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(extracted, null, 2)}\n`);
}

function extractCachePath(dataDir: string, cacheKey: string): string {
  return join(dataDir, ".kh-cache", "extract", `${cacheKey}.json`);
}

function tableAliasFingerprint(dataDir: string): string {
  const hash = createHash("sha256");
  for (const rel of ["table_aliases.json", "processed/table_aliases.json", "wiki/_tables/table_aliases.json"]) {
    const file = join(dataDir, ...rel.split("/"));
    hash.update(rel);
    hash.update("\0");
    if (existsSync(file)) hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function slugForPage(path: string, title: string): string {
  const basenameSlug = slug(basename(path, extname(path)));
  const pathSlug = slug(path.replace(/\.[^/.]+$/u, "").replace(/[\\/]+/g, "-"));
  const titleSlug = slug(title);
  if ((genericSlug(pathSlug) || genericSlug(basenameSlug)) && !genericSlug(titleSlug)) return titleSlug;
  return pathSlug;
}

function slug(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/gu, " ")
    .replace(/&[a-z0-9#]+;/giu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) return `page-${shortHash(value)}`;
  if (/^\d+$/u.test(normalized)) return `page-${normalized}`;
  return normalized;
}

function genericSlug(value: string): boolean {
  return value === "page" || /^page-\d*$/u.test(value);
}

function allocateSlug(slugBase: string, group: string, usedSlugs: Map<string, number>): string {
  const key = `${group}/${slugBase}`;
  const count = usedSlugs.get(key) ?? 0;
  usedSlugs.set(key, count + 1);
  return count === 0 ? slugBase : `${slugBase}-${count + 1}`;
}

function shortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

function firstHeading(markdown: string): string | null {
  return /^#\s+(.+?)\s*$/m.exec(stripFrontmatter(markdown))?.[1]?.trim() ?? null;
}

function titleFromPath(path: string): string {
  return basename(path, extname(path)).replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u, "");
}

function assertContainedOutput(outputRoot: string, outputPath: string, outputRel: string) {
  const relativeToRoot = relative(outputRoot, outputPath);
  if (relativeToRoot.startsWith("..") || isAbsolute(relativeToRoot)) {
    throw new Error(`Refusing to write extract output outside wiki: ${outputRel}`);
  }
}

function walkMarkdownFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === ".cache") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkMarkdownFiles(path));
    else if (!entry.name.startsWith("~") && extname(entry.name).toLowerCase() === ".md") out.push(path);
  }
  return out.sort();
}
