import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface WikiSpecSet {
  hash: string;
  manifest: {
    pageTypes: Record<string, { dir: string; template: string }>;
  };
  specs: Record<string, { requiredSections: string[]; requiredFacts: string[] }>;
  entityTypes: Set<string>;
  relationTypes: Set<string>;
}

type WikiPageType = { dir: string; template: string };
type WikiPageTypeInput = { dir: string; template?: string };

export function loadWikiSpecs(specDir: string): WikiSpecSet {
  const manifestRaw = readFileSync(join(specDir, "manifest.json"), "utf8");
  const manifestJson = JSON.parse(manifestRaw);
  const pageTypes = normalizePageTypes(
    (manifestJson.page_types ?? {}) as Record<string, WikiPageTypeInput>,
    manifestJson.spec_files,
  );
  const files = readdirSync(specDir)
    .filter((file) => file.endsWith(".md"))
    .sort();
  const hash = createHash("sha256");
  hash.update(manifestRaw);
  const specs: WikiSpecSet["specs"] = {};

  for (const [type, value] of Object.entries(pageTypes)) {
    const template = value.template;
    if (!template) continue;
    const body = readFileSync(join(specDir, template), "utf8");
    hash.update(template);
    hash.update(body);
    specs[type] = {
      requiredSections: extractRequiredSections(body),
      requiredFacts: extractRequiredFacts(body),
    };
  }

  for (const file of files) {
    if (!Object.values(pageTypes).some((entry) => entry.template === file)) {
      hash.update(file);
      hash.update(readFileSync(join(specDir, file), "utf8"));
    }
  }

  return {
    hash: hash.digest("hex"),
    manifest: { pageTypes: normalizePageTypes(pageTypes) },
    specs,
    entityTypes: new Set(manifestJson.entity_types ?? []),
    relationTypes: new Set(manifestJson.relation_types ?? []),
  };
}

function normalizePageTypes(input: Record<string, WikiPageTypeInput>, specFiles?: unknown) {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      { dir: value.dir, template: value.template ?? findSpecFileTemplate(key, specFiles) ?? `${key}.md` },
    ]),
  ) as Record<string, WikiPageType>;
}

function findSpecFileTemplate(pageType: string, specFiles: unknown): string | undefined {
  if (Array.isArray(specFiles)) {
    return specFiles.find((file): file is string => file === `${pageType}.md`);
  }

  if (!specFiles || typeof specFiles !== "object") {
    return undefined;
  }

  const entry = (specFiles as Record<string, unknown>)[pageType];
  if (typeof entry === "string") {
    return entry;
  }
  if (entry && typeof entry === "object") {
    const value = entry as Record<string, unknown>;
    if (typeof value.template === "string") return value.template;
    if (typeof value.file === "string") return value.file;
    if (typeof value.path === "string") return value.path;
  }
  return undefined;
}

function extractRequiredSections(markdown: string): string[] {
  const legacySections: string[] = [];
  let inStructureSection = false;

  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)?.[1]?.trim();
    if (heading) {
      inStructureSection = heading === "章节结构";
      continue;
    }

    if (!inStructureSection) {
      continue;
    }

    for (const match of line.matchAll(/`##\s+([^`]+?)`/g)) {
      legacySections.push(match[1].trim());
    }
  }

  if (legacySections.length > 0) {
    return legacySections;
  }

  return markdown
    .split(/\r?\n/)
    .map((line) => /^##\s+(.+?)\s*$/.exec(line)?.[1]?.trim())
    .filter((value): value is string => Boolean(value));
}

function extractRequiredFacts(markdown: string): string[] {
  const facts = new Set<string>();
  let currentSection = "";
  let table: {
    keyColumnIndex: number;
    requiredColumnIndex?: number;
    legacyFactsSection: boolean;
  } | undefined;

  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)?.[1]?.trim();
    if (heading) {
      currentSection = heading;
      table = undefined;
      continue;
    }

    if (!line.includes("|")) {
      table = undefined;
      continue;
    }

    const cells = line
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean);

    if (cells.length < 2) {
      table = undefined;
      continue;
    }

    if (cells.every(isMarkdownTableSeparator)) {
      continue;
    }

    if (!table) {
      const keyColumnIndex = cells.findIndex(isFactKeyColumnHeader);
      const requiredColumnIndex = cells.findIndex(isRequiredColumnHeader);
      const legacyFactsSection = isLegacyFactsSection(currentSection);
      const explicitFactsTable =
        keyColumnIndex >= 0 &&
        requiredColumnIndex >= 0 &&
        !isExampleSection(currentSection) &&
        (isFactsTableSection(currentSection) || currentSection === "" || cells.length >= 3);

      if (keyColumnIndex >= 0 && (legacyFactsSection || explicitFactsTable)) {
        table = {
          keyColumnIndex,
          requiredColumnIndex: requiredColumnIndex >= 0 ? requiredColumnIndex : undefined,
          legacyFactsSection,
        };
      }
      continue;
    }

    if (table.keyColumnIndex >= cells.length) {
      continue;
    }

    if (table.legacyFactsSection && table.requiredColumnIndex === undefined) {
      addFactKeys(facts, cells[table.keyColumnIndex]);
      continue;
    }

    if (
      table.requiredColumnIndex !== undefined &&
      table.requiredColumnIndex < cells.length &&
      isRequiredValue(cells[table.requiredColumnIndex])
    ) {
      addFactKeys(facts, cells[table.keyColumnIndex]);
    }
  }
  return [...facts];
}

function isMarkdownTableSeparator(cell: string): boolean {
  return /^:?-{3,}:?$/.test(cell);
}

function isRequiredColumnHeader(cell: string): boolean {
  const normalized = cell.trim().toLowerCase();
  return normalized === "required" || normalized === "必填" || normalized === "是否必填";
}

function isRequiredValue(cell: string): boolean {
  return /^(yes|required|true|必填|是)$/i.test(cell);
}

function isFactKeyColumnHeader(cell: string): boolean {
  const normalized = stripWrappingBackticks(cell).toLowerCase();
  return normalized === "key" || normalized === "fact" || normalized === "facts" || normalized === "fact key";
}

function isLegacyFactsSection(section: string): boolean {
  const normalized = section.toLowerCase();
  return normalized.includes("facts") && normalized.includes("必填") && normalized.includes("key");
}

function isFactsTableSection(section: string): boolean {
  const normalized = section.toLowerCase();
  return (
    isLegacyFactsSection(section) ||
    normalized.includes("facts") ||
    normalized.includes("fact") ||
    normalized.includes("data dependencies") ||
    normalized.includes("dependencies") ||
    normalized.includes("数据依赖") ||
    normalized.includes("依赖")
  );
}

function isExampleSection(section: string): boolean {
  const normalized = section.toLowerCase();
  return normalized === "示例" || normalized.includes("example");
}

function addFactKeys(facts: Set<string>, cell: string): void {
  for (const key of normalizeFactKeys(cell)) {
    facts.add(key);
  }
}

function normalizeFactKeys(cell: string): string[] {
  const backticked = [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  const values = backticked.length > 0 ? backticked : [cell];

  return values
    .flatMap((value) => value.split(/\s*\/\s*/))
    .map(stripWrappingBackticks)
    .filter(Boolean);
}

function stripWrappingBackticks(value: string): string {
  return value.trim().replace(/^`+|`+$/g, "").trim();
}
