# Native KB Builder Pipeline Quality Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a native Knowledge Hub pipeline that consumes one immutable source bundle version and produces one governed knowledge asset package with wiki pages, table schemas, graph assets, evidence, review tasks, and quality scores.

**Architecture:** Implement the old kb-builder output contract inside this TypeScript app without calling the old Python entrypoints. The pipeline is split into materialization, native stages, output collection, quality gates, package registration, API routes, and frontend controls so each part is testable and replaceable.

**Tech Stack:** TypeScript, Fastify, PGlite/PostgreSQL, React, TanStack Query, Vitest, `mammoth` for `.docx`, `xlsx` for Excel parsing, native `fetch` for OpenAI-compatible extraction when configured.

---

## Ground Rules

- Do not call `D:\projects\knowledge\run_pipeline.py`, `scripts/build_wiki.py`, or any old Python entrypoint.
- Use old project files only as behavioral reference for stage names, output paths, wiki spec format, and graph/table semantics.
- One completed build run creates exactly one `asset_packages` row with `kind = "kb_builder_pipeline"`.
- Test fixtures must exercise real native TypeScript code paths. They may use small fixture files and deterministic production fallback extraction, but they must not replace the pipeline service with a fake runner.
- Keep existing uncommitted Tauri config changes separate from this feature's commits.

## File Structure

- Modify: `package.json`  
  Add `mammoth` and `xlsx` dependencies for native document/table parsing.
- Modify: `src/server/types.ts`  
  Add build run, quality profile, quality finding, pipeline stage, and component kind types.
- Modify: `src/server/db.ts`  
  Add `knowledge_build_runs` and `quality_gate_profiles` tables plus default quality profile seed.
- Create: `src/server/services/kbBuilder/types.ts`  
  Shared pipeline input/output, workspace, collected artifact, and stage result contracts.
- Create: `src/server/services/kbBuilder/materialize.ts`  
  Copy a source bundle version into an isolated run workspace preserving `gamedocs/` and `gamedata/`.
- Create: `src/server/services/kbBuilder/specs.ts`  
  Parse native wiki spec templates, manifest page types, required H2 sections, and required facts keys.
- Create: `src/server/services/kbBuilder/convertStage.ts`  
  Convert `gamedocs` `.md`, `.txt`, `.docx`, `.xlsx`, and `.xls` into `processed/parsed/*.md`.
- Create: `src/server/services/kbBuilder/extractStage.ts`  
  Generate wiki pages and `_meta/*.json` from parsed docs through configured LLM extraction or deterministic structured-doc fallback.
- Create: `src/server/services/kbBuilder/tableStage.ts`  
  Analyze `gamedata` Excel files, emit table schemas, registries, FK registry, and table wiki pages.
- Create: `src/server/services/kbBuilder/graphStage.ts`  
  Build semantic graph plus deterministic table/field graph layer and `wiki/index.md`.
- Create: `src/server/services/kbBuilder/vizStage.ts`  
  Generate `wiki/graph.html` from `wiki/graph.json`.
- Create: `src/server/services/kbBuilder/qualityGate.ts`  
  Evaluate wiki spec completeness, frontmatter/source traceability, meta quality, table registry quality, graph/index integrity, and concept overuse.
- Create: `src/server/services/kbBuilder/collector.ts`  
  Register pipeline output files as package components with correct group/kind mappings.
- Create: `src/server/services/kbBuilderService.ts`  
  Orchestrate build runs, persist run status, create packages, components, evidence, review tasks, and expose profile/run queries.
- Modify: `src/server/app.ts`  
  Add build, build-run, and quality-profile API routes with admin-only profile updates.
- Modify: `src/client/src/api.ts`  
  Add build run/profile types and fetch helpers.
- Modify: `src/client/src/ui/App.tsx`  
  Add source build action, generated package detail summary, and admin-only quality gate controls.
- Modify: `src/client/src/styles.css`  
  Add compact styles for build controls, pipeline artifacts, and quality profile editing.
- Test: `tests/kb-builder-materialize.test.ts`
- Test: `tests/kb-builder-specs.test.ts`
- Test: `tests/kb-builder-convert.test.ts`
- Test: `tests/kb-builder-table-graph.test.ts`
- Test: `tests/kb-builder-quality.test.ts`
- Test: `tests/kb-builder-service.test.ts`
- Test: `tests/kb-builder-api.test.ts`

## Task 1: Dependencies, Types, and Schema

**Files:**
- Modify: `package.json`
- Modify: `src/server/types.ts`
- Modify: `src/server/db.ts`
- Test: `tests/kb-builder-schema.test.ts`

- [ ] **Step 1: Add dependency declarations**

Edit `package.json` dependencies:

```json
"mammoth": "^1.11.0",
"xlsx": "^0.18.5"
```

Run: `npm install`
Expected: `package-lock.json` updates and install exits with code 0.

- [ ] **Step 2: Write the failing schema test**

Create `tests/kb-builder-schema.test.ts`:

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/server/db";

describe("kb builder schema", () => {
  it("creates build run and quality profile tables with a default active profile", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-kb-schema-"));
    const db = await createDatabase({ dataDir, seedUsers: false });
    try {
      const runTables = await db.adapter.query(
        "SELECT COUNT(*)::int AS count FROM information_schema.tables WHERE table_name IN ('knowledge_build_runs', 'quality_gate_profiles')"
      );
      expect(runTables.rows[0].count).toBe(2);

      const profiles = await db.adapter.query("SELECT profile_id, active, config_json FROM quality_gate_profiles");
      expect(profiles.rows).toHaveLength(1);
      expect(profiles.rows[0].profile_id).toBe("default");
      expect(profiles.rows[0].active).toBe(true);
      expect(profiles.rows[0].config_json.rules.wikiSpecCompleteness.enabled).toBe(true);
    } finally {
      await db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Run the failing test**

Run: `npm test -- tests/kb-builder-schema.test.ts`
Expected: FAIL with relation/table missing for `quality_gate_profiles` or `knowledge_build_runs`.

- [ ] **Step 4: Add server types**

Append these exported types in `src/server/types.ts`:

```typescript
export type PipelineStage = "convert" | "extract" | "tables" | "graph" | "viz";
export type BuildRunStatus = "running" | "completed" | "failed";
export type QualitySeverity = "blocking" | "warning" | "info";

export interface KnowledgeBuildRun {
  runId: string;
  sourceVersionId: string;
  packageId: string | null;
  adapter: "native";
  stages: PipelineStage[];
  model: string;
  wikiSpecsHash: string;
  qualityProfileId: string;
  status: BuildRunStatus;
  startedAt: string;
  finishedAt: string | null;
  error: string;
  outputUri: string;
  config: Record<string, unknown>;
}

export interface QualityGateProfile {
  profileId: string;
  name: string;
  active: boolean;
  config: QualityGateConfig;
  createdBy: string;
  updatedAt: string;
}

export interface QualityGateConfig {
  minPackageScore: number;
  rules: Record<string, Record<string, unknown>>;
}

export interface QualityFinding {
  ruleId: string;
  severity: QualitySeverity;
  componentId?: string;
  title: string;
  description: string;
  suggestedAction: string;
  scoreImpact: number;
}
```

- [ ] **Step 5: Add tables and default profile**

In `src/server/db.ts` inside `migrate()`, after `source_files`, add:

```sql
CREATE TABLE IF NOT EXISTS ${p}quality_gate_profiles (
  profile_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT false,
  config_json JSONB NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ${p}knowledge_build_runs (
  run_id TEXT PRIMARY KEY,
  source_version_id TEXT NOT NULL REFERENCES ${p}source_bundle_versions(version_id) ON DELETE CASCADE,
  package_id TEXT,
  adapter TEXT NOT NULL,
  stages JSONB NOT NULL DEFAULT '[]',
  model TEXT NOT NULL DEFAULT '',
  wiki_specs_hash TEXT NOT NULL DEFAULT '',
  quality_profile_id TEXT NOT NULL REFERENCES ${p}quality_gate_profiles(profile_id),
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  error TEXT NOT NULL DEFAULT '',
  output_uri TEXT NOT NULL DEFAULT '',
  config_json JSONB NOT NULL DEFAULT '{}'
);
```

After the default source bundle seed, insert:

```typescript
const defaultQualityProfile = {
  minPackageScore: 0.75,
  rules: {
    wikiSpecCompleteness: { enabled: true, severity: "blocking", minScore: 0.75 },
    requiredFacts: { enabled: true, severity: "warning", minScore: 0.7 },
    frontmatterSource: { enabled: true, severity: "blocking" },
    metaWikiSync: { enabled: true, severity: "blocking" },
    tableRegistryConsistency: { enabled: true, severity: "warning", minScore: 0.9 },
    graphIntegrity: { enabled: true, severity: "blocking", minScore: 0.7 },
    indexCoverage: { enabled: true, severity: "warning", minScore: 0.9 },
    conceptOveruse: { enabled: true, severity: "warning", maxRatio: 0.35 }
  }
};
await adapter.query(
  `INSERT INTO ${p}quality_gate_profiles (profile_id, name, active, config_json, created_by, updated_at)
   VALUES ($1, $2, $3, $4, $5, $6)
   ON CONFLICT (profile_id) DO NOTHING`,
  ["default", "默认知识质量门禁", true, defaultQualityProfile, "system", new Date(0).toISOString()]
);
```

- [ ] **Step 6: Verify and commit**

Run: `npm test -- tests/kb-builder-schema.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: PASS.

Commit:

```bash
git add package.json package-lock.json src/server/types.ts src/server/db.ts tests/kb-builder-schema.test.ts
git commit -m "feat: add native kb builder schema"
```

## Task 2: Source Version Materialization

**Files:**
- Create: `src/server/services/kbBuilder/types.ts`
- Create: `src/server/services/kbBuilder/materialize.ts`
- Test: `tests/kb-builder-materialize.test.ts`

- [ ] **Step 1: Write the failing materialization test**

Create `tests/kb-builder-materialize.test.ts`:

```typescript
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/server/db";
import { createSourceBundleService } from "../src/server/services/sourceBundleService";
import { materializeSourceVersion } from "../src/server/services/kbBuilder/materialize";

describe("materializeSourceVersion", () => {
  it("copies gamedocs and gamedata files into an isolated run workspace", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-kb-data-"));
    const sourceRoot = mkdtempSync(join(tmpdir(), "kh-kb-src-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "kh-kb-work-"));
    mkdirSync(join(sourceRoot, "gamedocs", "systems"), { recursive: true });
    mkdirSync(join(sourceRoot, "gamedata", "Config"), { recursive: true });
    writeFileSync(join(sourceRoot, "gamedocs", "systems", "battle.md"), "# Battle\n");
    writeFileSync(join(sourceRoot, "gamedata", "Config", "Skill.csv"), "Id,Name\n1,Slash\n");

    const db = await createDatabase({ dataDir, seedUsers: false });
    try {
      const sourceService = createSourceBundleService(db, dataDir);
      const imported = await sourceService.importDirectoryAsVersion({
        rootPath: sourceRoot,
        bundleId: "default",
        createdBy: "admin",
        note: "fixture"
      });

      const result = await materializeSourceVersion({
        db,
        sourceService,
        versionId: imported.version.versionId,
        workspaceRoot,
        runId: "run_native_test"
      });

      expect(result.workspaceDir.endsWith("run_native_test")).toBe(true);
      expect(existsSync(join(result.dataDir, "gamedocs", "systems", "battle.md"))).toBe(true);
      expect(existsSync(join(result.dataDir, "gamedata", "Config", "Skill.csv"))).toBe(true);
      expect(readFileSync(join(result.dataDir, "gamedocs", "systems", "battle.md"), "utf8")).toContain("# Battle");
      expect(result.files.map((file) => file.logicalPath).sort()).toEqual([
        "gamedata/Config/Skill.csv",
        "gamedocs/systems/battle.md"
      ]);
    } finally {
      await db.close();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(sourceRoot, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `npm test -- tests/kb-builder-materialize.test.ts`
Expected: FAIL with missing module `kbBuilder/materialize`.

- [ ] **Step 3: Create shared kb-builder types**

Create `src/server/services/kbBuilder/types.ts`:

```typescript
import type { SourceFileEntry, PipelineStage, QualityFinding } from "../../types";

export interface RunWorkspace {
  runId: string;
  workspaceDir: string;
  dataDir: string;
  files: SourceFileEntry[];
}

export interface BuildPipelineOptions {
  versionId: string;
  bundleId: string;
  requestedBy: string;
  stages: PipelineStage[];
  model: string;
  force: boolean;
  only: string | null;
  qualityProfileId: string;
}

export interface StageResult {
  stage: PipelineStage;
  status: "completed" | "skipped";
  outputPaths: string[];
  warnings: string[];
}

export interface CollectedArtifact {
  artifactId: string;
  group: "wiki" | "index" | "graph" | "table" | "evidence" | "quality" | "release";
  kind: string;
  title: string;
  legacyPath: string;
  storageUri: string;
  sourceRefs: string[];
  quality: Record<string, unknown>;
}

export interface QualityGateResult {
  overallScore: number;
  blockingCount: number;
  warningCount: number;
  findings: QualityFinding[];
  componentQuality: Record<string, Record<string, unknown>>;
}
```

- [ ] **Step 4: Implement materialization**

Create `src/server/services/kbBuilder/materialize.ts`:

```typescript
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import type { DatabaseHandle } from "../../types";
import type { SourceBundleService } from "../sourceBundleService";
import type { RunWorkspace } from "./types";

export async function materializeSourceVersion(options: {
  db: DatabaseHandle;
  sourceService: SourceBundleService;
  versionId: string;
  workspaceRoot: string;
  runId: string;
}): Promise<RunWorkspace> {
  const files = await options.sourceService.listFiles(options.versionId);
  const workspaceDir = join(options.workspaceRoot, options.runId);
  const dataDir = join(workspaceDir, "data");
  rmSync(workspaceDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });

  for (const file of files) {
    const read = await options.sourceService.readFile(options.versionId, file.logicalPath);
    if (!read) throw new Error(`Source file content missing: ${file.logicalPath}`);
    const relative = normalize(file.logicalPath).replace(/^(\.\.[/\\])+/, "");
    if (!relative.startsWith("gamedocs") && !relative.startsWith("gamedata")) {
      throw new Error(`Unsupported source logical path: ${file.logicalPath}`);
    }
    const target = join(dataDir, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, read.content);
  }

  return { runId: options.runId, workspaceDir, dataDir, files };
}
```

- [ ] **Step 5: Verify and commit**

Run: `npm test -- tests/kb-builder-materialize.test.ts`
Expected: PASS.

Commit:

```bash
git add src/server/services/kbBuilder/types.ts src/server/services/kbBuilder/materialize.ts tests/kb-builder-materialize.test.ts
git commit -m "feat: materialize source versions for kb builds"
```

## Task 3: Wiki Spec Parser

**Files:**
- Create: `src/server/services/kbBuilder/specs.ts`
- Test: `tests/kb-builder-specs.test.ts`

- [ ] **Step 1: Write the failing spec parser test**

Create `tests/kb-builder-specs.test.ts`:

```typescript
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadWikiSpecs } from "../src/server/services/kbBuilder/specs";

describe("loadWikiSpecs", () => {
  it("loads manifest page types plus required sections and facts", () => {
    const root = mkdtempSync(join(tmpdir(), "kh-kb-specs-"));
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "manifest.json"), JSON.stringify({
        page_types: {
          system: { dir: "systems", template: "system_rule.md" }
        },
        entity_types: ["system", "table", "concept"],
        relation_types: ["depends_on", "configured_in", "references"]
      }));
      writeFileSync(join(root, "system_rule.md"), [
        "# System Rule",
        "## Overview",
        "## Core Rules",
        "## Data Dependencies",
        "| key | required |",
        "| --- | --- |",
        "| unlock_condition | yes |",
        "| config_table | yes |"
      ].join("\n"));

      const specs = loadWikiSpecs(root);
      expect(specs.manifest.pageTypes.system.dir).toBe("systems");
      expect(specs.specs.system.requiredSections).toEqual(["Overview", "Core Rules", "Data Dependencies"]);
      expect(specs.specs.system.requiredFacts).toEqual(["unlock_condition", "config_table"]);
      expect(specs.entityTypes.has("system")).toBe(true);
      expect(specs.relationTypes.has("configured_in")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `npm test -- tests/kb-builder-specs.test.ts`
Expected: FAIL with missing module `kbBuilder/specs`.

- [ ] **Step 3: Implement spec parsing**

Create `src/server/services/kbBuilder/specs.ts`:

```typescript
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
  const files = readdirSync(specDir).filter((file) => file.endsWith(".md")).sort();
  const hash = createHash("sha256");
  hash.update(manifestRaw);
  const specs: WikiSpecSet["specs"] = {};

  for (const [type, value] of Object.entries<Record<string, { dir: string; template: string }>>(manifestJson.page_types ?? {})) {
    const template = value.template;
    if (!template) continue;
    const body = readFileSync(join(specDir, template), "utf8");
    hash.update(template);
    hash.update(body);
    specs[type] = {
      requiredSections: extractRequiredSections(body),
      requiredFacts: extractRequiredFacts(body)
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
    relationTypes: new Set(manifestJson.relation_types ?? [])
  };
}

function normalizePageTypes(input: Record<string, { dir: string; template: string }>) {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, { dir: value.dir, template: value.template }]));
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
    const cells = line.split("|").map((cell) => cell.trim()).filter(Boolean);
    if (cells.length >= 2 && cells[0] !== "---" && cells[0].toLowerCase() !== "key") {
      const required = cells.some((cell) => /^(yes|required|true|必填|是)$/i.test(cell));
      if (required) facts.add(cells[0]);
    }
  }
  return [...facts];
}
```

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/kb-builder-specs.test.ts`
Expected: PASS.

Commit:

```bash
git add src/server/services/kbBuilder/specs.ts tests/kb-builder-specs.test.ts
git commit -m "feat: parse native wiki specs"
```

## Task 4: Native Convert Stage

**Files:**
- Create: `src/server/services/kbBuilder/convertStage.ts`
- Test: `tests/kb-builder-convert.test.ts`

- [ ] **Step 1: Write the failing convert test**

Create `tests/kb-builder-convert.test.ts`:

```typescript
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { runConvertStage } from "../src/server/services/kbBuilder/convertStage";

describe("runConvertStage", () => {
  it("converts markdown and text design docs into processed parsed markdown", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-kb-convert-"));
    try {
      mkdirSync(join(dataDir, "gamedocs", "systems"), { recursive: true });
      writeFileSync(join(dataDir, "gamedocs", "systems", "battle.md"), "# Battle\n\nsource body");
      writeFileSync(join(dataDir, "gamedocs", "economy.txt"), "Economy text");

      const result = await runConvertStage({ dataDir, force: false, only: null });

      expect(result.stage).toBe("convert");
      expect(result.outputPaths.sort()).toEqual([
        "processed/parsed/economy.md",
        "processed/parsed/systems/battle.md"
      ]);
      expect(existsSync(join(dataDir, "processed", "parsed", "systems", "battle.md"))).toBe(true);
      expect(readFileSync(join(dataDir, "processed", "parsed", "economy.md"), "utf8")).toContain("Economy text");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `npm test -- tests/kb-builder-convert.test.ts`
Expected: FAIL with missing module `convertStage`.

- [ ] **Step 3: Implement native conversion**

Create `src/server/services/kbBuilder/convertStage.ts`:

```typescript
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import mammoth from "mammoth";
import xlsx from "xlsx";
import type { StageResult } from "./types";

export async function runConvertStage(options: { dataDir: string; force: boolean; only: string | null }): Promise<StageResult> {
  const docsDir = join(options.dataDir, "gamedocs");
  const outputPaths: string[] = [];
  const warnings: string[] = [];

  for (const absolute of walkFiles(docsDir)) {
    const rel = relative(docsDir, absolute).replace(/\\/g, "/");
    if (options.only && rel !== options.only && !rel.endsWith(`/${options.only}`)) continue;
    const ext = extname(absolute).toLowerCase();
    if (![".md", ".txt", ".docx", ".xlsx", ".xls"].includes(ext)) continue;
    const outRel = `processed/parsed/${rel.replace(/\.[^.]+$/, ".md")}`;
    const outAbs = join(options.dataDir, outRel);
    mkdirSync(dirname(outAbs), { recursive: true });
    const markdown = await convertFile(absolute, ext);
    writeFileSync(outAbs, markdown);
    outputPaths.push(outRel);
  }

  outputPaths.sort();
  return { stage: "convert", status: "completed", outputPaths, warnings };
}

async function convertFile(path: string, ext: string): Promise<string> {
  if (ext === ".md") return readFileSync(path, "utf8");
  if (ext === ".txt") return readFileSync(path, "utf8");
  if (ext === ".docx") {
    const result = await mammoth.convertToMarkdown({ path });
    return result.value;
  }
  const workbook = xlsx.readFile(path);
  return workbook.SheetNames.map((name) => {
    const rows = xlsx.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[name], { defval: "" });
    const header = `## Sheet: ${name}`;
    const body = rows.map((row) => `- ${Object.entries(row).map(([key, value]) => `${key}: ${String(value)}`).join("; ")}`).join("\n");
    return `${header}\n\n${body}`;
  }).join("\n\n");
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === ".cache") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(path));
    else if (!entry.name.startsWith("~")) out.push(path);
  }
  return out.sort();
}
```

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/kb-builder-convert.test.ts`
Expected: PASS.

Commit:

```bash
git add src/server/services/kbBuilder/convertStage.ts tests/kb-builder-convert.test.ts
git commit -m "feat: add native document conversion stage"
```

## Task 5: Native Extract Stage

**Files:**
- Create: `src/server/services/kbBuilder/extractStage.ts`
- Test: `tests/kb-builder-extract.test.ts`

- [ ] **Step 1: Write the failing extraction test**

Create `tests/kb-builder-extract.test.ts`:

```typescript
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { runExtractStage } from "../src/server/services/kbBuilder/extractStage";
import { loadWikiSpecs } from "../src/server/services/kbBuilder/specs";

describe("runExtractStage", () => {
  it("generates wiki page and meta from structured parsed markdown", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-kb-extract-"));
    const specDir = join(dataDir, "processed", "wiki_specs");
    try {
      mkdirSync(join(dataDir, "processed", "parsed"), { recursive: true });
      mkdirSync(specDir, { recursive: true });
      writeFileSync(join(specDir, "manifest.json"), JSON.stringify({
        page_types: { system: { dir: "systems", template: "system_rule.md" } },
        entity_types: ["system", "table", "concept"],
        relation_types: ["configured_in", "references"]
      }));
      writeFileSync(join(specDir, "system_rule.md"), "## Overview\n## Data Dependencies\n| key | required |\n| --- | --- |\n| config_table | yes |");
      writeFileSync(join(dataDir, "processed", "parsed", "battle.md"), [
        "---",
        "type: system",
        "title: Battle System",
        "source: gamedocs/battle.md",
        "facts:",
        "  config_table: Skill",
        "entities:",
        "  - name: Battle System",
        "    type: system",
        "  - name: Skill",
        "    type: table",
        "relationships:",
        "  - source: Battle System",
        "    relation: configured_in",
        "    target: Skill",
        "---",
        "## Overview",
        "Battle rules.",
        "## Data Dependencies",
        "Uses Skill."
      ].join("\n"));

      const specs = loadWikiSpecs(specDir);
      const result = await runExtractStage({ dataDir, specs, model: "deterministic", force: false, only: null });

      expect(result.outputPaths.sort()).toEqual(["wiki/_meta/battle.json", "wiki/systems/battle.md"]);
      expect(existsSync(join(dataDir, "wiki", "systems", "battle.md"))).toBe(true);
      const meta = JSON.parse(readFileSync(join(dataDir, "wiki", "_meta", "battle.json"), "utf8"));
      expect(meta.title).toBe("Battle System");
      expect(meta.relationships[0].relation).toBe("configured_in");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `npm test -- tests/kb-builder-extract.test.ts`
Expected: FAIL with missing module `extractStage`.

- [ ] **Step 3: Implement structured extraction and LLM hook**

Create `src/server/services/kbBuilder/extractStage.ts` with these exported functions:

```typescript
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { StageResult } from "./types";
import type { WikiSpecSet } from "./specs";

export async function runExtractStage(options: {
  dataDir: string;
  specs: WikiSpecSet;
  model: string;
  force: boolean;
  only: string | null;
}): Promise<StageResult> {
  const parsedDir = join(options.dataDir, "processed", "parsed");
  const outputPaths: string[] = [];
  const warnings: string[] = [];
  mkdirSync(join(options.dataDir, "wiki", "_meta"), { recursive: true });

  for (const absolute of walkMarkdown(parsedDir)) {
    const rel = relative(parsedDir, absolute).replace(/\\/g, "/");
    if (options.only && rel !== options.only && !rel.endsWith(`/${options.only}`)) continue;
    const markdown = readFileSync(absolute, "utf8");
    const extracted = await extractDocument(markdown, {
      source: `gamedocs/${rel.replace(/\.md$/, ".md")}`,
      specs: options.specs,
      model: options.model
    });
    const pageType = extracted.type;
    const pageConfig = options.specs.manifest.pageTypes[pageType];
    if (!pageConfig) {
      warnings.push(`Unknown page type ${pageType} in ${rel}`);
      continue;
    }

    const slug = basename(rel, ".md").replace(/\s+/g, "_");
    const wikiRel = `wiki/${pageConfig.dir}/${slug}.md`;
    const metaRel = `wiki/_meta/${slug}.json`;
    mkdirSync(dirname(join(options.dataDir, wikiRel)), { recursive: true });
    writeFileSync(join(options.dataDir, wikiRel), renderWikiPage(extracted, markdown));
    writeFileSync(join(options.dataDir, metaRel), JSON.stringify({ ...extracted, wiki_path: wikiRel }, null, 2));
    outputPaths.push(wikiRel, metaRel);
  }

  outputPaths.sort();
  return { stage: "extract", status: "completed", outputPaths, warnings };
}

async function extractDocument(markdown: string, context: { source: string; specs: WikiSpecSet; model: string }) {
  const structured = parseStructuredFrontmatter(markdown);
  if (structured) return structured;
  if (process.env.OPENAI_API_KEY && context.model !== "deterministic") {
    return extractWithOpenAiCompatibleApi(markdown, context);
  }
  const title = firstHeading(markdown) ?? basename(context.source, ".md");
  return {
    type: "concept",
    title,
    source: context.source,
    facts: {},
    entities: [{ name: title, type: "concept" }],
    relationships: []
  };
}
```

Then add the helper functions in the same file:

```typescript
function parseStructuredFrontmatter(markdown: string): any | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(markdown);
  if (!match) return null;
  const data: any = { facts: {}, entities: [], relationships: [] };
  const lines = match[1].split(/\r?\n/);
  let section: "facts" | "entities" | "relationships" | null = null;
  let current: any = null;
  for (const line of lines) {
    if (/^\w/.test(line)) section = null;
    const scalar = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (scalar && !["facts", "entities", "relationships"].includes(scalar[1])) data[scalar[1]] = scalar[2];
    if (/^facts:\s*$/.test(line)) section = "facts";
    else if (/^entities:\s*$/.test(line)) section = "entities";
    else if (/^relationships:\s*$/.test(line)) section = "relationships";
    else if (section === "facts") {
      const fact = /^\s{2}([^:]+):\s*(.*)$/.exec(line);
      if (fact) data.facts[fact[1].trim()] = fact[2].trim();
    } else if (section === "entities" || section === "relationships") {
      const start = /^\s{2}-\s+([^:]+):\s*(.*)$/.exec(line);
      const prop = /^\s{4}([^:]+):\s*(.*)$/.exec(line);
      if (start) {
        current = { [start[1].trim()]: start[2].trim() };
        data[section].push(current);
      } else if (prop && current) {
        current[prop[1].trim()] = prop[2].trim();
      }
    }
  }
  return data.type && data.title && data.source ? data : null;
}

function renderWikiPage(extracted: any, originalMarkdown: string): string {
  const body = originalMarkdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  return [
    "---",
    `type: ${extracted.type}`,
    `title: ${extracted.title}`,
    `source: ${extracted.source}`,
    "---",
    "",
    body.trim()
  ].join("\n");
}

function firstHeading(markdown: string): string | null {
  return markdown.split(/\r?\n/).map((line) => /^#\s+(.+)$/.exec(line)?.[1]).find(Boolean) ?? null;
}

async function extractWithOpenAiCompatibleApi(markdown: string, context: { source: string; specs: WikiSpecSet; model: string }) {
  const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: context.model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Extract one game design wiki page as JSON with type,title,source,facts,entities,relationships." },
        { role: "user", content: JSON.stringify({ source: context.source, allowedTypes: [...context.specs.entityTypes], text: markdown }) }
      ]
    })
  });
  if (!response.ok) throw new Error(`LLM extraction failed: ${response.status} ${await response.text()}`);
  const json = await response.json() as any;
  return JSON.parse(json.choices[0].message.content);
}

function walkMarkdown(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkMarkdown(path));
    else if (entry.name.endsWith(".md")) out.push(path);
  }
  return out.sort();
}
```

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/kb-builder-extract.test.ts`
Expected: PASS.

Commit:

```bash
git add src/server/services/kbBuilder/extractStage.ts tests/kb-builder-extract.test.ts
git commit -m "feat: add native wiki extraction stage"
```

## Task 6: Table and Graph Stages

**Files:**
- Create: `src/server/services/kbBuilder/tableStage.ts`
- Create: `src/server/services/kbBuilder/graphStage.ts`
- Create: `src/server/services/kbBuilder/vizStage.ts`
- Test: `tests/kb-builder-table-graph.test.ts`

- [ ] **Step 1: Write the failing table/graph test**

Create `tests/kb-builder-table-graph.test.ts`:

```typescript
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import xlsx from "xlsx";
import { runTableStage } from "../src/server/services/kbBuilder/tableStage";
import { runGraphStage } from "../src/server/services/kbBuilder/graphStage";
import { runVizStage } from "../src/server/services/kbBuilder/vizStage";

describe("native table and graph stages", () => {
  it("emits table registries, deterministic table-field graph, index, and graph html", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-kb-table-graph-"));
    try {
      mkdirSync(join(dataDir, "gamedata", "Combat"), { recursive: true });
      mkdirSync(join(dataDir, "wiki", "_meta"), { recursive: true });
      const workbook = xlsx.utils.book_new();
      const sheet = xlsx.utils.json_to_sheet([{ Id: 1, Name: "Slash", BuffId: 10 }]);
      xlsx.utils.book_append_sheet(workbook, sheet, "Skill");
      xlsx.writeFile(workbook, join(dataDir, "gamedata", "Combat", "Skill.xlsx"));

      writeFileSync(join(dataDir, "wiki", "_meta", "battle.json"), JSON.stringify({
        title: "Battle System",
        source: "gamedocs/battle.md",
        wiki_path: "wiki/systems/battle.md",
        entities: [{ name: "Battle System", type: "system" }, { name: "Skill", type: "table" }],
        relationships: [{ source: "Battle System", relation: "configured_in", target: "Skill" }]
      }));

      await runTableStage({ dataDir, force: false });
      await runGraphStage({ dataDir });
      await runVizStage({ dataDir });

      expect(existsSync(join(dataDir, "wiki", "_tables", "schemas.json"))).toBe(true);
      expect(existsSync(join(dataDir, "table_schemas", "Combat__Skill.json"))).toBe(true);
      const graph = JSON.parse(readFileSync(join(dataDir, "wiki", "graph.json"), "utf8"));
      expect(graph.nodes.some((node: any) => node.id === "table:Combat/Skill")).toBe(true);
      expect(graph.nodes.some((node: any) => node.id === "field:Combat/Skill.BuffId")).toBe(true);
      expect(graph.edges.some((edge: any) => edge.relation === "has_field")).toBe(true);
      expect(readFileSync(join(dataDir, "wiki", "index.md"), "utf8")).toContain("Battle System");
      expect(readFileSync(join(dataDir, "wiki", "graph.html"), "utf8")).toContain("Knowledge Graph");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `npm test -- tests/kb-builder-table-graph.test.ts`
Expected: FAIL with missing table/graph stage modules.

- [ ] **Step 3: Implement table stage**

Create `src/server/services/kbBuilder/tableStage.ts`:

```typescript
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import xlsx from "xlsx";
import type { StageResult } from "./types";

export async function runTableStage(options: { dataDir: string; force: boolean }): Promise<StageResult> {
  const schemas: Record<string, any> = {};
  const groups: Record<string, string[]> = {};
  const gamedataDir = join(options.dataDir, "gamedata");
  for (const file of walkFiles(gamedataDir)) {
    if (![".xlsx", ".xls", ".csv"].includes(extname(file).toLowerCase())) continue;
    const rel = relative(gamedataDir, file).replace(/\\/g, "/").replace(/\.[^.]+$/, "");
    const group = dirname(rel) === "." ? "ungrouped" : dirname(rel).replace(/\\/g, "/");
    const tableName = rel;
    const workbook = xlsx.readFile(file);
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json<Record<string, unknown>>(firstSheet, { defval: "" });
    const fields = rows.length ? Object.keys(rows[0]) : [];
    schemas[tableName] = { table_name: tableName, rel_path: relative(options.dataDir, file).replace(/\\/g, "/"), fields, row_count: rows.length };
    groups[group] = [...(groups[group] ?? []), tableName].sort();
  }
  const fk = detectFkEdges(schemas);
  const outputPaths = writeTableOutputs(options.dataDir, schemas, groups, fk);
  return { stage: "tables", status: "completed", outputPaths, warnings: [] };
}

export function detectFkEdges(schemas: Record<string, any>) {
  const nameIndex = new Map<string, string>();
  for (const tableName of Object.keys(schemas)) nameIndex.set(tableName.split("/").at(-1)!.replace(/^_+/, "").toLowerCase(), tableName);
  const edges: any[] = [];
  for (const [tableName, schema] of Object.entries(schemas)) {
    for (const field of schema.fields ?? []) {
      const match = /^(.+?)[_]?Ids?$/i.exec(field);
      if (!match) continue;
      const target = nameIndex.get(match[1].toLowerCase());
      if (target && target !== tableName) edges.push({ source: tableName, target, field, source_of_edge: "field_convention" });
    }
  }
  return edges.sort((a, b) => `${a.source}.${a.field}`.localeCompare(`${b.source}.${b.field}`));
}
```

Add output helpers in the same file:

```typescript
function writeTableOutputs(dataDir: string, schemas: Record<string, any>, groups: Record<string, string[]>, fk: any[]): string[] {
  const outputPaths = ["wiki/_tables/schemas.json", "wiki/_tables/groups.json", "wiki/_tables/table_fk_registry.json"];
  mkdirSync(join(dataDir, "wiki", "_tables"), { recursive: true });
  mkdirSync(join(dataDir, "table_schemas"), { recursive: true });
  mkdirSync(join(dataDir, "wiki", "tables"), { recursive: true });
  writeFileSync(join(dataDir, "wiki", "_tables", "schemas.json"), JSON.stringify(sortObject(schemas), null, 2));
  writeFileSync(join(dataDir, "wiki", "_tables", "groups.json"), JSON.stringify(sortObject(groups), null, 2));
  writeFileSync(join(dataDir, "wiki", "_tables", "table_fk_registry.json"), JSON.stringify(fk, null, 2));
  for (const [tableName, schema] of Object.entries(schemas).sort()) {
    const file = tableName.replace(/[\\/]/g, "__");
    writeFileSync(join(dataDir, "table_schemas", `${file}.json`), JSON.stringify(schema, null, 2));
    outputPaths.push(`table_schemas/${file}.json`);
  }
  for (const [group, tables] of Object.entries(groups).sort()) {
    const slug = group.replace(/[\\/]/g, "__");
    writeFileSync(join(dataDir, "wiki", "tables", `${slug}.md`), [
      "---",
      "type: table",
      `title: ${group}`,
      `table_schema: wiki/_tables/schemas.json`,
      "---",
      "",
      `# ${group}`,
      "",
      ...tables.map((table) => `- ${table}`)
    ].join("\n"));
    outputPaths.push(`wiki/tables/${slug}.md`);
  }
  return outputPaths.sort();
}

function sortObject<T>(input: Record<string, T>) {
  return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)));
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(path));
    else out.push(path);
  }
  return out.sort();
}
```

- [ ] **Step 4: Implement graph and viz stages**

Create `src/server/services/kbBuilder/graphStage.ts`:

```typescript
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StageResult } from "./types";

export async function runGraphStage(options: { dataDir: string }): Promise<StageResult> {
  const metas = loadMetas(join(options.dataDir, "wiki", "_meta"));
  const schemasPath = join(options.dataDir, "wiki", "_tables", "schemas.json");
  const schemas = existsSync(schemasPath) ? JSON.parse(readFileSync(schemasPath, "utf8")) : {};
  const nodes = new Map<string, any>();
  const edges: any[] = [];
  for (const meta of metas) {
    for (const entity of meta.entities ?? []) nodes.set(entity.name, { id: entity.name, label: entity.name, type: entity.type, wiki_page: entity.name === meta.title ? meta.wiki_path : "" });
    for (const rel of meta.relationships ?? []) edges.push({ source: rel.source, target: rel.target, relation: rel.relation, from_doc: meta.source, edge_kind: "semantic" });
  }
  for (const [tableName, schema] of Object.entries<any>(schemas)) {
    const tableId = `table:${tableName}`;
    nodes.set(tableId, { id: tableId, label: tableName, type: "table", source: "table_registry" });
    for (const field of schema.fields ?? []) {
      const fieldId = `field:${tableName}.${field}`;
      nodes.set(fieldId, { id: fieldId, label: field, type: "field", table: tableName });
      edges.push({ source: tableId, target: fieldId, relation: "has_field", edge_kind: "table_field" });
    }
  }
  const graph = { nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)), edges: dedupeEdges(edges) };
  mkdirSync(join(options.dataDir, "wiki"), { recursive: true });
  writeFileSync(join(options.dataDir, "wiki", "graph.json"), JSON.stringify(graph, null, 2));
  writeFileSync(join(options.dataDir, "wiki", "index.md"), renderIndex(graph));
  return { stage: "graph", status: "completed", outputPaths: ["wiki/graph.json", "wiki/index.md"], warnings: [] };
}

function loadMetas(metaDir: string): any[] {
  if (!existsSync(metaDir)) return [];
  return readdirSync(metaDir).filter((file) => file.endsWith(".json")).sort().map((file) => JSON.parse(readFileSync(join(metaDir, file), "utf8")));
}

function dedupeEdges(edges: any[]) {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.source}\u0000${edge.relation}\u0000${edge.target}\u0000${edge.from_doc ?? ""}`;
    if (seen.has(key) || edge.source === edge.target) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => `${a.source}.${a.relation}.${a.target}`.localeCompare(`${b.source}.${b.relation}.${b.target}`));
}

function renderIndex(graph: any) {
  return ["# Knowledge Index", "", ...graph.nodes.map((node: any) => `- ${node.label ?? node.id} (${node.type})`)].join("\n");
}
```

Create `src/server/services/kbBuilder/vizStage.ts`:

```typescript
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StageResult } from "./types";

export async function runVizStage(options: { dataDir: string }): Promise<StageResult> {
  const graph = readFileSync(join(options.dataDir, "wiki", "graph.json"), "utf8");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Knowledge Graph</title></head><body><h1>Knowledge Graph</h1><script type="application/json" id="graph">${graph.replace(/</g, "\\u003c")}</script></body></html>`;
  writeFileSync(join(options.dataDir, "wiki", "graph.html"), html);
  return { stage: "viz", status: "completed", outputPaths: ["wiki/graph.html"], warnings: [] };
}
```

- [ ] **Step 5: Verify and commit**

Run: `npm test -- tests/kb-builder-table-graph.test.ts`
Expected: PASS.

Commit:

```bash
git add src/server/services/kbBuilder/tableStage.ts src/server/services/kbBuilder/graphStage.ts src/server/services/kbBuilder/vizStage.ts tests/kb-builder-table-graph.test.ts
git commit -m "feat: add native table and graph stages"
```

## Task 7: Quality Gate Engine

**Files:**
- Create: `src/server/services/kbBuilder/qualityGate.ts`
- Test: `tests/kb-builder-quality.test.ts`

- [ ] **Step 1: Write the failing quality test**

Create `tests/kb-builder-quality.test.ts`:

```typescript
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadWikiSpecs } from "../src/server/services/kbBuilder/specs";
import { evaluateQualityGate } from "../src/server/services/kbBuilder/qualityGate";

describe("evaluateQualityGate", () => {
  it("lowers confidence when required wiki spec sections and facts are missing", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-kb-quality-"));
    try {
      const specDir = join(dataDir, "processed", "wiki_specs");
      mkdirSync(join(dataDir, "wiki", "systems"), { recursive: true });
      mkdirSync(join(dataDir, "wiki", "_meta"), { recursive: true });
      mkdirSync(specDir, { recursive: true });
      writeFileSync(join(specDir, "manifest.json"), JSON.stringify({
        page_types: { system: { dir: "systems", template: "system_rule.md" } },
        entity_types: ["system", "table", "concept"],
        relation_types: ["configured_in", "references"]
      }));
      writeFileSync(join(specDir, "system_rule.md"), "## Overview\n## Data Dependencies\n| key | required |\n| --- | --- |\n| config_table | yes |");
      writeFileSync(join(dataDir, "wiki", "systems", "battle.md"), "---\ntype: system\ntitle: Battle\nsource: gamedocs/battle.md\n---\n\n## Overview\nOnly overview.");
      writeFileSync(join(dataDir, "wiki", "_meta", "battle.json"), JSON.stringify({
        title: "Battle",
        source: "gamedocs/battle.md",
        wiki_path: "wiki/systems/battle.md",
        facts: {},
        entities: [{ name: "Battle", type: "system" }],
        relationships: []
      }));

      const result = evaluateQualityGate({
        dataDir,
        specs: loadWikiSpecs(specDir),
        sourceLogicalPaths: new Set(["gamedocs/battle.md"]),
        profile: {
          minPackageScore: 0.75,
          rules: {
            wikiSpecCompleteness: { enabled: true, severity: "blocking", minScore: 0.75 },
            requiredFacts: { enabled: true, severity: "warning", minScore: 0.7 },
            frontmatterSource: { enabled: true, severity: "blocking" },
            graphIntegrity: { enabled: true, severity: "blocking", minScore: 0.7 },
            conceptOveruse: { enabled: true, severity: "warning", maxRatio: 0.35 }
          }
        }
      });

      expect(result.overallScore).toBeLessThan(0.75);
      expect(result.blockingCount).toBeGreaterThan(0);
      expect(result.warningCount).toBeGreaterThan(0);
      expect(result.findings.some((finding) => finding.ruleId === "wikiSpecCompleteness")).toBe(true);
      expect(result.findings.some((finding) => finding.ruleId === "requiredFacts")).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `npm test -- tests/kb-builder-quality.test.ts`
Expected: FAIL with missing module `qualityGate`.

- [ ] **Step 3: Implement quality gate scoring**

Create `src/server/services/kbBuilder/qualityGate.ts`:

```typescript
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { QualityGateConfig, QualityFinding } from "../../types";
import type { QualityGateResult } from "./types";
import type { WikiSpecSet } from "./specs";

export function evaluateQualityGate(options: {
  dataDir: string;
  specs: WikiSpecSet;
  sourceLogicalPaths: Set<string>;
  profile: QualityGateConfig;
}): QualityGateResult {
  const findings: QualityFinding[] = [];
  const componentQuality: Record<string, Record<string, unknown>> = {};
  const pageScores: number[] = [];

  for (const [type, pageType] of Object.entries(options.specs.manifest.pageTypes)) {
    const dir = join(options.dataDir, "wiki", pageType.dir);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".md")).sort()) {
      const rel = `wiki/${pageType.dir}/${file}`;
      const markdown = readFileSync(join(dir, file), "utf8");
      const metaPath = join(options.dataDir, "wiki", "_meta", file.replace(/\.md$/, ".json"));
      const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : {};
      const frontmatter = parseFrontmatter(markdown);
      const spec = options.specs.specs[type] ?? { requiredSections: [], requiredFacts: [] };
      const requiredSections = spec.requiredSections;
      const requiredFacts = spec.requiredFacts;
      const presentSections = new Set([...markdown.matchAll(/^##\s+(.+)$/gm)].map((match) => match[1].trim()));
      const structureScore = ratio(requiredSections.filter((section) => presentSections.has(section)).length, requiredSections.length);
      const factsScore = ratio(requiredFacts.filter((fact) => meta.facts && Object.prototype.hasOwnProperty.call(meta.facts, fact)).length, requiredFacts.length);
      const emptyPenalty = requiredSections.some((section) => sectionIsEmpty(markdown, section)) ? 0.25 : 0;
      const emptySectionScore = Math.max(0, 1 - emptyPenalty);
      const wikiSpecScore = round(structureScore * 0.45 + factsScore * 0.35 + emptySectionScore * 0.2);
      pageScores.push(wikiSpecScore);
      componentQuality[rel] = { confidence: wikiSpecScore, structureScore, factsScore, emptySectionScore };

      if (wikiSpecScore < Number((options.profile.rules.wikiSpecCompleteness ?? {}).minScore ?? 0.75)) {
        findings.push(finding("wikiSpecCompleteness", String((options.profile.rules.wikiSpecCompleteness ?? {}).severity ?? "blocking"), rel, `Wiki spec incomplete: ${rel}`, `Score ${wikiSpecScore}`, "补齐缺失章节和事实字段。", 1 - wikiSpecScore));
      }
      if (factsScore < Number((options.profile.rules.requiredFacts ?? {}).minScore ?? 0.7)) {
        findings.push(finding("requiredFacts", String((options.profile.rules.requiredFacts ?? {}).severity ?? "warning"), rel, `Required facts missing: ${rel}`, `Facts score ${factsScore}`, "补齐 spec 要求的 facts。", 1 - factsScore));
      }
      if (!frontmatter.source || !options.sourceLogicalPaths.has(frontmatter.source)) {
        findings.push(finding("frontmatterSource", String((options.profile.rules.frontmatterSource ?? {}).severity ?? "blocking"), rel, `Source trace missing: ${rel}`, `Source ${frontmatter.source ?? ""} is not in source version.`, "修正 source frontmatter 或重新导入资料。", 1));
      }
    }
  }

  const graphFinding = evaluateGraph(options.dataDir, options.specs);
  if (graphFinding) findings.push(graphFinding);
  const overallScore = round(pageScores.length ? pageScores.reduce((sum, value) => sum + value, 0) / pageScores.length : 0);
  return {
    overallScore,
    blockingCount: findings.filter((item) => item.severity === "blocking").length,
    warningCount: findings.filter((item) => item.severity === "warning").length,
    findings,
    componentQuality
  };
}
```

Add helpers in the same file:

```typescript
function parseFrontmatter(markdown: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!match) return {};
  return Object.fromEntries(match[1].split(/\r?\n/).map((line) => /^([^:]+):\s*(.*)$/.exec(line)).filter((m): m is RegExpExecArray => Boolean(m)).map((m) => [m[1].trim(), m[2].trim()]));
}

function sectionIsEmpty(markdown: string, section: string): boolean {
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^##\\s+${escaped}\\s*$([\\s\\S]*?)(?=^##\\s+|\\z)`, "m").exec(markdown);
  return Boolean(match && match[1].trim().length === 0);
}

function evaluateGraph(dataDir: string, specs: WikiSpecSet): QualityFinding | null {
  const graphPath = join(dataDir, "wiki", "graph.json");
  if (!existsSync(graphPath)) return finding("graphIntegrity", "blocking", "wiki/graph.json", "Graph missing", "wiki/graph.json does not exist.", "重新运行 graph 阶段。", 1);
  const graph = JSON.parse(readFileSync(graphPath, "utf8"));
  const nodeIds = new Set((graph.nodes ?? []).map((node: any) => node.id));
  const badEdge = (graph.edges ?? []).find((edge: any) => !nodeIds.has(edge.source) || !nodeIds.has(edge.target));
  if (badEdge) return finding("graphIntegrity", "blocking", "wiki/graph.json", "Dangling graph edge", `${badEdge.source} -> ${badEdge.target}`, "修复 meta 关系或表注册表。", 1);
  const invalidRelation = (graph.edges ?? []).find((edge: any) => edge.edge_kind === "semantic" && !specs.relationTypes.has(edge.relation));
  if (invalidRelation) return finding("graphIntegrity", "blocking", "wiki/graph.json", "Invalid relation type", invalidRelation.relation, "改用 manifest 中定义的关系类型。", 1);
  return null;
}

function ratio(hit: number, total: number): number {
  return total === 0 ? 1 : round(hit / total);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function finding(ruleId: string, severity: string, componentId: string, title: string, description: string, suggestedAction: string, scoreImpact: number): QualityFinding {
  return { ruleId, severity: severity === "warning" ? "warning" : severity === "info" ? "info" : "blocking", componentId, title, description, suggestedAction, scoreImpact };
}
```

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/kb-builder-quality.test.ts`
Expected: PASS.

Commit:

```bash
git add src/server/services/kbBuilder/qualityGate.ts tests/kb-builder-quality.test.ts
git commit -m "feat: add kb builder quality gates"
```

## Task 8: Output Collector and Pipeline Service

**Files:**
- Create: `src/server/services/kbBuilder/collector.ts`
- Create: `src/server/services/kbBuilderService.ts`
- Test: `tests/kb-builder-service.test.ts`

- [ ] **Step 1: Write the failing service test**

Create `tests/kb-builder-service.test.ts` that imports a fixture directory through `SourceBundleService`, calls `createKbBuilderPipelineService(db, dataDir).build(...)`, and asserts:

```typescript
expect(result.package.kind).toBe("kb_builder_pipeline");
expect(result.package.sourceVersionIds).toEqual([version.versionId]);
expect(result.package.createdByRunId).toBe(result.run.runId);
expect(result.qualitySummary.overallScore).toBeGreaterThanOrEqual(0);
expect(detail.components.map((component) => component.kind)).toEqual(expect.arrayContaining([
  "processed_doc",
  "wiki_page",
  "extract_meta",
  "table_schema_json",
  "table_registry",
  "graph_snapshot",
  "topic_index",
  "graph_view",
  "quality_report"
]));
```

The fixture must contain `gamedocs/battle.md`, `gamedata/Combat/Skill.xlsx`, and a copied `processed/wiki_specs` generated by the test before build starts.

- [ ] **Step 2: Run the failing service test**

Run: `npm test -- tests/kb-builder-service.test.ts`
Expected: FAIL with missing `createKbBuilderPipelineService`.

- [ ] **Step 3: Implement collector path mapping**

Create `src/server/services/kbBuilder/collector.ts`:

```typescript
import { existsSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { CollectedArtifact } from "./types";

export function collectPipelineArtifacts(dataDir: string, storageRoot: string, qualityByPath: Record<string, Record<string, unknown>>): CollectedArtifact[] {
  return walkFiles(dataDir).map((absolute) => {
    const rel = relative(dataDir, absolute).replace(/\\/g, "/");
    const mapped = mapArtifact(rel);
    if (!mapped) return null;
    return {
      artifactId: rel,
      group: mapped.group,
      kind: mapped.kind,
      title: basename(rel),
      legacyPath: rel,
      storageUri: relative(storageRoot, absolute).replace(/\\/g, "/"),
      sourceRefs: [],
      quality: qualityByPath[rel] ?? {}
    };
  }).filter((value): value is CollectedArtifact => Boolean(value));
}

function mapArtifact(path: string): Pick<CollectedArtifact, "group" | "kind"> | null {
  if (path.startsWith("processed/parsed/") && path.endsWith(".md")) return { group: "evidence", kind: "processed_doc" };
  if (path.startsWith("wiki/_meta/") && path.endsWith(".json")) return { group: "evidence", kind: "extract_meta" };
  if (path.startsWith("wiki/_tables/")) return { group: "table", kind: "table_registry" };
  if (path.startsWith("table_schemas/") && path.endsWith(".json")) return { group: "table", kind: "table_schema_json" };
  if (path === "wiki/graph.json") return { group: "graph", kind: "graph_snapshot" };
  if (path === "wiki/index.md") return { group: "index", kind: "topic_index" };
  if (path === "wiki/graph.html") return { group: "graph", kind: "graph_view" };
  if (path === "wiki/quality_report.json") return { group: "quality", kind: "quality_report" };
  if (path.startsWith("wiki/") && path.endsWith(".md")) return { group: "wiki", kind: path.startsWith("wiki/tables/") ? "table_wiki_page" : "wiki_page" };
  return null;
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(path));
    else out.push(path);
  }
  return out.sort();
}
```

- [ ] **Step 4: Implement pipeline service**

Create `src/server/services/kbBuilderService.ts` with methods:

```typescript
export function createKbBuilderPipelineService(db: DatabaseHandle, dataDir: string) {
  return new KbBuilderPipelineService(db, dataDir);
}
```

The class must:

```typescript
async build(options: BuildPipelineOptions): Promise<{ run: KnowledgeBuildRun; package: AssetPackage; qualitySummary: any }>
async listRuns(): Promise<KnowledgeBuildRun[]>
async getRun(runId: string): Promise<KnowledgeBuildRun | null>
async getActiveQualityProfile(): Promise<QualityGateProfile>
async updateActiveQualityProfile(config: QualityGateConfig, user: string): Promise<QualityGateProfile>
```

Inside `build()` use this exact order:

```typescript
const sourceService = createSourceBundleService(this.db, this.dataDir);
const runId = `run_${new Date().toISOString().replace(/[-:.TZ]/g, "")}_${nanoid(6)}`;
const workspaceRoot = join(this.dataDir, "kb-build-runs");
await this.insertRun({ runId, status: "running", ... });
const workspace = await materializeSourceVersion({ db: this.db, sourceService, versionId: options.versionId, workspaceRoot, runId });
const specDir = ensureWikiSpecs(workspace.dataDir);
const specs = loadWikiSpecs(specDir);
await runConvertStage(...);
await runExtractStage(...);
await runTableStage(...);
await runGraphStage(...);
await runVizStage(...);
const quality = evaluateQualityGate(...);
writeFileSync(join(workspace.dataDir, "wiki", "quality_report.json"), JSON.stringify(quality, null, 2));
const packageId = `pkg_${runId}`;
await this.insertPackageAndArtifacts(packageId, runId, workspace, quality);
await this.completeRun(runId, packageId, specs.hash, workspace.workspaceDir);
return { run: await this.requireRun(runId), package: await this.requirePackage(packageId), qualitySummary: package.qualitySummary };
```

- [ ] **Step 5: Verify and commit**

Run: `npm test -- tests/kb-builder-service.test.ts`
Expected: PASS.

Run: `npm test -- tests/kb-builder-*.test.ts`
Expected: PASS for all kb-builder tests created so far.

Commit:

```bash
git add src/server/services/kbBuilder/collector.ts src/server/services/kbBuilderService.ts tests/kb-builder-service.test.ts
git commit -m "feat: orchestrate native kb builder packages"
```

## Task 9: API Routes and Authorization

**Files:**
- Modify: `src/server/app.ts`
- Modify: `src/client/src/api.ts`
- Test: `tests/kb-builder-api.test.ts`

- [ ] **Step 1: Write failing API tests**

Create `tests/kb-builder-api.test.ts` with three tests:

```typescript
it("POST /api/source-bundles/:bundleId/versions/:versionId/build creates one package", async () => {
  const response = await app.inject({ method: "POST", url: `/api/source-bundles/default/versions/${versionId}/build`, headers: authHeaders(adminToken), payload: { stages: ["convert", "extract", "tables", "graph", "viz"], model: "deterministic", force: false, only: null, qualityProfileId: "default" } });
  expect(response.statusCode).toBe(200);
  expect(response.json().package.kind).toBe("kb_builder_pipeline");
});

it("allows admins to update the active quality profile", async () => {
  const response = await app.inject({ method: "PUT", url: "/api/quality-gate/profile", headers: authHeaders(adminToken), payload: { config: { minPackageScore: 0.8, rules: { wikiSpecCompleteness: { enabled: true, severity: "blocking", minScore: 0.8 } } } } });
  expect(response.statusCode).toBe(200);
  expect(response.json().profile.config.minPackageScore).toBe(0.8);
});

it("rejects non-admin quality profile updates", async () => {
  const response = await app.inject({ method: "PUT", url: "/api/quality-gate/profile", headers: authHeaders(devToken), payload: { config: { minPackageScore: 0.8, rules: {} } } });
  expect(response.statusCode).toBe(403);
});
```

- [ ] **Step 2: Run failing API tests**

Run: `npm test -- tests/kb-builder-api.test.ts`
Expected: FAIL with route not found.

- [ ] **Step 3: Add routes**

In `src/server/app.ts`, instantiate:

```typescript
const kbBuilderService = createKbBuilderPipelineService(options.db, dataDir);
```

Add routes:

```typescript
app.post<{ Params: { bundleId: string; versionId: string } }>(
  "/api/source-bundles/:bundleId/versions/:versionId/build",
  { preHandler: app.authenticate },
  async (request, reply) => {
    const parsed = buildRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid build payload." });
    const version = await bundleService.getVersion(request.params.versionId);
    if (!version || version.bundleId !== request.params.bundleId) return reply.code(404).send({ error: "未找到该资料版本。" });
    try {
      return await kbBuilderService.build({ ...parsed.data, bundleId: request.params.bundleId, versionId: request.params.versionId, requestedBy: request.user.username });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "构建失败。" });
    }
  }
);
```

Add:

```typescript
app.get("/api/build-runs", { preHandler: app.authenticate }, async () => ({ runs: await kbBuilderService.listRuns() }));
app.get<{ Params: { runId: string } }>("/api/build-runs/:runId", { preHandler: app.authenticate }, async (request, reply) => {
  const run = await kbBuilderService.getRun(request.params.runId);
  return run ? { run } : reply.code(404).send({ error: "Unknown build run." });
});
app.get("/api/quality-gate/profile", { preHandler: app.authenticate }, async () => ({ profile: await kbBuilderService.getActiveQualityProfile() }));
app.put("/api/quality-gate/profile", { preHandler: app.authenticate }, async (request, reply) => {
  if (request.user.role !== "admin") return reply.code(403).send({ error: "Only administrators can update quality gates." });
  const parsed = qualityProfileUpdateSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid quality profile payload." });
  return { profile: await kbBuilderService.updateActiveQualityProfile(parsed.data.config, request.user.username) };
});
```

- [ ] **Step 4: Add client API helpers**

In `src/client/src/api.ts`, add interfaces and functions:

```typescript
export interface KnowledgeBuildRun { runId: string; sourceVersionId: string; packageId: string | null; status: string; startedAt: string; finishedAt: string | null; error: string; outputUri: string; }
export interface QualityGateProfile { profileId: string; name: string; active: boolean; config: Record<string, unknown>; createdBy: string; updatedAt: string; }
export interface BuildRequest { stages: string[]; model: string; force: boolean; only: string | null; qualityProfileId: string; }
export interface BuildResponse { run: KnowledgeBuildRun; package: AssetPackage; qualitySummary: Record<string, unknown>; }

export async function buildKnowledgePackage(bundleId: string, versionId: string, payload: BuildRequest): Promise<BuildResponse> {
  const response = await fetch(`/api/source-bundles/${encodeURIComponent(bundleId)}/versions/${encodeURIComponent(versionId)}/build`, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  return parseResponse(response);
}

export async function getQualityProfile(): Promise<QualityGateProfile> {
  return (await getJson<{ profile: QualityGateProfile }>("/api/quality-gate/profile")).profile;
}

export async function updateQualityProfile(config: Record<string, unknown>): Promise<QualityGateProfile> {
  const response = await fetch("/api/quality-gate/profile", {
    method: "PUT",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ config })
  });
  return (await parseResponse<{ profile: QualityGateProfile }>(response)).profile;
}
```

- [ ] **Step 5: Verify and commit**

Run: `npm test -- tests/kb-builder-api.test.ts`
Expected: PASS.

Commit:

```bash
git add src/server/app.ts src/client/src/api.ts tests/kb-builder-api.test.ts
git commit -m "feat: expose native kb builder api"
```

## Task 10: Frontend Build and Quality Gate UI

**Files:**
- Modify: `src/client/src/ui/App.tsx`
- Modify: `src/client/src/styles.css`

- [ ] **Step 1: Add source build controls**

In `Sources()` inside `src/client/src/ui/App.tsx`, add a build mutation:

```tsx
const buildMutation = useMutation({
  mutationFn: () => {
    if (!selectedVersion) throw new Error("请选择资料版本。");
    return buildKnowledgePackage("default", selectedVersion.versionId, {
      stages: ["convert", "extract", "tables", "graph", "viz"],
      model: "deterministic",
      force: false,
      only: null,
      qualityProfileId: "default"
    });
  },
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ["packages"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  }
});
```

Render a compact build panel near selected version details:

```tsx
<section className="panel build-panel">
  <div className="panel-header">
    <h3>知识库构建 Pipeline</h3>
    <Badge tone={buildMutation.isPending ? "warning" : "neutral"}>{buildMutation.isPending ? "构建中" : "原生构建"}</Badge>
  </div>
  <div className="stage-row">
    {["convert", "extract", "tables", "graph", "viz"].map((stage) => <span key={stage}>{stage}</span>)}
  </div>
  <button disabled={!selectedVersion || buildMutation.isPending} onClick={() => buildMutation.mutate()}>
    生成知识资产包
  </button>
  {buildMutation.data && <p className="muted">已生成：{buildMutation.data.package.name}</p>}
  {buildMutation.error && <div className="error">{buildMutation.error instanceof Error ? buildMutation.error.message : String(buildMutation.error)}</div>}
</section>
```

- [ ] **Step 2: Add quality gate admin panel**

Add `QualityGateAdmin()` in `App.tsx` and render it in `Maintenance()`:

```tsx
function QualityGateAdmin() {
  const { data, isLoading, error } = useQuery({ queryKey: ["quality-profile"], queryFn: getQualityProfile });
  const [draft, setDraft] = useState("");
  const mutation = useMutation({
    mutationFn: () => updateQualityProfile(JSON.parse(draft)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["quality-profile"] })
  });

  useEffect(() => {
    if (data) setDraft(JSON.stringify(data.config, null, 2));
  }, [data]);

  if (isLoading) return <Loading />;
  if (error) return <ErrorState error={error} />;
  return (
    <section className="panel">
      <div className="panel-header">
        <h3>知识质量门禁</h3>
        <Badge tone="warning">管理员</Badge>
      </div>
      <textarea className="code-editor" value={draft} onChange={(event) => setDraft(event.target.value)} />
      <button onClick={() => mutation.mutate()} disabled={mutation.isPending}>保存门禁配置</button>
      {mutation.error && <div className="error">{mutation.error instanceof Error ? mutation.error.message : String(mutation.error)}</div>}
    </section>
  );
}
```

Use the existing `403` response to keep non-admin users read-only by disabling the save button when `/api/me` role is not `admin` if `me` state exists; if `me` is not currently exposed in `App.tsx`, rely on the API rejection for this task and surface the error.

- [ ] **Step 3: Add styles**

In `src/client/src/styles.css`, add:

```css
.build-panel {
  display: grid;
  gap: 12px;
}

.stage-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.stage-row span {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 12px;
  color: var(--muted);
}

.code-editor {
  min-height: 260px;
  width: 100%;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12px;
}
```

- [ ] **Step 4: Verify frontend**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm run build`
Expected: PASS and Vite build completes.

Commit:

```bash
git add src/client/src/ui/App.tsx src/client/src/styles.css
git commit -m "feat: add kb builder frontend controls"
```

## Task 11: Full Verification and Handoff

**Files:**
- Modify: `docs/superpowers/specs/2026-06-11-kb-builder-pipeline-quality-gates-design.md` only if execution discovers a mismatch between spec and shipped behavior.

- [ ] **Step 1: Run complete tests**

Run: `npm test`
Expected: PASS for all Vitest suites, including existing API/source/legacy/Tauri tests and new kb-builder tests.

- [ ] **Step 2: Run typecheck and build**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Run the desktop smoke check**

Run: `npm run tauri:dev`
Expected: backend listens on `http://0.0.0.0:4174`, Tauri reaches the app, and there is no plugin configuration panic.

Stop the dev process after confirming startup.

- [ ] **Step 4: Review changed files**

Run: `git status --short`
Expected: only this feature's tracked edits plus the pre-existing unrelated Tauri config files if they have not yet been committed separately.

Run: `git log --oneline -5`
Expected: feature commits appear after `26c4bce docs: design kb builder pipeline quality gates`.

- [ ] **Step 5: Final commit if needed**

If verification required small fixes, commit them:

```bash
git add <verified feature files>
git commit -m "fix: stabilize native kb builder pipeline"
```

Do not include `.codegraph/`, `.superpowers/`, or unrelated Tauri config changes in this feature commit unless the user explicitly asks to include them.

## Self-Review

Spec coverage:
- Native source version consumption is covered by Tasks 2 and 8.
- Old pipeline output contract is covered by Tasks 4, 5, 6, and 8.
- Wiki spec completeness, required facts, source traceability, graph integrity, and concept/table quality are covered by Tasks 3, 6, and 7.
- Build run/profile schema and admin quality gate updates are covered by Tasks 1 and 9.
- Frontend build action and administrator quality gate panel are covered by Task 10.

Type consistency:
- `PipelineStage`, `KnowledgeBuildRun`, `QualityGateProfile`, `QualityGateConfig`, and `QualityFinding` are introduced in Task 1 before service/API/UI usage.
- `RunWorkspace`, `StageResult`, `CollectedArtifact`, and `QualityGateResult` are introduced in Task 2 before later stage modules use them.
- API response names match client helper names: `run`, `package`, `qualitySummary`, and `profile`.

Placeholder scan:
- This plan intentionally avoids calling old Python entrypoints and defines concrete file paths, commands, expected results, and code snippets for each implementation task.
