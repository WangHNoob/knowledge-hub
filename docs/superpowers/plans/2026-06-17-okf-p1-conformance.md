# OKF Phase 1: Conformance Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a read-only `OkfConformanceService` that scans a workspace directory (default `knowledge/wiki`) and produces an OKF v0.1 conformance report — without modifying any knowledge file.

**Architecture:** A small set of dependency-free pure modules under `src/server/services/okf/`: a frontmatter splitter (lifted from the existing regex idiom in `extractStage.ts`, no YAML library), a markdown link/citation scanner, a `scanWorkspace` orchestrator that classifies issues into two layers (`okf_conformance` = blocking baseline, `kh_publish_quality` = warning), and a markdown report renderer. A thin CLI exposes it as `npm run okf:scan`.

**Tech Stack:** TypeScript (strict, no `any`), Node 22 `node:fs`/`node:path`, Vitest. No new runtime dependencies — the project deliberately hand-rolls frontmatter parsing.

**Scope note:** This plan covers Phase 1 of `docs/OKF开发文档.md` only. P1 *counts and warns* on `[[obsidian]]` and broken links — it does NOT resolve them (that is P3). P2–P6 each get their own just-in-time plan after the prior phase lands.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/server/services/okf/types.ts` | P1 type contracts: `OkfIssue`, `OkfIssueType`, `ConformanceReport` (subset of dev doc §3) |
| `src/server/services/okf/frontmatter.ts` | `scanFrontmatter(markdown)` → presence/unparseable/top-level keys/`type`/body (dependency-free) |
| `src/server/services/okf/markdownScan.ts` | `scanMarkdown(body)` → obsidian links, bundle-relative md links, `# Citations` presence |
| `src/server/services/okf/conformanceService.ts` | `scanWorkspace(dir, opts)` → walks `**/*.md`, classifies issues, builds `ConformanceReport` |
| `src/server/services/okf/reportRender.ts` | `renderReportMarkdown(report)` → human-readable `okf_report.md` |
| `src/server/services/okf/cli.ts` | thin CLI: reads dir arg, writes `okf_report.json` + `okf_report.md` |
| `tests/okf-frontmatter.test.ts` | unit tests for frontmatter + markdown scan |
| `tests/okf-conformance.test.ts` | service test: temp workspace, report assertions, no-mutation guarantee |
| `package.json` | add `"okf:scan"` script |

---

## Task 0: Branch setup

**Files:** none

- [ ] **Step 1: Create a feature branch** (we are on `main` with unrelated working-tree changes; keep OKF commits isolated)

Run:
```bash
git switch -c feat/okf-p1-conformance
```
Expected: `Switched to a new branch 'feat/okf-p1-conformance'`

> All subsequent commits `git add` only the specific OKF files — never `git add -A` — so unrelated working-tree changes are not swept in.

---

## Task 1: P1 type contracts

**Files:**
- Create: `src/server/services/okf/types.ts`

- [ ] **Step 1: Write the types** (no behavior → no test; this is a scaffold commit)

```typescript
// src/server/services/okf/types.ts
// P1 subset of the OKF contracts defined in docs/OKF开发文档.md §3.

export type OkfIssueLayer = "okf_conformance" | "kh_publish_quality";

export type OkfIssueType =
  | "missing_frontmatter"
  | "unparseable_yaml"
  | "missing_type"
  | "obsidian_link"
  | "broken_link"
  | "missing_description"
  | "missing_tags"
  | "missing_timestamp"
  | "missing_resource"
  | "missing_citation";

export interface OkfIssue {
  okfPath: string; // POSIX, leading slash, e.g. /systems/成就.md
  issueType: OkfIssueType;
  layer: OkfIssueLayer;
  blocking: boolean;
  message: string;
}

export interface ConformanceReport {
  okfVersion: "0.1";
  exporterVersion: number;
  scannedAt: string; // ISO 8601, injected by caller
  conceptCount: number;
  referenceCount: number;
  issues: OkfIssue[];
  summary: { blocking: number; warning: number; info: number };
  linkSummary: { resolved: number; ambiguous: number; unresolved: number };
  citationSummary: { required: number; present: number };
}

export const OKF_EXPORTER_VERSION = 1;
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS (no errors from the new file)

- [ ] **Step 3: Commit**

```bash
git add src/server/services/okf/types.ts
git commit -m "feat(okf): add P1 conformance type contracts"
```

---

## Task 2: Frontmatter scanner

**Files:**
- Create: `src/server/services/okf/frontmatter.ts`
- Test: `tests/okf-frontmatter.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/okf-frontmatter.test.ts
import { describe, expect, it } from "vitest";
import { scanFrontmatter } from "../src/server/services/okf/frontmatter";

describe("scanFrontmatter", () => {
  it("parses a valid block: type, top-level keys, body", () => {
    const md = `---\ntype: system_rule\ntitle: "成就系统"\nsource: "成就.docx"\n---\n\n## 概述\nhello`;
    const r = scanFrontmatter(md);
    expect(r.hasFrontmatter).toBe(true);
    expect(r.unparseable).toBe(false);
    expect(r.type).toBe("system_rule");
    expect(r.keys.has("title")).toBe(true);
    expect(r.keys.has("source")).toBe(true);
    expect(r.body.trim().startsWith("## 概述")).toBe(true);
  });

  it("strips quotes around the type value", () => {
    expect(scanFrontmatter(`---\ntype: "Reference"\n---\nx`).type).toBe("Reference");
  });

  it("registers block-style keys (entities/facts) without values", () => {
    const md = `---\ntype: system_rule\nentities:\n  - name: A\n    type: system\nfacts:\n  k: v\n---\nbody`;
    const r = scanFrontmatter(md);
    expect(r.keys.has("entities")).toBe(true);
    expect(r.keys.has("facts")).toBe(true);
  });

  it("flags missing closing delimiter as unparseable", () => {
    const r = scanFrontmatter(`---\ntype: system_rule\nno closing here`);
    expect(r.hasFrontmatter).toBe(false);
    expect(r.unparseable).toBe(true);
  });

  it("reports no frontmatter for plain markdown", () => {
    const r = scanFrontmatter(`# Just a heading\ntext`);
    expect(r.hasFrontmatter).toBe(false);
    expect(r.unparseable).toBe(false);
  });

  it("treats empty type value as missing type", () => {
    expect(scanFrontmatter(`---\ntype:\ntitle: x\n---\nb`).type).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/okf-frontmatter.test.ts`
Expected: FAIL — `Cannot find module '../src/server/services/okf/frontmatter'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/server/services/okf/frontmatter.ts
// Dependency-free frontmatter splitter. Mirrors the regex idiom already used in
// src/server/services/kbBuilder/extractStage.ts (the project ships no YAML library).

export interface FrontmatterScan {
  hasFrontmatter: boolean;
  unparseable: boolean; // opened with --- but never closed
  body: string;
  keys: Set<string>; // top-level keys present in the block
  type: string; // trimmed, unquoted value of `type`; "" if absent/empty
}

const BLOCK_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u;
const OPEN_RE = /^---\r?\n/u;
const SCALAR_RE = /^([A-Za-z_][\w-]*):\s*(.*)$/;

export function scanFrontmatter(markdown: string): FrontmatterScan {
  const match = BLOCK_RE.exec(markdown);
  if (!match) {
    return {
      hasFrontmatter: false,
      unparseable: OPEN_RE.test(markdown),
      body: markdown,
      keys: new Set(),
      type: "",
    };
  }

  const keys = new Set<string>();
  let type = "";
  for (const line of match[1].split(/\r?\n/)) {
    const scalar = SCALAR_RE.exec(line);
    if (!scalar) continue; // block child lines (indented) are skipped; parent key already captured
    const [, key, value] = scalar;
    keys.add(key);
    if (key === "type" && value.trim() !== "") {
      type = value.trim().replace(/^["']|["']$/gu, "");
    }
  }

  return { hasFrontmatter: true, unparseable: false, body: match[2], keys, type };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/okf-frontmatter.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/services/okf/frontmatter.ts tests/okf-frontmatter.test.ts
git commit -m "feat(okf): add dependency-free frontmatter scanner"
```

---

## Task 3: Markdown link & citation scanner

**Files:**
- Create: `src/server/services/okf/markdownScan.ts`
- Test: append to `tests/okf-frontmatter.test.ts`

- [ ] **Step 1: Write the failing test** (append this block to `tests/okf-frontmatter.test.ts`)

```typescript
import { scanMarkdown } from "../src/server/services/okf/markdownScan";

describe("scanMarkdown", () => {
  it("collects obsidian links", () => {
    const r = scanMarkdown("see [[海图绘]] and [[SwitchCondition]]");
    expect(r.obsidian).toEqual(["海图绘", "SwitchCondition"]);
  });

  it("collects bundle-relative markdown links to .md targets", () => {
    const r = scanMarkdown("[SwitchCondition](/tables/SwitchCondition.md) and [ext](https://x.com)");
    expect(r.bundleLinks).toEqual(["/tables/SwitchCondition.md"]);
  });

  it("detects a # Citations section", () => {
    expect(scanMarkdown("body\n\n# Citations\n[1] [x](/r/x.md)").hasCitations).toBe(true);
    expect(scanMarkdown("body only").hasCitations).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/okf-frontmatter.test.ts`
Expected: FAIL — `Cannot find module '../src/server/services/okf/markdownScan'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/server/services/okf/markdownScan.ts

export interface MarkdownScan {
  obsidian: string[]; // inner text of each [[...]]
  bundleLinks: string[]; // standard md links whose target is a bundle-relative /....md path
  hasCitations: boolean; // body contains a "# Citations" heading
}

const OBSIDIAN_RE = /\[\[([^\]]+)\]\]/gu;
const MD_BUNDLE_LINK_RE = /\[[^\]]*\]\((\/[^)]+\.md)\)/gu;
const CITATIONS_RE = /^#\s+Citations\s*$/mu;

export function scanMarkdown(body: string): MarkdownScan {
  const obsidian: string[] = [];
  const bundleLinks: string[] = [];
  for (const m of body.matchAll(OBSIDIAN_RE)) obsidian.push(m[1].trim());
  for (const m of body.matchAll(MD_BUNDLE_LINK_RE)) bundleLinks.push(m[1]);
  return { obsidian, bundleLinks, hasCitations: CITATIONS_RE.test(body) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/okf-frontmatter.test.ts`
Expected: PASS (9 tests total)

- [ ] **Step 5: Commit**

```bash
git add src/server/services/okf/markdownScan.ts tests/okf-frontmatter.test.ts
git commit -m "feat(okf): add markdown link and citation scanner"
```

---

## Task 4: Conformance service (`scanWorkspace`)

**Files:**
- Create: `src/server/services/okf/conformanceService.ts`
- Test: `tests/okf-conformance.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/okf-conformance.test.ts
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanWorkspace } from "../src/server/services/okf/conformanceService";

let dir: string;

function write(rel: string, content: string): string {
  const full = path.join(dir, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
  return full;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "okf-scan-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("scanWorkspace", () => {
  it("flags missing type as a blocking okf_conformance issue", async () => {
    write("systems/a.md", `---\ntitle: A\n---\nbody`);
    const report = await scanWorkspace(dir, { now: "2026-06-17T00:00:00Z" });
    const issue = report.issues.find((i) => i.okfPath === "/systems/a.md" && i.issueType === "missing_type");
    expect(issue).toBeDefined();
    expect(issue?.layer).toBe("okf_conformance");
    expect(issue?.blocking).toBe(true);
    expect(report.summary.blocking).toBeGreaterThanOrEqual(1);
  });

  it("warns on obsidian links and missing optional fields without blocking", async () => {
    write("systems/b.md", `---\ntype: system_rule\ntitle: B\n---\nsee [[X]]`);
    const report = await scanWorkspace(dir, { now: "2026-06-17T00:00:00Z" });
    const types = report.issues.filter((i) => i.okfPath === "/systems/b.md").map((i) => i.issueType);
    expect(types).toContain("obsidian_link");
    expect(types).toContain("missing_description");
    expect(report.issues.filter((i) => i.okfPath === "/systems/b.md").every((i) => !i.blocking)).toBe(true);
  });

  it("resolves bundle links to existing files and flags broken ones", async () => {
    write("tables/T.md", `---\ntype: table_schema\ntitle: T\n---\n# Citations\n[1] [x](/x.md)`);
    write("systems/c.md", `---\ntype: system_rule\ntitle: C\n---\n[T](/tables/T.md) [gone](/tables/Z.md)`);
    const report = await scanWorkspace(dir, { now: "2026-06-17T00:00:00Z" });
    expect(report.linkSummary.resolved).toBe(1);
    expect(report.issues.some((i) => i.issueType === "broken_link" && i.okfPath === "/systems/c.md")).toBe(true);
  });

  it("requires a # Citations section on system_rule pages", async () => {
    write("systems/d.md", `---\ntype: system_rule\ntitle: D\ndescription: d\ntags: [x]\ntimestamp: 2026-06-17T00:00:00Z\nresource: kh://x\n---\nno citations`);
    const report = await scanWorkspace(dir, { now: "2026-06-17T00:00:00Z" });
    expect(report.citationSummary.required).toBe(1);
    expect(report.citationSummary.present).toBe(0);
    expect(report.issues.some((i) => i.issueType === "missing_citation" && i.okfPath === "/systems/d.md")).toBe(true);
  });

  it("skips reserved files (index.md, log.md)", async () => {
    write("index.md", `# Index`);
    write("log.md", `# Log`);
    write("systems/e.md", `---\ntype: system_rule\ntitle: E\n---\nx`);
    const report = await scanWorkspace(dir, { now: "2026-06-17T00:00:00Z" });
    expect(report.conceptCount).toBe(1);
    expect(report.issues.some((i) => i.okfPath === "/index.md")).toBe(false);
  });

  it("does not modify any scanned file", async () => {
    const f = write("systems/f.md", `---\ntype: system_rule\ntitle: F\n---\nx`);
    const before = statSync(f).mtimeMs;
    const content = readFileSync(f, "utf8");
    await scanWorkspace(dir, { now: "2026-06-17T00:00:00Z" });
    expect(readFileSync(f, "utf8")).toBe(content);
    expect(statSync(f).mtimeMs).toBe(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/okf-conformance.test.ts`
Expected: FAIL — `Cannot find module '../src/server/services/okf/conformanceService'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/server/services/okf/conformanceService.ts
import { promises as fs } from "node:fs";
import path from "node:path";

import { scanFrontmatter } from "./frontmatter";
import { scanMarkdown } from "./markdownScan";
import { OKF_EXPORTER_VERSION, type ConformanceReport, type OkfIssue, type OkfIssueLayer, type OkfIssueType } from "./types";

const RESERVED = new Set(["index.md", "log.md"]);
const OPTIONAL_FIELDS: Array<{ key: string; issueType: OkfIssueType }> = [
  { key: "description", issueType: "missing_description" },
  { key: "tags", issueType: "missing_tags" },
  { key: "timestamp", issueType: "missing_timestamp" },
  { key: "resource", issueType: "missing_resource" },
];
const CITATION_REQUIRED_TYPES = new Set([
  "system_rule",
  "activity_template",
  "table_schema",
  "ui_flow",
  "numerical_convention",
]);

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function issue(okfPath: string, issueType: OkfIssueType, layer: OkfIssueLayer, blocking: boolean, message: string): OkfIssue {
  return { okfPath, issueType, layer, blocking, message };
}

async function listMarkdown(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
    }
  }
  await walk(root);
  out.sort();
  return out;
}

export function createOkfConformanceService() {
  return { scanWorkspace };
}

export async function scanWorkspace(dir: string, opts: { now: string }): Promise<ConformanceReport> {
  const files = await listMarkdown(dir);
  const present = new Set(files.map((f) => `/${toPosix(path.relative(dir, f))}`));

  const issues: OkfIssue[] = [];
  let conceptCount = 0;
  let resolved = 0;
  let unresolved = 0;
  let citationRequired = 0;
  let citationPresent = 0;

  for (const file of files) {
    const okfPath = `/${toPosix(path.relative(dir, file))}`;
    if (RESERVED.has(path.basename(file))) continue; // reserved files are not concepts
    conceptCount += 1;

    const raw = await fs.readFile(file, "utf8");
    const fm = scanFrontmatter(raw);

    if (!fm.hasFrontmatter) {
      issues.push(
        fm.unparseable
          ? issue(okfPath, "unparseable_yaml", "okf_conformance", true, "frontmatter opened with --- but has no closing ---")
          : issue(okfPath, "missing_frontmatter", "okf_conformance", true, "no YAML frontmatter block"),
      );
      continue;
    }

    if (fm.type === "") {
      issues.push(issue(okfPath, "missing_type", "okf_conformance", true, "frontmatter has empty or missing type"));
    }

    for (const field of OPTIONAL_FIELDS) {
      if (!fm.keys.has(field.key)) {
        issues.push(issue(okfPath, field.issueType, "kh_publish_quality", false, `missing optional field: ${field.key}`));
      }
    }

    const links = scanMarkdown(fm.body);
    for (const inner of links.obsidian) {
      issues.push(issue(okfPath, "obsidian_link", "kh_publish_quality", false, `non-standard obsidian link: [[${inner}]]`));
      unresolved += 1;
    }
    for (const target of links.bundleLinks) {
      if (present.has(target)) {
        resolved += 1;
      } else {
        issues.push(issue(okfPath, "broken_link", "kh_publish_quality", false, `link target not found: ${target}`));
        unresolved += 1;
      }
    }

    if (CITATION_REQUIRED_TYPES.has(fm.type)) {
      citationRequired += 1;
      if (links.hasCitations) citationPresent += 1;
      else issues.push(issue(okfPath, "missing_citation", "kh_publish_quality", false, `${fm.type} page has no # Citations section`));
    }
  }

  const summary = {
    blocking: issues.filter((i) => i.blocking).length,
    warning: issues.filter((i) => !i.blocking).length,
    info: 0,
  };

  return {
    okfVersion: "0.1",
    exporterVersion: OKF_EXPORTER_VERSION,
    scannedAt: opts.now,
    conceptCount,
    referenceCount: 0,
    issues,
    summary,
    linkSummary: { resolved, ambiguous: 0, unresolved },
    citationSummary: { required: citationRequired, present: citationPresent },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/okf-conformance.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/services/okf/conformanceService.ts tests/okf-conformance.test.ts
git commit -m "feat(okf): add scanWorkspace conformance service"
```

---

## Task 5: Report renderer

**Files:**
- Create: `src/server/services/okf/reportRender.ts`
- Test: append to `tests/okf-conformance.test.ts`

- [ ] **Step 1: Write the failing test** (append to `tests/okf-conformance.test.ts`)

```typescript
import { renderReportMarkdown } from "../src/server/services/okf/reportRender";
import type { ConformanceReport } from "../src/server/services/okf/types";

describe("renderReportMarkdown", () => {
  it("renders summary and groups issues by file", () => {
    const report: ConformanceReport = {
      okfVersion: "0.1",
      exporterVersion: 1,
      scannedAt: "2026-06-17T00:00:00Z",
      conceptCount: 2,
      referenceCount: 0,
      issues: [
        { okfPath: "/systems/a.md", issueType: "missing_type", layer: "okf_conformance", blocking: true, message: "no type" },
        { okfPath: "/systems/a.md", issueType: "obsidian_link", layer: "kh_publish_quality", blocking: false, message: "[[X]]" },
      ],
      summary: { blocking: 1, warning: 1, info: 0 },
      linkSummary: { resolved: 0, ambiguous: 0, unresolved: 1 },
      citationSummary: { required: 0, present: 0 },
    };
    const md = renderReportMarkdown(report);
    expect(md).toContain("# OKF Conformance Report");
    expect(md).toContain("blocking: 1");
    expect(md).toContain("/systems/a.md");
    expect(md).toContain("missing_type");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/okf-conformance.test.ts -t renderReportMarkdown`
Expected: FAIL — `Cannot find module '../src/server/services/okf/reportRender'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/server/services/okf/reportRender.ts
import type { ConformanceReport, OkfIssue } from "./types";

export function renderReportMarkdown(report: ConformanceReport): string {
  const lines: string[] = [
    "# OKF Conformance Report",
    "",
    `- scannedAt: ${report.scannedAt}`,
    `- okfVersion: ${report.okfVersion}`,
    `- conceptCount: ${report.conceptCount}`,
    `- blocking: ${report.summary.blocking}`,
    `- warning: ${report.summary.warning}`,
    `- links: resolved ${report.linkSummary.resolved} / ambiguous ${report.linkSummary.ambiguous} / unresolved ${report.linkSummary.unresolved}`,
    `- citations: ${report.citationSummary.present}/${report.citationSummary.required}`,
    "",
  ];

  const byPath = new Map<string, OkfIssue[]>();
  for (const issue of report.issues) {
    byPath.set(issue.okfPath, [...(byPath.get(issue.okfPath) ?? []), issue]);
  }

  for (const okfPath of [...byPath.keys()].sort()) {
    lines.push(`## ${okfPath}`, "");
    for (const issue of byPath.get(okfPath) ?? []) {
      const tag = issue.blocking ? "BLOCKING" : "warning";
      lines.push(`- [${tag}] ${issue.issueType} (${issue.layer}) — ${issue.message}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/okf-conformance.test.ts -t renderReportMarkdown`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/services/okf/reportRender.ts tests/okf-conformance.test.ts
git commit -m "feat(okf): add conformance report markdown renderer"
```

---

## Task 6: CLI entry + npm script

**Files:**
- Create: `src/server/services/okf/cli.ts`
- Modify: `package.json` (add `okf:scan` script)

- [ ] **Step 1: Write the CLI** (no unit test — it is a thin I/O wrapper; verified manually in Step 4)

```typescript
// src/server/services/okf/cli.ts
import { promises as fs } from "node:fs";
import path from "node:path";

import { scanWorkspace } from "./conformanceService";
import { renderReportMarkdown } from "./reportRender";

async function main(): Promise<void> {
  const dir = process.argv[2] ?? path.resolve("knowledge/wiki");
  const outDir = process.argv[3] ?? process.cwd();
  const report = await scanWorkspace(dir, { now: new Date().toISOString() });
  await fs.writeFile(path.join(outDir, "okf_report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(outDir, "okf_report.md"), renderReportMarkdown(report), "utf8");
  console.log(
    `OKF scan of ${dir}: ${report.conceptCount} concepts, ` +
      `${report.summary.blocking} blocking, ${report.summary.warning} warning. ` +
      `Reports written to ${outDir}.`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Add the npm script** — in `package.json`, inside `"scripts"`, add:

```json
"okf:scan": "tsx src/server/services/okf/cli.ts"
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Run the CLI against the real workspace**

Run: `npm run okf:scan -- knowledge/wiki`
Expected: prints a summary line; creates `okf_report.json` and `okf_report.md` in the repo root. Open `okf_report.md` and confirm it lists the real `[[...]]` warnings (e.g. on `/systems/成就.md`) and any missing-field warnings.

- [ ] **Step 5: Commit** (do NOT commit the generated reports — they are scan output, not source)

```bash
git add src/server/services/okf/cli.ts package.json
git commit -m "feat(okf): add okf:scan CLI for workspace conformance baseline"
```

> If `okf_report.json` / `okf_report.md` were created in the repo root, add them to `.gitignore` or delete them — they are derived artifacts.

---

## Task 7: Full suite green + branch wrap-up

**Files:** none

- [ ] **Step 1: Run the whole test suite + typecheck** (confirm no regressions)

Run: `npm test && npm run typecheck`
Expected: all tests PASS, typecheck PASS.

- [ ] **Step 2: Confirm working tree is clean** of unintended files

Run: `git status`
Expected: only the OKF source files committed; no stray `okf_report.*` artifacts tracked.

---

## Self-Review (completed during authoring)

- **Spec coverage (dev doc §4):** scan `**/*.md` ✅ (Task 4 `listMarkdown`); skip reserved `index.md`/`log.md` ✅ (Task 4 + test); frontmatter parse + `type` non-empty as blocking `okf_conformance` ✅; optional-field + obsidian + broken-link + citation as `kh_publish_quality` warning ✅; emit `okf_report.json` + `okf_report.md` ✅ (Tasks 5–6); no knowledge file modified ✅ (Task 4 no-mutation test). The dev doc's "broken/obsidian only count, don't resolve in P1" boundary is honored — no resolver here.
- **Placeholder scan:** no TBD/TODO; every code step ships complete code.
- **Type consistency:** `scanFrontmatter`/`FrontmatterScan`, `scanMarkdown`/`MarkdownScan`, `scanWorkspace`/`ConformanceReport`, `OkfIssue`/`OkfIssueType`/`OkfIssueLayer`, `renderReportMarkdown`, `OKF_EXPORTER_VERSION` are used identically across Tasks 1–6.
- **Deferred to later phases (correctly out of scope):** `linkSummary.ambiguous` stays 0 until P3's resolver; `referenceCount` stays 0 until P4's references; release binding is P5.
```
