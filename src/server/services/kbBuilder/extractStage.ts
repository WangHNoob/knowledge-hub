import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { PipelineModelConfig } from "./modelConfig";
import { extractMaxTokens } from "./modelConfig";
import { anthropicMessagesEndpoint } from "./modelConnectivity";
import type { WikiSpecSet } from "./specs";
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
  for (let index = 0; index < files.length; index += 1) {
    const absolute = files[index];
    const rel = relative(parsedDir, absolute).replace(/\\/g, "/");

    const markdown = readFileSync(absolute, "utf8");
    const extracted = await extractPage(markdown, rel, options);
    const pageType = options.specs.manifest.pageTypes[extracted.type];
    if (!pageType) {
      warnings.push(`${rel}: unknown page type "${extracted.type}", skipped`);
      continue;
    }

    const slug = slugFromPath(rel);
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
    options.onProgress?.({ message: `extract ${index + 1}/${files.length}: ${rel} → ${extracted.type}`, index, total: files.length });
  }

  outputPaths.sort();
  return { stage: "extract", status: "completed", outputPaths, warnings };
}

async function extractPage(markdown: string, rel: string, options: ExtractOptions): Promise<ExtractedPage> {
  const structured = parseStructuredFrontmatter(markdown);
  if (structured) return structured;

  const guidance = buildSpecGuidance(options.specs);

  if (options.modelConfig?.provider === "openai-compatible" && options.modelConfig.apiKey) {
    return extractWithOpenAI(markdown, rel, options.modelConfig, guidance);
  }

  if (options.modelConfig?.provider === "anthropic" && options.modelConfig.apiKey) {
    return extractWithAnthropic(markdown, rel, options.modelConfig, guidance);
  }

  if (options.model !== "deterministic" && process.env.OPENAI_API_KEY) {
    return extractWithOpenAI(markdown, rel, {
      provider: "openai-compatible",
      baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      model: options.model,
      apiKey: process.env.OPENAI_API_KEY,
    }, guidance);
  }

  return deterministicFallback(markdown, rel);
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
    if (spec.requiredFacts.length) parts.push(`required facts keys: ${spec.requiredFacts.join(", ")}`);
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

async function extractWithOpenAI(markdown: string, rel: string, config: Extract<PipelineModelConfig, { provider: "openai-compatible" }>, guidance: string): Promise<ExtractedPage> {
  const baseUrl = config.baseUrl.replace(/\/+$/u, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Extract a wiki page from markdown. Return JSON with type, title, source, facts, entities, relationships, and body.\n" +
            guidance,
        },
        { role: "user", content: `Source path: processed/parsed/${rel}\n\n${markdown}` },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI extraction failed for ${rel}: ${response.status} ${response.statusText}${await formatErrorBody(response)}`);
  }

  const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`OpenAI extraction returned no content for ${rel}`);
  }

  return normalizeExtractedJson(JSON.parse(content), markdown, rel);
}

async function extractWithAnthropic(markdown: string, rel: string, config: Extract<PipelineModelConfig, { provider: "anthropic" }>, guidance: string): Promise<ExtractedPage> {
  const response = await fetch(anthropicMessagesEndpoint(config.baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.apiKey ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: extractMaxTokens(),
      system: "Extract a wiki page from markdown. Return only JSON with type, title, source, facts, entities, relationships, and body.\n" + guidance,
      messages: [
        { role: "user", content: [{ type: "text", text: `Source path: processed/parsed/${rel}\n\n${markdown}` }] },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic extraction failed for ${rel}: ${response.status} ${response.statusText}${await formatErrorBody(response)}`);
  }

  const json = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };
  const content = json.content?.find((item) => item.type === "text" && item.text)?.text;
  if (!content) {
    throw new Error(`Anthropic extraction returned no content for ${rel}`);
  }

  return normalizeExtractedJson(JSON.parse(content), markdown, rel);
}

function normalizeExtractedJson(value: unknown, markdown: string, rel: string): ExtractedPage {
  const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const fallback = deterministicFallback(markdown, rel);
  return {
    type: stringValue(input.type) ?? fallback.type,
    title: stringValue(input.title) ?? fallback.title,
    source: stringValue(input.source) ?? fallback.source,
    facts: recordOfStrings(input.facts),
    entities: arrayOfRecords(input.entities).map((entity) => ({
      name: stringValue(entity.name) ?? fallback.title,
      type: stringValue(entity.type) ?? "concept",
    })),
    relationships: arrayOfRecords(input.relationships).map((relationship) => ({
      source: stringValue(relationship.source) ?? fallback.title,
      relation: stringValue(relationship.relation) ?? "references",
      target: stringValue(relationship.target) ?? fallback.title,
    })),
    body: stringValue(input.body) ?? fallback.body,
  };
}

async function formatErrorBody(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    if (!text) return "";
    const trimmed = text.length > 800 ? `${text.slice(0, 800)}…` : text;
    return ` — ${trimmed}`;
  } catch {
    return "";
  }
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

function normalizeOnlyFilter(only: string | null): string | null {
  if (!only) return null;
  return only.replace(/\\/g, "/").replace(/^\/+/, "");
}

function matchesOnlyFilter(rel: string, only: string): boolean {
  return rel === only || `processed/parsed/${rel}` === only || basename(rel) === only || rel.endsWith(`/${only}`);
}

function slugFromPath(path: string): string {
  return slug(path.replace(/\.[^/.]+$/u, "").replace(/[\\/]+/g, "-"));
}

function slug(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "page";
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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function recordOfStrings(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== null && entry !== undefined)
      .map(([key, entry]) => [key, String(entry)]),
  );
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry));
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
