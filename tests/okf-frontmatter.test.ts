// tests/okf-frontmatter.test.ts
import { describe, expect, it } from "vitest";
import { scanFrontmatter } from "../src/server/services/okf/frontmatter";
import { scanMarkdown } from "../src/server/services/okf/markdownScan";

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
