import type { SourceFileChange } from "../api";

export function formatCounts(counts: Record<string, number>): string {
  return Object.entries(counts).map(([key, value]) => `${key} ${value}`).join(" / ") || "暂无";
}

export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

export function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {
  return items.reduce<Record<string, T[]>>((acc, item) => {
    const value = key(item);
    acc[value] = acc[value] ?? [];
    acc[value].push(item);
    return acc;
  }, {});
}

export function groupLabel(group: string): string {
  return ({
    wiki: "Wiki 页面",
    index: "目录索引",
    graph: "知识图谱",
    table: "表结构",
    evidence: "证据资产",
    quality: "质量资产"
  } as Record<string, string>)[group] ?? group;
}

export function kindLabel(kind: SourceFileChange["kind"]): string {
  if (kind === "added") return "新增";
  if (kind === "modified") return "修改";
  return "删除";
}

export function runStatusLabel(status: string): string {
  if (status === "running") return "运行中";
  if (status === "completed") return "已完成";
  if (status === "failed") return "失败";
  return status;
}

export function qualityScore(summary: Record<string, unknown>): string {
  const value = summary.overallScore ?? summary.score ?? summary.confidence;
  if (typeof value === "number") return `${Math.round(value * 100)}%`;
  if (typeof value === "string" && value.trim()) return value;
  return "n/a";
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function releaseVersion(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, ".") + ".001";
}
