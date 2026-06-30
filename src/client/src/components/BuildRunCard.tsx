import { AlertTriangle, ArrowRight, CheckCircle2, Clock3, Square, Trash2 } from "lucide-react";

import type { BuildRunWritebackTrace, KnowledgeBuildRun } from "../api";
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
  onShowRelease: (releaseId?: string, eventId?: string) => void;
  onShowReview: (taskId?: string, packageId?: string) => void;
  busy: boolean;
}) {
  const traceId = typeof run.config.traceId === "string" ? run.config.traceId : "";
  const completed = new Set(run.completedStages ?? []);
  const flywheel = parseFlywheelSummary(run.config.flywheel);
  const writebackTraces = run.writebackTraces ?? [];
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
      {writebackTraces.length > 0 && (
        <div className="writeback-strip build-writeback-trace">
          <div className="writeback-head">
            <strong>复盘回写触发</strong>
            <Badge label={`${writebackTraces.length} 条链路`} tone="warn" />
          </div>
          <div className="build-writeback-list">
            {writebackTraces.map((trace) => (
              <BuildWritebackTraceRow
                key={`${trace.taskId}-${trace.runId}`}
                trace={trace}
                onShowReview={onShowReview}
                onShowRelease={onShowRelease}
              />
            ))}
          </div>
        </div>
      )}
      {flywheel && (
        <>
          <div className="flywheel-summary">
            <span><strong>{flywheel.annotationExamplesInjected}</strong> 标注样例</span>
            <span><strong>{flywheel.annotationOverridesInjected}</strong> 覆盖规则</span>
            <span><strong>{flywheel.activeRuleDismissals}</strong> 条豁免</span>
            <span><strong>{flywheel.appliedRuleDismissals}</strong> 次命中</span>
            <span><strong>{flywheel.newAnnotationTasks}</strong> 个新任务</span>
          </div>
          {flywheel.annotationExampleRefs.length > 0 && (
            <div className="flywheel-explain">
              <div className="flywheel-explain-head">
                <strong>标注样例命中解释</strong>
                <small>本次构建注入了这些人工标注；override 会在 extract 阶段确定性覆盖对应 wiki。</small>
              </div>
              <div className="flywheel-examples">
                {flywheel.annotationExampleRefs.map((example) => (
                  <article key={example.exampleId || `${example.componentId}-${example.ruleId}`} className={example.applyMode === "override" ? "override" : ""}>
                    <div>
                      <Badge label={example.applyMode} tone={example.applyMode === "override" ? "warn" : undefined} />
                      <strong>{example.ruleId || "annotation"}</strong>
                    </div>
                    <code title={example.sourcePath || example.componentRef || example.componentId || example.exampleId}>
                      {example.sourcePath || example.componentRef || example.componentId || example.exampleId}
                    </code>
                    <span>{example.influence || (example.applyMode === "override" ? "确定性覆盖" : "提示样例")}</span>
                    {example.valuePreview && <small title={example.valuePreview}>{example.valuePreview}</small>}
                    <em>{example.createdBy || "unknown"}{example.createdAt ? ` · ${formatTime(example.createdAt)}` : ""}</em>
                  </article>
                ))}
              </div>
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

function BuildWritebackTraceRow({
  trace,
  onShowReview,
  onShowRelease,
}: {
  trace: BuildRunWritebackTrace;
  onShowReview: (taskId?: string, packageId?: string) => void;
  onShowRelease: (releaseId?: string, eventId?: string) => void;
}) {
  const published = trace.autoPublishStatus === "published" || trace.releaseStatus === "published";
  const skipped = trace.autoPublishStatus === "skipped";
  return (
    <article className="build-writeback-row">
      <div>
        <Badge label={trace.taskRuleId || "annotation"} tone={trace.taskSeverity === "blocking" ? "hot" : trace.taskSeverity === "warning" ? "warn" : undefined} />
        <strong>{trace.taskTitle || trace.taskId}</strong>
        <code>{trace.componentId || trace.sourcePath || trace.exampleId}</code>
      </div>
      <div className="build-writeback-row-actions">
        <button className="secondary-action" type="button" onClick={() => onShowReview(trace.taskId, trace.packageId)}>查看复盘</button>
        {trace.releaseId && (
          <button className="secondary-action" type="button" onClick={() => onShowRelease(trace.releaseId)}>查看发布</button>
        )}
        <Badge
          label={published ? "已发布" : skipped ? "发布跳过" : trace.releaseId ? "revision" : trace.runStatus || "构建中"}
          tone={published ? "ok" : skipped ? "warn" : undefined}
        />
      </div>
      {skipped && trace.autoPublishReason && <small>自动发布跳过：{trace.autoPublishReason}</small>}
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
  onShowRelease: (releaseId?: string, eventId?: string) => void;
  onShowReview: (taskId?: string, packageId?: string) => void;
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
            <button className="secondary-action" type="button" onClick={() => onShowReview(automation.reviewTaskIds[0], automation.packageId)}>处理审核任务</button>
          )}
          <button className="secondary-action" type="button" onClick={() => onShowRelease(automation.releaseId || undefined, automation.eventId)}>查看发布事件</button>
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
  annotationOverridesInjected: number;
  annotationExampleRefs: AnnotationExampleRef[];
  activeRuleDismissals: number;
  appliedRuleDismissals: number;
  newAnnotationTasks: number;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  return {
    annotationExamplesInjected: numberValue(data.annotationExamplesInjected),
    annotationOverridesInjected: numberValue(data.annotationOverridesInjected),
    annotationExampleRefs: exampleRefs(data.annotationExampleRefs),
    activeRuleDismissals: numberValue(data.activeRuleDismissals),
    appliedRuleDismissals: numberValue(data.appliedRuleDismissals),
    newAnnotationTasks: numberValue(data.newAnnotationTasks),
  };
}

export interface BuildReleaseAutomation {
  eventId: string;
  status: "succeeded" | "skipped";
  releaseId: string;
  packageId: string;
  reviewTaskIds: string[];
  reasons: string[];
  createdAt: string;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

interface AnnotationExampleRef {
  exampleId: string;
  componentId: string;
  taskId: string;
  ruleId: string;
  applyMode: "hint" | "override";
  pageType: string;
  createdBy: string;
  createdAt: string;
  sourcePath: string;
  componentRef: string;
  valuePreview: string;
  influence: string;
}

function exampleRefs(value: unknown): AnnotationExampleRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const data = item as Record<string, unknown>;
    return [{
      exampleId: typeof data.exampleId === "string" ? data.exampleId : "",
      componentId: typeof data.componentId === "string" ? data.componentId : "",
      taskId: typeof data.taskId === "string" ? data.taskId : "",
      ruleId: typeof data.ruleId === "string" ? data.ruleId : "",
      applyMode: data.applyMode === "override" ? "override" : "hint",
      pageType: typeof data.pageType === "string" ? data.pageType : "",
      createdBy: typeof data.createdBy === "string" ? data.createdBy : "",
      createdAt: typeof data.createdAt === "string" ? data.createdAt : "",
      sourcePath: typeof data.sourcePath === "string" ? data.sourcePath : "",
      componentRef: typeof data.componentRef === "string" ? data.componentRef : "",
      valuePreview: typeof data.valuePreview === "string" ? data.valuePreview : "",
      influence: typeof data.influence === "string" ? data.influence : "",
    }];
  });
}
