import { ArrowRight, Square, Trash2 } from "lucide-react";

import type { KnowledgeBuildRun } from "../api";
import { runStatusLabel, formatTime } from "../utils/format";
import { Badge } from "./Atoms";

export function BuildRunCard({
  run,
  onStop,
  onDelete,
  onShowPackage,
  busy
}: {
  run: KnowledgeBuildRun;
  onStop: () => void;
  onDelete: () => void;
  onShowPackage: (packageId: string) => void;
  busy: boolean;
}) {
  const traceId = typeof run.config.traceId === "string" ? run.config.traceId : "";
  const completed = new Set(run.completedStages ?? []);
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
      {run.error && <p className="error">{run.error}</p>}
      <small>{formatTime(run.startedAt)}{run.finishedAt ? ` → ${formatTime(run.finishedAt)}` : ""}</small>
    </article>
  );
}
