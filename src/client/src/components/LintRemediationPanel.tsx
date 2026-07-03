import { Activity, AlertTriangle, CheckCircle2, Clock3, Hammer, RefreshCw } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { listFlywheelRemediations, retryFlywheelRemediation, type KnowledgeLintRemediation, type LintRemediationSummary } from "../api";
import { formatTime } from "../utils/format";
import { Badge, ErrorState, Loading } from "./Atoms";

type Tone = "hot" | "warn" | "ok" | undefined;

const STATUS_LABEL: Record<KnowledgeLintRemediation["status"], string> = {
  pending: "等待自动治理",
  running: "正在局部重建",
  completed: "已治理",
  failed: "治理失败",
  needs_human: "需要人工判断",
};

const ACTION_LABEL: Record<KnowledgeLintRemediation["actionType"], string> = {
  auto_remediation: "自动修复",
  rebuild: "建议重建",
  manual_review: "人工判断",
  monitor: "观察",
};

const DOMAIN_LABEL: Record<KnowledgeLintRemediation["domain"], string> = {
  links: "链接",
  evidence: "证据",
  graph: "图谱",
  trust: "可信度",
  table_dependencies: "表依赖",
  mcp_feedback: "MCP 反馈",
};

export function LintRemediationPanel({
  projectId,
  releaseId,
  title = "Knowledge Lint 自动治理",
  compact = false,
  onShowBuild,
}: {
  projectId?: string;
  releaseId?: string;
  title?: string;
  compact?: boolean;
  onShowBuild?: (runId: string) => void;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["flywheel", "remediations", projectId, releaseId ?? "latest"],
    queryFn: () => listFlywheelRemediations(projectId, releaseId),
    enabled: Boolean(projectId),
    refetchInterval: 3000,
  });
  const retry = useMutation({
    mutationFn: (remediationId: string) => {
      if (!projectId) throw new Error("缺少项目 ID，无法重试自动治理。");
      return retryFlywheelRemediation(projectId, remediationId);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["flywheel", "remediations"] }),
        queryClient.invalidateQueries({ queryKey: ["build-runs"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["review"] }),
      ]);
    },
  });

  if (query.isLoading) return <Loading title="正在读取自动治理链路" />;
  if (query.error) return <ErrorState error={query.error} />;

  const summary = query.data?.summary;
  const remediations = query.data?.remediations ?? [];
  const visible = compact ? remediations.slice(0, 5) : remediations;

  return (
    <section className={compact ? "lint-remediation-panel compact" : "lint-remediation-panel"}>
      <div className="detail-head">
        <div>
          <h2>{title}</h2>
          <p>{summaryLine(summary)}。系统会自动处理可定位组件的问题；无法安全定位的项会进入人工判断。</p>
        </div>
        <button className="icon-button" type="button" onClick={() => query.refetch()} title="刷新自动治理链路">
          <RefreshCw size={16} />
        </button>
      </div>

      {summary && (
        <div className="lint-remediation-summary">
          <span><strong>{summary.byStatus.running}</strong> 运行中</span>
          <span><strong>{summary.byStatus.pending}</strong> 等待</span>
          <span><strong>{summary.autoGoverned}</strong> 已治理</span>
          <span><strong>{summary.needsHuman}</strong> 人工判断</span>
          <span><strong>{summary.failed}</strong> 失败</span>
        </div>
      )}

      <div className="lint-remediation-list">
        {visible.length === 0 && <p className="subtle">暂无 Knowledge Lint 治理记录。发布后若有可治理项，会自动出现在这里。</p>}
        {visible.map((item) => (
          <RemediationRow
            key={item.remediationId}
            item={item}
            retrying={retry.isPending}
            onRetry={(remediationId) => retry.mutate(remediationId)}
            onShowBuild={onShowBuild}
          />
        ))}
      </div>
      {retry.error && <p className="error">{retry.error instanceof Error ? retry.error.message : String(retry.error)}</p>}
    </section>
  );
}

function RemediationRow({
  item,
  retrying,
  onRetry,
  onShowBuild,
}: {
  item: KnowledgeLintRemediation;
  retrying: boolean;
  onRetry: (remediationId: string) => void;
  onShowBuild?: (runId: string) => void;
}) {
  const statusTone = toneForStatus(item.status);
  const Icon = iconForStatus(item.status);
  const target = item.targetOkfPath || item.targetComponentId || item.issueId;
  return (
    <article className={`lint-remediation-row ${item.status}`}>
      <div className="lint-remediation-status">
        <Icon size={17} />
        <Badge label={STATUS_LABEL[item.status]} tone={statusTone} />
      </div>
      <div className="lint-remediation-main">
        <div className="lint-remediation-title">
          <strong>{item.title || item.issueId}</strong>
          <Badge label={DOMAIN_LABEL[item.domain]} />
          <Badge label={ACTION_LABEL[item.actionType]} tone={item.autoEligible ? "ok" : "warn"} />
          <Badge label={`${Math.round(item.confidence * 100)}%`} tone={item.confidence >= 0.85 ? "ok" : item.confidence >= 0.65 ? "warn" : "hot"} />
        </div>
        <p>{item.diagnosis || "未记录诊断"}</p>
        <small>{item.remediation || "未记录治理建议"}</small>
        <div className="lint-remediation-meta">
          <code title={target}>{target}</code>
          {item.runId && (
            <button className="link-button" type="button" onClick={() => onShowBuild?.(item.runId)} title={item.runId}>
              构建 {shortId(item.runId)}
            </button>
          )}
          {item.status === "failed" && item.targetComponentId && (
            <button className="secondary-action compact-action" type="button" disabled={retrying} onClick={() => onRetry(item.remediationId)}>
              重试自动治理
            </button>
          )}
          <span>{formatTime(item.createdAt)}</span>
        </div>
        {item.error && <em>{item.error}</em>}
      </div>
    </article>
  );
}

function summaryLine(summary?: LintRemediationSummary): string {
  if (!summary || summary.total === 0) return "当前发布暂无自动治理项";
  if (summary.pending > 0) return `${summary.pending} 项正在或等待自动治理`;
  if (summary.needsHuman > 0) return `${summary.needsHuman} 项需要人工确认`;
  if (summary.failed > 0) return `${summary.failed} 项自动治理失败`;
  return `${summary.autoGoverned} 项已由系统治理完成`;
}

function toneForStatus(status: KnowledgeLintRemediation["status"]): Tone {
  if (status === "completed") return "ok";
  if (status === "failed") return "hot";
  if (status === "running" || status === "pending" || status === "needs_human") return "warn";
  return undefined;
}

function iconForStatus(status: KnowledgeLintRemediation["status"]) {
  if (status === "completed") return CheckCircle2;
  if (status === "failed" || status === "needs_human") return AlertTriangle;
  if (status === "running") return Activity;
  if (status === "pending") return Clock3;
  return Hammer;
}

function shortId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 10)}...${value.slice(-5)}` : value;
}
