// tests/okf-conformance.test.ts
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanWorkspace } from "../src/server/services/okf/conformanceService";
import { renderReportMarkdown } from "../src/server/services/okf/reportRender";
import type { ConformanceReport } from "../src/server/services/okf/types";

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
    write("index.md", `# Index\n\n- [E](/systems/e.md)`);
    write("log.md", `# Log`);
    write("systems/e.md", `---\ntype: system_rule\ntitle: E\n---\nx`);
    const report = await scanWorkspace(dir, { now: "2026-06-17T00:00:00Z" });
    expect(report.conceptCount).toBe(1);
    expect(report.linkSummary.resolved).toBe(1);
    expect(report.issues.some((i) => i.okfPath === "/index.md")).toBe(false);
  });

  it("walks nested directories more than one level deep", async () => {
    write("a/b/c/deep.md", `---\ntype: system_rule\ntitle: Deep\n---\nx`);
    const report = await scanWorkspace(dir, { now: "2026-06-17T00:00:00Z" });
    expect(report.issues.some((i) => i.okfPath === "/a/b/c/deep.md")).toBe(true);
    expect(report.conceptCount).toBe(1);
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
