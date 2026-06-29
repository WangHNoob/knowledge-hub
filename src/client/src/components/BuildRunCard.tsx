import { AlertTriangle, ArrowRight, CheckCircle2, Clock3, Square, Trash2 } from "lucide-react";

import type { KnowledgeBuildRun } from "../api";
import { runStatusLabel, formatTime } from "../utils/format";
import { Badge } from "./Atoms";

export function BuildRunCard({
  run,
  releaseAutomation,
  onStop,
  onDelete,
  onShowPackage,
  onShowRelease,
  onShowReview,
  busy
}: {
  run: KnowledgeBuildRun;
  releaseAutomation?: BuildReleaseAutomation | null;
  onStop: () => void;
  onDelete: () => void;
  onShowPackage: (packageId: string) => void;
  onShowRelease: (releaseId?: string) => void;
  onShowReview: () => void;
  busy: boolean;
}) {
  const traceId = typeof run.config.traceId === "string" ? run.config.traceId : "";
  const completed = new Set(run.completedStages ?? []);
  const flywheel = parseFlywheelSummary(run.config.flywheel);
  const totalStages = run.stages.length || 1;
  const doneCount = run.stages.filter((stage) => completed.has(stage)).length;
  const progress = run.status === "completed"
    ? 1
    : run.status === "failed"
      ? doneCount / totalStages
      : Math.min(0.99, doneCount / totalStages);
  return (
    <article className={`run-card ${run.status}`}>
      <div className="detail-head">
        <div>
          <strong>{run.model}</strong>
          <span>{run.runId}</span>
        </div>
        <div className="run-actions">
          <Badge label={runStatusLabel(run.status)} tone={run.status === "failed" ? "hot" : run.status === "running" ? "warn" : "ok"} />
          {run.status === "running" && (
            <button className="icon-button" disabled={busy} onClick={onStop} title="停止运行">
              <Square size={15} />
            </button>
          )}
          {run.status !== "running" && (
            <button className="icon-button danger" disabled={busy} onClick={onDelete} title="删除运行记录">
              <Trash2 size={15} />
            </button>
          )}
        </div>
      </div>
      <div className="stage-progress">
        <div className="stage-progress-bar">
          <span style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        <div className="stage-row">
          {run.stages.map((stage) => {
            const status = completed.has(stage)
              ? "done"
              : run.currentStage === stage && run.status === "running"
                ? "current"
                : "pending";
            return <span key={stage} className={`stage-pill ${status}`}>{stage}</span>;
          })}
        </div>
      </div>
      <p>
        资料版本：<code>{run.sourceVersionId}</code>
      </p>
      {traceId && <p>Trace：<code>{traceId}</code></p>}
      {run.packageId && (
        <p className="run-package">
          资产包：<code>{run.packageId}</code>
          {run.status === "completed" && (
            <button className="link-button" onClick={() => onShowPackage(run.packageId!)}>
              <ArrowRight size={14} /> 查看
            </button>
          )}
        </p>
      )}
      {flywheel && (
        <>
          <div className="flywheel-summary">
            <span><strong>{flywheel.annotationExamplesInjected}</strong> 标注样例</span>
            <span><strong>{flywheel.activeRuleDismissals}</strong> 条豁免</span>
            <span><strong>{flywheel.appliedRuleDismissals}</strong> 次命中</span>
            <span><strong>{flywheel.newAnnotationTasks}</strong> 个新任务</span>
          </div>
          {flywheel.annotationExampleRefs.length > 0 && (
            <div className="flywheel-examples">
              {flywheel.annotationExampleRefs.slice(0, 3).map((example) => (
                <span key={example.exampleId || `${example.componentId}-${example.ruleId}`}>
                  <strong>{example.ruleId || "annotation"}</strong>
                  <code>{example.componentId || example.exampleId}</code>
                </span>
              ))}
              {flywheel.annotationExampleRefs.length > 3 && <small>+{flywheel.annotationExampleRefs.length - 3}</small>}
            </div>
          )}
        </>
      )}
      {run.status === "completed" && (
        <ReleaseAutomationStatus
          automation={releaseAutomation ?? null}
          onShowPackage={onShowPackage}
          onShowRelease={onShowRelease}
          onShowReview={onShowReview}
        />
      )}
      {run.error && <p className="error">{run.error}</p>}
      <small>{formatTime(run.startedAt)}{run.finishedAt ? ` → ${formatTime(run.finishedAt)}` : ""}</small>
    </article>
  );
}

function ReleaseAutomationStatus({
  automation,
  onShowPackage,
  onShowRelease,
  onShowReview,
}: {
  automation: BuildReleaseAutomation | null;
  onShowPackage: (packageId: string) => void;
  onShowRelease: (releaseId?: string) => void;
  onShowReview: () => void;
}) {
  if (!automation) {
    return (
      <div className="build-release-status none">
        <Clock3 size={15} />
        <div>
          <strong>未记录自动发布</strong>
          <span>可能是旧构建、手动流程，或自动发布事件尚未写入。</span>
        </div>
      </div>
    );
  }
  const succeeded = automation.status === "succeeded";
  return (
    <div className={`build-release-status ${automation.status}`}>
      {succeeded ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
      <div>
        <strong>{succeeded ? "构建后已自动发布" : "构建后自动发布跳过"}</strong>
        <span>
          {automation.releaseId || "未关联发布草案"}
          {automation.createdAt ? ` · ${formatTime(automation.createdAt)}` : ""}
        </span>
        {!succeeded && automation.reasons.length > 0 && (
          <ul>
            {automation.reasons.map((reason) => <li key={reason}>{releaseReasonLabel(reason)}</li>)}
          </ul>
        )}
        <div className="build-release-actions">
          {!succeeded && automation.reasons.some(needsReviewAction) && (
            <button className="secondary-action" type="button" onClick={onShowReview}>处理审核任务</button>
          )}
          <button className="secondary-action" type="button" onClick={() => onShowRelease(automation.releaseId || undefined)}>查看发布状态</button>
          {automation.packageId && (
            <button className="secondary-action" type="button" onClick={() => onShowPackage(automation.packageId)}>查看资产包</button>
          )}
        </div>
      </div>
    </div>
  );
}

function needsReviewAction(reason: string): boolean {
  return reason === "changed_components_have_blocking_tasks" || reason === "trust_score_declined_or_missing" || reason === "unknown";
}

function releaseReasonLabel(reason: string): string {
  switch (reason) {
    case "changed_components_have_blocking_tasks":
      return "变更组件还有阻断审核";
    case "trust_score_declined_or_missing":
      return "可信度下降或缺失";
    case "removed_components_present":
      return "本次包含组件删除，需要人工确认";
    case "missing_parent_release":
      return "缺少发布基线";
    case "no_component_changes":
      return "没有组件变更";
    case "unknown":
      return "未记录具体原因";
    default:
      return reason;
  }
}

function parseFlywheelSummary(value: unknown): {
  annotationExamplesInjected: number;
  annotationExampleRefs: Array<{ exampleId: string; componentId: string; ruleId: string }>;
  activeRuleDismissals: number;
  appliedRuleDismissals: number;
  newAnnotationTasks: number;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  return {
    annotationExamplesInjected: numberValue(data.annotationExamplesInjected),
    annotationExampleRefs: exampleRefs(data.annotationExampleRefs),
    activeRuleDismissals: numberValue(data.activeRuleDismissals),
    appliedRuleDismissals: numberValue(data.appliedRuleDismissals),
    newAnnotationTasks: numberValue(data.newAnnotationTasks),
  };
}

export interface BuildReleaseAutomation {
  status: "succeeded" | "skipped";
  releaseId: string;
  packageId: string;
  reasons: string[];
  createdAt: string;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function exampleRefs(value: unknown): Array<{ exampleId: string; componentId: string; ruleId: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const data = item as Record<string, unknown>;
    return [{
      exampleId: typeof data.exampleId === "string" ? data.exampleId : "",
      componentId: typeof data.componentId === "string" ? data.componentId : "",
      ruleId: typeof data.ruleId === "string" ? data.ruleId : "",
    }];
  });
}
