import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runExtractStage } from "../src/server/services/kbBuilder/extractStage";
import { loadWikiSpecs } from "../src/server/services/kbBuilder/specs";

describe("runExtractStage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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
      expect(meta.wiki_path).toBe("wiki/systems/battle.md");
      expect(meta.relationships[0].relation).toBe("configured_in");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("completes with a warning when parsed docs are missing", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-kb-extract-"));
    const specDir = join(dataDir, "processed", "wiki_specs");
    try {
      mkdirSync(specDir, { recursive: true });
      writeFileSync(join(specDir, "manifest.json"), JSON.stringify({
        page_types: { system: { dir: "systems", template: "system_rule.md" } },
        entity_types: ["system", "table", "concept"],
        relation_types: ["configured_in", "references"]
      }));
      writeFileSync(join(specDir, "system_rule.md"), "## Overview");

      const specs = loadWikiSpecs(specDir);
      const result = await runExtractStage({ dataDir, specs, model: "deterministic", force: false, only: null });

      expect(result.status).toBe("completed");
      expect(result.outputPaths).toEqual([]);
      expect(result.warnings.some((warning) => warning.includes("missing parsed docs"))).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps nested parsed files with the same basename from overwriting each other", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-kb-extract-"));
    const specDir = join(dataDir, "processed", "wiki_specs");
    try {
      mkdirSync(join(dataDir, "processed", "parsed", "systems"), { recursive: true });
      mkdirSync(join(dataDir, "processed", "parsed", "ui"), { recursive: true });
      mkdirSync(specDir, { recursive: true });
      writeFileSync(join(specDir, "manifest.json"), JSON.stringify({
        page_types: { system: { dir: "systems", template: "system_rule.md" } },
        entity_types: ["system", "table", "concept"],
        relation_types: ["configured_in", "references"]
      }));
      writeFileSync(join(specDir, "system_rule.md"), "## Overview");

      writeFileSync(join(dataDir, "processed", "parsed", "systems", "battle.md"), [
        "---",
        "type: system",
        "title: Battle Rules",
        "source: gamedocs/systems/battle.md",
        "---",
        "## Overview",
        "System battle."
      ].join("\n"));
      writeFileSync(join(dataDir, "processed", "parsed", "ui", "battle.md"), [
        "---",
        "type: system",
        "title: Battle UI",
        "source: gamedocs/ui/battle.md",
        "---",
        "## Overview",
        "UI battle."
      ].join("\n"));

      const specs = loadWikiSpecs(specDir);
      const result = await runExtractStage({ dataDir, specs, model: "deterministic", force: false, only: null });

      expect(result.outputPaths).toEqual([
        "wiki/_meta/systems-battle.json",
        "wiki/_meta/ui-battle.json",
        "wiki/systems/systems-battle.md",
        "wiki/systems/ui-battle.md"
      ]);
      const systemMeta = JSON.parse(readFileSync(join(dataDir, "wiki", "_meta", "systems-battle.json"), "utf8"));
      const uiMeta = JSON.parse(readFileSync(join(dataDir, "wiki", "_meta", "ui-battle.json"), "utf8"));
      expect(systemMeta.title).toBe("Battle Rules");
      expect(uiMeta.title).toBe("Battle UI");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("accepts fenced JSON returned by an extraction model", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-kb-extract-"));
    const specDir = join(dataDir, "processed", "wiki_specs");
    try {
      mkdirSync(join(dataDir, "processed", "parsed"), { recursive: true });
      mkdirSync(specDir, { recursive: true });
      writeFileSync(join(specDir, "manifest.json"), JSON.stringify({
        page_types: { system: { dir: "systems", template: "system_rule.md" } },
        entity_types: ["system"],
        relation_types: ["references"]
      }));
      writeFileSync(join(specDir, "system_rule.md"), "## 概览");
      writeFileSync(join(dataDir, "processed", "parsed", "battle.md"), "# Battle\n\nBattle rules.");
      vi.stubGlobal("fetch", async () => openAiChatOk(
        [
              "```json",
              "{",
              "  \"type\": \"system\",",
              "  \"title\": \"Battle System\",",
              "  \"source\": \"gamedocs/battle.md\",",
              "  \"facts\": {\"config_table\": \"Skill\"},",
              "  \"entities\": [{\"name\": \"Battle System\", \"type\": \"system\"}],",
              "  \"relationships\": [],",
              "  \"body\": \"## 概览\\nBattle rules.\"",
              "}",
              "```"
        ].join("\n"),
      ));

      const specs = loadWikiSpecs(specDir);
      const result = await runExtractStage({
        dataDir,
        specs,
        model: "gpt-test",
        modelConfig: { provider: "openai-compatible", baseUrl: "https://llm.local/v1", model: "gpt-test", apiKey: "secret" },
        force: false,
        only: null
      });

      expect(result.outputPaths.sort()).toEqual(["wiki/_meta/battle.json", "wiki/systems/battle.md"]);
      const meta = JSON.parse(readFileSync(join(dataDir, "wiki", "_meta", "battle.json"), "utf8"));
      expect(meta.title).toBe("Battle System");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("reuses cached model extraction for unchanged parsed markdown", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-kb-extract-"));
    const specDir = join(dataDir, "processed", "wiki_specs");
    try {
      mkdirSync(join(dataDir, "processed", "parsed"), { recursive: true });
      mkdirSync(specDir, { recursive: true });
      writeFileSync(join(specDir, "manifest.json"), JSON.stringify({
        page_types: { system: { dir: "systems", template: "system_rule.md" } },
        entity_types: ["system"],
        relation_types: ["references"]
      }));
      writeFileSync(join(specDir, "system_rule.md"), "## Overview");
      writeFileSync(join(dataDir, "processed", "parsed", "battle.md"), "# Battle\n\nBattle rules.");
      const specs = loadWikiSpecs(specDir);
      const modelConfig = { provider: "openai-compatible" as const, baseUrl: "https://llm.local/v1", model: "gpt-test", apiKey: "secret" };

      const fetchMock = vi.fn(async () => openAiChatOk(JSON.stringify({
        type: "system",
        title: "Battle System",
        source: "gamedocs/battle.md",
        facts: {},
        entities: [{ name: "Battle System", type: "system" }],
        relationships: [],
        body: "## Overview\nBattle rules from model."
      })));
      vi.stubGlobal("fetch", fetchMock);

      await runExtractStage({ dataDir, specs, model: "gpt-test", modelConfig, force: false, only: null });
      rmSync(join(dataDir, "wiki"), { recursive: true, force: true });
      fetchMock.mockRejectedValue(new Error("LLM should not be called on cache hit"));

      const result = await runExtractStage({ dataDir, specs, model: "gpt-test", modelConfig, force: false, only: null });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.outputPaths.sort()).toEqual(["wiki/_meta/battle.json", "wiki/systems/battle.md"]);
      expect(readFileSync(join(dataDir, "wiki", "systems", "battle.md"), "utf8")).toContain("Battle rules from model.");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("falls back with a warning when an extraction model returns markdown instead of JSON", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-kb-extract-"));
    const specDir = join(dataDir, "processed", "wiki_specs");
    try {
      mkdirSync(join(dataDir, "processed", "parsed"), { recursive: true });
      mkdirSync(specDir, { recursive: true });
      writeFileSync(join(specDir, "manifest.json"), JSON.stringify({
        page_types: { concept: { dir: "concepts", template: "concept.md" } },
        entity_types: ["concept"],
        relation_types: ["references"]
      }));
      writeFileSync(join(specDir, "concept.md"), "## 概览");
      writeFileSync(join(dataDir, "processed", "parsed", "pvp活动模板.md"), "# PVP活动模板\n\n活动规则说明。");
      vi.stubGlobal("fetch", async () => openAiChatOk("# PVP活动模板\n\n活动规则说明。"));

      const specs = loadWikiSpecs(specDir);
      const result = await runExtractStage({
        dataDir,
        specs,
        model: "gpt-test",
        modelConfig: { provider: "openai-compatible", baseUrl: "https://llm.local/v1", model: "gpt-test", apiKey: "secret" },
        force: false,
        only: null
      });

      expect(result.outputPaths.sort()).toEqual(["wiki/_meta/pvp活动模板.json", "wiki/concepts/pvp活动模板.md"]);
      expect(result.warnings.some((warning) =>
        warning.includes("pvp活动模板.md") && warning.includes("invalid JSON") && warning.includes("deterministic fallback"),
      )).toBe(true);
      const meta = JSON.parse(readFileSync(join(dataDir, "wiki", "_meta", "pvp活动模板.json"), "utf8"));
      expect(meta.title).toBe("PVP活动模板");
      expect(meta.type).toBe("concept");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("uses readable non-ASCII titles for generic and numeric parsed filenames", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-kb-extract-"));
    const specDir = join(dataDir, "processed", "wiki_specs");
    try {
      mkdirSync(join(dataDir, "processed", "parsed", "systems"), { recursive: true });
      mkdirSync(specDir, { recursive: true });
      writeFileSync(join(specDir, "manifest.json"), JSON.stringify({
        page_types: { system: { dir: "systems", template: "system_rule.md" } },
        entity_types: ["system"],
        relation_types: ["references"]
      }));
      writeFileSync(join(specDir, "system_rule.md"), "## 概览");
      writeFileSync(join(dataDir, "processed", "parsed", "page.md"), [
        "---",
        "type: system",
        "title: 白星系统",
        "source: gamedocs/page.md",
        "---",
        "## 概览",
        "白星系统说明。"
      ].join("\n"));
      writeFileSync(join(dataDir, "processed", "parsed", "11.md"), [
        "---",
        "type: system",
        "title: 七彩宝石11级",
        "source: gamedocs/11.md",
        "---",
        "## 概览",
        "七彩宝石说明。"
      ].join("\n"));
      writeFileSync(join(dataDir, "processed", "parsed", "systems", "page.md"), [
        "---",
        "type: system",
        "title: 白星系统",
        "source: gamedocs/systems/page.md",
        "---",
        "## 概览",
        "另一个白星系统说明。"
      ].join("\n"));

      const specs = loadWikiSpecs(specDir);
      const result = await runExtractStage({ dataDir, specs, model: "deterministic", force: false, only: null });

      expect(result.outputPaths).toEqual(expect.arrayContaining([
        "wiki/_meta/七彩宝石11级.json",
        "wiki/_meta/白星系统.json",
        "wiki/_meta/白星系统-2.json",
        "wiki/systems/七彩宝石11级.md",
        "wiki/systems/白星系统.md",
        "wiki/systems/白星系统-2.md"
      ]));
      expect(result.outputPaths).toHaveLength(6);
      expect(existsSync(join(dataDir, "wiki", "systems", "page.md"))).toBe(false);
      expect(existsSync(join(dataDir, "wiki", "systems", "11.md"))).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("normalizes translated config table aliases to canonical table names", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kh-kb-extract-"));
    const specDir = join(dataDir, "processed", "wiki_specs");
    try {
      mkdirSync(join(dataDir, "processed", "parsed"), { recursive: true });
      mkdirSync(specDir, { recursive: true });
      writeFileSync(join(dataDir, "table_aliases.json"), JSON.stringify([
        { table: "HomeLandDress", aliases: ["家园装扮表", "家园装扮"] }
      ]));
      writeFileSync(join(specDir, "manifest.json"), JSON.stringify({
        page_types: { system: { dir: "systems", template: "system_rule.md" } },
        entity_types: ["system", "config_table", "concept"],
        relation_types: ["configured_in", "references"]
      }));
      writeFileSync(join(specDir, "system_rule.md"), "## Overview\n## Data Dependencies\n| key | required |\n| --- | --- |\n| config_table | yes |");
      writeFileSync(join(dataDir, "processed", "parsed", "homeland.md"), [
        "---",
        "type: system",
        "title: 家园装扮",
        "source: gamedocs/homeland.md",
        "facts:",
        "  config_table: 家园装扮表",
        "entities:",
        "  - name: 家园装扮表",
        "    type: concept",
        "relationships:",
        "  - source: 家园装扮",
        "    relation: configured_in",
        "    target: 家园装扮表",
        "---",
        "## Overview",
        "家园装扮说明。",
        "",
        "## Data Dependencies",
        "使用家园装扮表。"
      ].join("\n"));

      const specs = loadWikiSpecs(specDir);
      await runExtractStage({ dataDir, specs, model: "deterministic", force: false, only: null });

      const meta = JSON.parse(readFileSync(join(dataDir, "wiki", "_meta", "homeland.json"), "utf8"));
      expect(meta.facts.config_table).toBe("HomeLandDress");
      expect(meta.entities).toContainEqual({ name: "HomeLandDress", type: "config_table" });
      expect(meta.relationships).toContainEqual({ source: "家园装扮", relation: "configured_in", target: "HomeLandDress" });
      const wiki = readFileSync(join(dataDir, "wiki", "systems", "homeland.md"), "utf8");
      expect(wiki).toContain("家园装扮表（HomeLandDress）");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

function openAiChatOk(content: string): Response {
  return new Response(JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model: "gpt-test",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200 });
}
