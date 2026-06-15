import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StageResult } from "./types";

export async function runVizStage(options: { dataDir: string }): Promise<StageResult> {
  const graph = readFileSync(join(options.dataDir, "wiki", "graph.json"), "utf8");
  const html = [
    "<!doctype html>",
    "<html>",
    "<head><meta charset=\"utf-8\"><title>Knowledge Graph</title></head>",
    "<body>",
    "<h1>Knowledge Graph</h1>",
    `<script type="application/json" id="graph">${graph.replace(/</g, "\\u003c")}</script>`,
    "</body>",
    "</html>",
  ].join("");
  writeFileSync(join(options.dataDir, "wiki", "graph.html"), html);
  return { stage: "viz", status: "completed", outputPaths: ["wiki/graph.html"], warnings: [] };
}
