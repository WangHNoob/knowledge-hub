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

export function loadWikiSpecs(specDir: string): WikiSpecSet {
  const manifestRaw = readFileSync(join(specDir, "manifest.json"), "utf8");
  const manifestJson = JSON.parse(manifestRaw);
  const pageTypes = (manifestJson.page_types ?? {}) as Record<string, WikiPageType>;
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

function normalizePageTypes(input: Record<string, { dir: string; template: string }>) {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, { dir: value.dir, template: value.template }]),
  );
}

function extractRequiredSections(markdown: string): string[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => /^##\s+(.+?)\s*$/.exec(line)?.[1]?.trim())
    .filter((value): value is string => Boolean(value));
}

function extractRequiredFacts(markdown: string): string[] {
  const facts = new Set<string>();
  let requiredColumnIndex: number | undefined;

  for (const line of markdown.split(/\r?\n/)) {
    if (!line.includes("|")) {
      requiredColumnIndex = undefined;
      continue;
    }

    const cells = line
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean);

    if (cells.length < 2 || cells.every(isMarkdownTableSeparator)) {
      continue;
    }

    const headerRequiredIndex = cells.findIndex(isRequiredColumnHeader);
    if (headerRequiredIndex >= 0) {
      requiredColumnIndex = headerRequiredIndex;
      continue;
    }

    if (requiredColumnIndex === undefined || requiredColumnIndex >= cells.length) {
      continue;
    }

    if (cells[0].toLowerCase() !== "key" && isRequiredValue(cells[requiredColumnIndex])) {
      facts.add(cells[0]);
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
