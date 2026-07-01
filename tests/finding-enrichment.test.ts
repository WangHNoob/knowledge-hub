import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { enrichFindings, fallbackEnrichment, MAX_ENRICHED } from "../src/server/services/kbBuilder/findingEnrichment";
import type { QualityFinding } from "../src/server/types";

function finding(overrides: Partial<QualityFinding> = {}): QualityFinding {
  return {
    ruleId: "graphIntegrity",
    severity: "blocking",
    componentId: "wiki/systems/foo.md",
    title: "Dangling graph edge",
    description: "foo -> config",
    suggestedAction: "修复 meta 关系或表注册表。",
    scoreImpact: 0.2,
    ...overrides,
  };
}

describe("finding enrichment", () => {
  it("falls back to a single suggestion candidate without an LLM (deterministic provider)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-enrich-"));
    try {
      const results = await enrichFindings([finding()], {
        dataDir,
        modelConfig: { provider: "deterministic", model: "deterministic" },
        resolveSource: () => ({ sourcePath: "gamedocs/foo.md", wikiRel: "wiki/systems/foo.md", pageType: "" }),
        warnings: [],
      });

      expect(results).toHaveLength(1);
      const [result] = results;
      expect(result.enriched).toBe(false);
      // 人话标题/解释退回原 finding 文本。
      expect(result.humanTitle).toBe("Dangling graph edge");
      expect(result.humanExplain).toBe("foo -> config");
      // 通用兜底不再使用含糊的“按建议修复”，也不带结构化 override。
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0].id).toBe("manual_follow_suggestion");
      expect(result.candidates[0].label).toBe("人工按原建议处理");
      expect(result.candidates[0].value).not.toHaveProperty("override");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("preserves input order and length across many findings", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-enrich-order-"));
    try {
      const findings = Array.from({ length: MAX_ENRICHED + 5 }, (_, index) =>
        finding({ componentId: `wiki/systems/foo${index}.md`, description: `edge-${index}` }));
      const warnings: string[] = [];
      const results = await enrichFindings(findings, {
        dataDir,
        modelConfig: { provider: "deterministic", model: "deterministic" },
        resolveSource: (item) => ({ sourcePath: "gamedocs/x.md", wikiRel: item.componentId ?? "", pageType: "" }),
        warnings,
      });

      expect(results).toHaveLength(findings.length);
      // 同序：第 i 个结果对应第 i 条 finding。
      results.forEach((result, index) => {
        expect(result.humanExplain).toBe(`edge-${index}`);
      });
      // deterministic provider 下无 LLM，不应触发 cap 警告（全部走兜底）。
      expect(warnings.some((warning) => warning.includes("capped"))).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("fallbackEnrichment keeps a clear manual candidate for generic findings", () => {
    const result = fallbackEnrichment(finding({ scoreImpact: 0.25 }));
    expect(result.enriched).toBe(false);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].value).toMatchObject({
      ruleId: "graphIntegrity",
      action: "修复 meta 关系或表注册表。",
    });
    // confidence = 1 - scoreImpact，clamp 到 [0,1]。
    expect(result.candidates[0].confidence).toBeCloseTo(0.75, 5);
  });

  it("creates executable fallback repairs for wiki spec completeness findings", () => {
    const result = fallbackEnrichment(finding({
      ruleId: "wikiSpecCompleteness",
      componentId: "wiki/concepts/阵法特权.md",
      description: "Score 0.65; missing sections: Overview, Data Dependencies.",
      suggestedAction: "补齐 wiki spec 要求的章节，并避免必填章节为空。",
    }), {
      sourcePath: "gamedocs/阵法特权.md",
      wikiRel: "wiki/concepts/阵法特权.md",
      pageType: "",
      componentMarkdown: "# 阵法特权\n\n已有内容",
    });

    expect(result.humanTitle).toContain("页面结构不完整");
    expect(result.candidates[0].id).toBe("append_missing_spec_sections");
    expect(result.candidates[0].value).toHaveProperty("override");
    expect(result.candidates[1].value).toMatchObject({ action: "dismiss_rule" });
  });
});
