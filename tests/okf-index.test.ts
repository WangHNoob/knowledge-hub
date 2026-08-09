// tests/okf-index.test.ts
import { describe, expect, it } from "vitest";
import {
  INDEX_GROUPS,
  extractCsvRefs,
  extractIndexDescription,
  extractIndexTitle,
  groupForDoc,
  renderDirectoryIndex,
} from "../src/server/services/okf/indexTemplate";

describe("extractIndexTitle", () => {
  it("extracts the first H1 without the mark", () => {
    expect(extractIndexTitle("# 01 战斗框架与伤害公式\n\n正文")).toBe("01 战斗框架与伤害公式");
  });

  it("returns empty string when there is no H1", () => {
    expect(extractIndexTitle("## 背景\n正文")).toBe("");
  });
});

describe("extractIndexDescription", () => {
  it("takes the first blockquote scope line, stripping > and **", () => {
    const body = "# 01 战斗框架与伤害公式\n\n> 本文档是**伤害结算唯一权威来源**；暴击倍率、elemMul 只允许在此定义。\n\n## 背景与目标";
    const desc = extractIndexDescription(body);
    expect(desc).toContain("本文档是伤害结算唯一权威来源");
    expect(desc).not.toContain("**");
    expect(desc.length).toBeLessThanOrEqual(61);
  });

  it("skips status/metadata quote lines and reference lines", () => {
    const body = [
      "# 00 项目总览与术语表",
      "",
      "> 状态：v0.2 扩充基线 ｜ 维护人：数值组 ｜ 最后更新：2026-08-08",
      "> **引用**：参见《10_配表规范与外键约定》§4",
      "> 本文档是全库唯一权威的 ID 注册表 / 术语表 / 枚举表。",
      "",
      "## 背景与目标",
    ].join("\n");
    expect(extractIndexDescription(body)).toBe("本文档是全库唯一权威的 ID 注册表 / 术语表 / 枚举表。");
  });

  it("falls back to empty when only headings/tables exist", () => {
    expect(extractIndexDescription("# 01 X\n\n## 背景\n| a | b |\n| 1 | 2 |")).toBe("");
  });
});

describe("extractCsvRefs", () => {
  it("dedupes and keeps first occurrence order, capped at max", () => {
    const body = "见 Hero.csv 与 Skill.csv，Hero.csv 定义在 §2，另见 ElementChart.csv、Buff.csv、Item.csv、Material.csv、ShopItem.csv";
    expect(extractCsvRefs(body)).toEqual(["Hero.csv", "Skill.csv", "ElementChart.csv", "Buff.csv", "Item.csv", "Material.csv"]);
    expect(extractCsvRefs(body, 3)).toEqual(["Hero.csv", "Skill.csv", "ElementChart.csv"]);
  });

  it("ignores non-csv names", () => {
    expect(extractCsvRefs("运行 knowledge_gen/validate.mjs，读取 _tables/schemas.json")).toEqual([]);
  });
});

describe("groupForDoc / INDEX_GROUPS coverage", () => {
  it("covers every doc number 0..48 exactly once", () => {
    const seen = new Set<number>();
    for (const group of INDEX_GROUPS) {
      for (const number of group.docNumbers) {
        expect(seen.has(number)).toBe(false);
        seen.add(number);
      }
    }
    for (let number = 0; number <= 48; number += 1) {
      expect(seen.has(number)).toBe(true);
    }
  });

  it("maps numbered paths to the curated group and unknown paths to 其他", () => {
    expect(groupForDoc("concepts/01-战斗框架与伤害公式.md", "01 战斗框架与伤害公式").name).toBe("战斗与数值核心");
    expect(groupForDoc("concepts/45-随机数与保底机制总览.md", "45 随机数与保底机制总览").name).toBe("战斗与数值核心");
    expect(groupForDoc("concepts/12-版本变更记录-v0-1.md", "12 版本变更记录 v0.1").name).toBe("Optional（可跳过）");
    expect(groupForDoc("tables/ungrouped.md", "tables/ungrouped").name).toBe("其他");
  });
});

describe("renderDirectoryIndex", () => {
  const pages = [
    { okfPath: "concepts/00-项目总览与术语表.md", title: "00 项目总览与术语表", description: "全库术语与 ID 注册表唯一权威", csvRefs: [] },
    { okfPath: "concepts/01-战斗框架与伤害公式.md", title: "01 战斗框架与伤害公式", description: "伤害结算唯一权威来源", csvRefs: ["ElementChart.csv", "Buff.csv"] },
    { okfPath: "concepts/12-版本变更记录-v0-1.md", title: "12 版本变更记录 v0.1", description: "版本维护日志", csvRefs: [] },
    { okfPath: "tables/ungrouped.md", title: "tables/ungrouped", description: "未分组配表注册页", csvRefs: ["Hero.csv"] },
  ];

  it("renders frontmatter, grouped entries with descriptions and csv refs, and a where-to-find guide", () => {
    const out = renderDirectoryIndex({ releaseVersion: "2026.08.09.001", pages, assetUris: [
      "graph/graph.json",
      "tables/schemas.json",
      "meta/extract/concepts/00-项目总览与术语表.json",
      "search/index.json",
      "search/dense.json",
    ] });
    expect(out).toContain("okf_version: \"0.1\"");
    expect(out).toContain("# StarTrail 知识库目录");
    expect(out).toContain("## 必读（Start Here）");
    expect(out).toContain("- [00 项目总览与术语表](/concepts/00-项目总览与术语表.md): 全库术语与 ID 注册表唯一权威");
    expect(out).toContain("- [01 战斗框架与伤害公式](/concepts/01-战斗框架与伤害公式.md): 伤害结算唯一权威来源；关联 ElementChart.csv, Buff.csv");
    expect(out).toContain("## Optional（可跳过）");
    expect(out).toContain("## 查找指引（按问题找文档）");
    expect(out).toContain("## 机器可读资产（工具内部使用）");
    expect(out).toContain("- [tables/schemas.json](/tables/schemas.json): 全部配置表 schema（表名 / 字段 / 行数）");
    // meta/extract/* 噪音不逐条列出
    expect(out).not.toContain("meta/extract/concepts/00-项目总览与术语表.json");
    // 每个页面恰好出现一次
    for (const page of pages) {
      const occurrences = out.split(`[${page.title}]`).length - 1;
      expect(occurrences).toBe(1);
    }
  });

  it("emits no broken absolute links (all targets exist in the rendered doc)", () => {
    const out = renderDirectoryIndex({ releaseVersion: "v1", pages, assetUris: [] });
    const targets = [...out.matchAll(/\]\((\/[^)]+)\)/gu)].map((match) => match[1]);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      const file = target.replace(/^\//u, "");
      expect(pages.some((page) => page.okfPath === file)).toBe(true);
    }
  });
});
