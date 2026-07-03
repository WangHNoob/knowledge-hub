import { Badge } from "./Atoms";
import { formatTime } from "../utils/format";
import type { ReviewWritebackSummary } from "../api";

/**
 * Shared 3-step deterministic writeback chain UI:
 *   annotation request → scoped build → release revision
 *
 * Replaces the duplicated WritebackStrip (Review.tsx) and
 * AnnotationWritebackTimeline (Legislation.tsx).
 */
export function WritebackSteps({
  writeback,
  onNavigateBuild,
  onNavigateRelease,
}: {
  writeback: ReviewWritebackSummary;
  onNavigateBuild?: (runId: string) => void;
  onNavigateRelease?: (releaseId: string) => void;
}) {
  const buildTone = writeback.runStatus === "completed" ? "ok" : writeback.runStatus === "failed" ? "hot" : "warn";
  const releaseTone = writeback.autoPublishStatus === "published"
    ? "ok"
    : writeback.autoPublishStatus === "skipped"
      ? "warn"
      : writeback.releaseStatus === "published"
        ? "ok"
        : undefined;
  const headLabel = writeback.autoPublishStatus === "published"
    ? "已自动发布"
    : writeback.releaseId
      ? "已有 revision"
      : writeback.runId
        ? "已启动构建"
        : "已请求";

  return (
    <div className="writeback-strip">
      <div className="writeback-head">
        <strong>确定性回写链路</strong>
        <Badge label={headLabel} tone={releaseTone} />
      </div>
      <div className="writeback-steps">
        <span className="writeback-step done">
          <b>标注</b>
          <strong>{formatTime(writeback.requestedAt)}</strong>
          {writeback.sourcePath && <small>{writeback.sourcePath}</small>}
        </span>
        <button
          type="button"
          className={`writeback-step ${writeback.runId ? "done" : ""}`}
          onClick={() => writeback.runId && onNavigateBuild?.(writeback.runId)}
          disabled={!writeback.runId}
        >
          <b>局部构建</b>
          <strong>{writeback.runId || "等待启动"}</strong>
          <small>{writeback.only || writeback.runStatus || "scoped"}</small>
          {writeback.runStatus && <Badge label={writeback.runStatus} tone={buildTone} />}
        </button>
        <button
          type="button"
          className={`writeback-step ${writeback.releaseId ? "done" : ""}`}
          onClick={() => writeback.releaseId && onNavigateRelease?.(writeback.releaseId)}
          disabled={!writeback.releaseId}
        >
          <b>发布修订</b>
          <strong>{writeback.releaseId || "等待构建完成"}</strong>
          <small>{writeback.releaseAt ? formatTime(writeback.releaseAt) : writeback.releaseStatus || "revision draft"}</small>
          {writeback.releaseStatus && <Badge label={writeback.releaseStatus} tone={releaseTone} />}
        </button>
      </div>
      {writeback.autoPublishStatus === "skipped" && writeback.autoPublishReason && (
        <p className="writeback-note">自动发布跳过：{writeback.autoPublishReason}</p>
      )}
    </div>
  );
}
