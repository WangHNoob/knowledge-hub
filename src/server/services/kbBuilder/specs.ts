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

export function loadWikiSpecs(specDir: string): WikiSpecSet {
  const manifestRaw = readFileSync(join(specDir, "manifest.json"), "utf8");
  const manifestJson = JSON.parse(manifestRaw);
  const files = readdirSync(specDir)
    .filter((file) => file.endsWith(".md"))
    .sort();
  const hash = createHash("sha256");
  hash.update(manifestRaw);
  const specs: WikiSpecSet["specs"] = {};

  for (const [type, value] of Object.entries<Record<string, { dir: string; template: string }>>(
    manifestJson.page_types ?? {},
  )) {
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
    if (!Object.values(manifestJson.page_types ?? {}).some((entry: any) => entry.template === file)) {
      hash.update(file);
      hash.update(readFileSync(join(specDir, file), "utf8"));
    }
  }

  return {
    hash: hash.digest("hex"),
    manifest: { pageTypes: normalizePageTypes(manifestJson.page_types ?? {}) },
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
  for (const line of markdown.split(/\r?\n/)) {
    const cells = line
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean);
    if (cells.length >= 2 && cells[0] !== "---" && cells[0].toLowerCase() !== "key") {
      const required = cells.some((cell) => /^(yes|required|true|必填|是)$/i.test(cell));
      if (required) facts.add(cells[0]);
    }
  }
  return [...facts];
}
