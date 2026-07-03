/**
 * Shared helpers for auto-publish event parsing and rendering.
 *
 * Previously duplicated in KnowledgeBuilder.tsx and Release.tsx.
 */

export function parseAutoPublishReasons(reason: string): string[] {
  const normalized = reason
    .replace(/^Auto publish is not eligible:\s*/u, "")
    .trim();
  if (!normalized) return [];
  return normalized
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export interface AutoPublishReasonDetailView {
  code: string;
  label: string;
  severity: "info" | "warning" | "blocking";
  description: string;
  action: string;
  count: number;
  sampleIds: string[];
}

export function parseAutoPublishReasonDetails(value: unknown, fallbackReasons: string[] = []): AutoPublishReasonDetailView[] {
  if (Array.isArray(value)) {
    const details = value.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const record = item as Record<string, unknown>;
      const code = stringValue(record.code);
      if (!code) return [];
      return [{
        code,
        label: stringValue(record.label) || autoPublishReasonLabel(code),
        severity: severityValue(record.severity),
        description: stringValue(record.description),
        action: stringValue(record.action) || autoPublishReasonAction(code),
        count: numberValue(record.count),
        sampleIds: Array.isArray(record.sampleIds) ? record.sampleIds.map(String).filter(Boolean).slice(0, 8) : [],
      }];
    });
    if (details.length > 0) return details;
  }
  return fallbackReasons.map((reason) => ({
    code: reason,
    label: autoPublishReasonLabel(reason),
    severity: reason === "no_component_changes" ? "info" : "blocking",
    description: "",
    action: autoPublishReasonAction(reason),
    count: 0,
    sampleIds: [],
  }));
}

export function autoPublishReasonLabel(reason: string): string {
  switch (reason) {
    case "changed_components_have_blocking_tasks":
      return "变更组件还有阻断审核";
    case "trust_score_declined_or_missing":
      return "可信度下降或缺失";
    case "removed_components_present":
      return "本次包含组件删除";
    case "missing_parent_release":
      return "缺少发布基线";
    case "no_component_changes":
      return "没有组件变更";
    case "has_pending_review_corrections":
      return "存在待复核源覆盖";
    default:
      return reason;
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function severityValue(value: unknown): AutoPublishReasonDetailView["severity"] {
  if (value === "info" || value === "warning" || value === "blocking") return value;
  return "warning";
}

export function autoPublishReasonAction(reason: string): string {
  switch (reason) {
    case "changed_components_have_blocking_tasks":
      return "先到审核中心完成阻断任务，再重新发布或等待下一次自动发布。";
    case "trust_score_declined_or_missing":
      return "检查变更资产的可信度明细，补证据或完成人工标注后再发布。";
    case "removed_components_present":
      return "删除知识会影响 Agent 消费，需要管理员手动确认发布。";
    case "missing_parent_release":
      return "先发布一个基线版本，后续 revision 才能自动比较差异。";
    case "no_component_changes":
      return "没有需要发布的变化，通常不需要处理。";
    case "has_pending_review_corrections":
      return "当前版本带着上一发布确认值继续发布；去策划立法的源覆盖层确认或退役对应修正。";
    default:
      return "查看关联构建 run、资产包和审核任务后决定是否手动发布。";
  }
}
