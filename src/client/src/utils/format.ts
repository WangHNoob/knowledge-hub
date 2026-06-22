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

/** 全站时间统一按东八区（Asia/Shanghai）展示，不随浏览器/服务器时区漂移。 */
const SHANGHAI_TZ = "Asia/Shanghai";

function shanghaiParts(value: string, options: Intl.DateTimeFormatOptions): Record<string, string> | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("zh-CN", { timeZone: SHANGHAI_TZ, hourCycle: "h23", ...options }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

/** YYYY-MM-DD HH:mm（东八区）。无法解析时原样返回。 */
export function formatTime(value: string): string {
  const p = shanghaiParts(value, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  if (!p) return value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** HH:mm:ss（东八区），用于日志等只需要时分秒的场景。 */
export function formatClock(value: string): string {
  const p = shanghaiParts(value, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (!p) return value;
  return `${p.hour}:${p.minute}:${p.second}`;
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
