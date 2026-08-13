import { describe, expect, it } from "vitest";

import {
  extractCitationIds,
  extractProseNumbers,
  tableStructureOk,
  validateDocumentRewrite,
} from "../src/server/services/documentRewriteValidation";

const ctx = {
  evidence: [
    { evidenceId: "ev_cmp_0001", quote: "冷却时间 12 秒，能量消耗 40，倍率 150%。" },
    { evidenceId: "ev_cmp_0002", quote: "初始 3 层，最大 5 层。" },
  ],
  sourceText: "暗影穿心：冷却 12 秒，能量 40。",
};

const goodMarkdown = [
  "## 技能说明",
  "暗影穿心的冷却时间为 12 秒，能量消耗 40，倍率 150% [evidence:ev_cmp_0001]。",
  "",
  "| 层数 | 上限 |",
  "|------|------|",
  "| 初始 | 3 |",
  "| 最大 | 5 |",
  "",
  "## 相关机制",
  "叠层规则见 [evidence:ev_cmp_0002]。",
].join("\n");

describe("document rewrite validation (flywheel 02-P4)", () => {
  it("passes a structurally sound, fact-grounded, closed-citation rewrite", () => {
    const result = validateDocumentRewrite(goodMarkdown, ctx);
    expect(result.valid).toBe(true);
    expect(result).toMatchObject({ structureOk: true, factsOk: true, citationsOk: true });
  });

  it("rejects short or heading-less rewrites", () => {
    expect(validateDocumentRewrite("太短", ctx).structureOk).toBe(false);
    expect(validateDocumentRewrite("没有标题的正文内容，虽然很长但缺少层级标题结构。", ctx).structureOk).toBe(false);
  });

  it("rejects unbalanced table rows", () => {
    const broken = goodMarkdown.replace("| 最大 | 5 |", "| 最大 | 5 | 多一列 |");
    expect(validateDocumentRewrite(broken, ctx).structureOk).toBe(false);
  });

  it("rejects citations outside the closed evidence set", () => {
    const fake = goodMarkdown.replace("[evidence:ev_cmp_0001]", "[evidence:ev_hallucinated_999]");
    const result = validateDocumentRewrite(fake, ctx);
    expect(result.valid).toBe(false);
    expect(result.citationsOk).toBe(false);
    expect(result.reason).toContain("封闭集合外");
  });

  it("rejects prose numbers that are not traceable to evidence/source", () => {
    const invented = goodMarkdown.replace("倍率 150%", "倍率 220%");
    const result = validateDocumentRewrite(invented, ctx);
    expect(result.valid).toBe(false);
    expect(result.factsOk).toBe(false);
    expect(result.reason).toContain("无法在证据/源文中核实");
  });

  it("ignores table-line numbers during fact checking", () => {
    const tableNumbers = goodMarkdown.replace("| 初始 | 3 |", "| 初始 | 33 |");
    const result = validateDocumentRewrite(tableNumbers, ctx);
    // 表格行数值不参与事实核对；33 未出现在封闭集合但被排除
    expect(result.factsOk).toBe(true);
  });

  it("extractCitationIds finds explicit and bare internal ids", () => {
    const ids = extractCitationIds("[evidence:ev_a] 正文 [cmp_b_1] 继续");
    expect(ids).toContain("ev_a");
    expect(ids).toContain("cmp_b_1");
  });

  it("extractProseNumbers skips table lines and code blocks", () => {
    const text = "| 10 | 20 |\n正文 12.5 秒与 85% 加成\n```\n99\n```";
    const numbers = extractProseNumbers(text);
    expect(numbers).toContain("12.5");
    expect(numbers).toContain("85%");
    expect(numbers).not.toContain("10");
    expect(numbers).not.toContain("20");
    expect(numbers).not.toContain("99");
  });

  it("tableStructureOk tolerates single-column and separator rows", () => {
    expect(tableStructureOk("| a | b |\n|---|---|\n| 1 | 2 |")).toBe(true);
    expect(tableStructureOk("| a | b |\n| 1 | 2 | 3 |")).toBe(false);
  });
});
