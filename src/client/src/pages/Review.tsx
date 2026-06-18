import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { listReviewTasks, transitionReviewTasks, type ReviewTask } from "../api";
import { Badge, ErrorState, Loading, Page } from "../components/Atoms";
import { formatTime } from "../utils/format";
import { IdChip, useNav } from "../ui/navigation";

const SEVERITY_OPTIONS = [
  { value: "", label: "全部级别" },
  { value: "blocking", label: "阻断" },
  { value: "warning", label: "警告" },
  { value: "info", label: "提示" }
];

const STATUS_OPTIONS = [
  { value: "open", label: "待处理" },
  { value: "resolved", label: "已解决" },
  { value: "dismissed", label: "已忽略" },
  { value: "", label: "全部状态" }
];

const SEVERITY_TONE: Record<string, "hot" | "warn" | undefined> = {
  blocking: "hot",
  warning: "warn",
  info: undefined
};

const STATUS_LABEL: Record<string, string> = { open: "待处理", resolved: "已解决", dismissed: "已忽略" };

export function Review() {
  const { navigate, params } = useNav();
  const queryClient = useQueryClient();
  const [severity, setSeverity] = useState("");
  const [status, setStatus] = useState("open");
  const [notes, setNotes] = useState<Record<string, string>>({});

  const { data, isLoading, error } = useQuery({
    queryKey: ["review", severity || "all", status || "all"],
    queryFn: () => listReviewTasks(severity || undefined, status || undefined)
  });

  const transition = useMutation({
    mutationFn: (input: { taskIds: string[]; next: "open" | "resolved" | "dismissed"; note?: string }) =>
      transitionReviewTasks(input.taskIds, input.next, input.note),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["review"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["packages"] }),
        queryClient.invalidateQueries({ queryKey: ["releases"] })
      ]);
    }
  });

  if (isLoading) return <Loading title="正在整理审核任务" />;
  if (error) return <ErrorState error={error} />;

  const tasks = (data ?? []).filter((task) => !params.packageId || task.packageId === params.packageId);
  const act = (task: ReviewTask, next: "open" | "resolved" | "dismissed") =>
    transition.mutate({ taskIds: [task.taskId], next, note: notes[task.taskId] });
  const bulk = (next: "resolved" | "dismissed") => {
    if (tasks.length === 0) return;
    if (window.confirm(`确认把当前列出的 ${tasks.length} 个任务全部标记为「${STATUS_LABEL[next]}」？`)) {
      transition.mutate({ taskIds: tasks.map((t) => t.taskId), next });
    }
  };

  return (
    <Page title="审核中心" subtitle="把质量门禁结果翻译成可处理的维护任务；解决 blocking 任务后即可解锁发布。">
      <div className="detail-head review-toolbar">
        <div>
          <h2>审核任务</h2>
          {params.packageId
            ? <p>已按资产包 <code>{params.packageId}</code> 过滤。</p>
            : <p>按级别与状态筛选门禁与反馈生成的任务。</p>}
        </div>
        <div className="review-controls">
          <select value={severity} onChange={(event) => setSeverity(event.target.value)}>
            {SEVERITY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            {STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          {status === "open" && tasks.length > 0 && (
            <>
              <button className="secondary-action" type="button" disabled={transition.isPending} onClick={() => bulk("resolved")}>全部解决</button>
              <button className="secondary-action" type="button" disabled={transition.isPending} onClick={() => bulk("dismissed")}>全部忽略</button>
            </>
          )}
        </div>
      </div>

      {transition.error && <p className="error">{transition.error instanceof Error ? transition.error.message : String(transition.error)}</p>}

      <div className="task-list">
        {tasks.map((task) => (
          <article className="task" key={task.taskId}>
            <Badge label={task.severity} tone={SEVERITY_TONE[task.severity]} />
            <div>
              <h3>{task.title}</h3>
              <p>{task.description}</p>
              <strong>{task.suggestedAction}</strong>
              <div className="asset-link">
                <Badge label={STATUS_LABEL[task.status] ?? task.status} tone={task.status === "open" ? "warn" : "ok"} />
                <IdChip label={task.packageId} title="在知识资产中查看该资产包" onClick={() => navigate("assets", { packageId: task.packageId })} />
                {task.componentId && (
                  <IdChip label={task.componentId} title="在知识资产中定位该组件" onClick={() => navigate("assets", { packageId: task.packageId, componentId: task.componentId })} />
                )}
              </div>
              {task.status !== "open" && task.resolvedBy && (
                <small className="resolution-meta">
                  由 {task.resolvedBy} 于 {formatTime(task.resolvedAt ?? "")} {STATUS_LABEL[task.status]}
                  {task.resolutionNote ? `：${task.resolutionNote}` : ""}
                </small>
              )}
              {task.status === "open" ? (
                <div className="task-actions">
                  <input
                    className="task-note"
                    placeholder="处理备注（可选）"
                    value={notes[task.taskId] ?? ""}
                    onChange={(event) => setNotes((prev) => ({ ...prev, [task.taskId]: event.target.value }))}
                  />
                  <button className="primary-action" type="button" disabled={transition.isPending} onClick={() => act(task, "resolved")}>解决</button>
                  <button className="secondary-action" type="button" disabled={transition.isPending} onClick={() => act(task, "dismissed")}>忽略</button>
                </div>
              ) : (
                <div className="task-actions">
                  <button className="secondary-action" type="button" disabled={transition.isPending} onClick={() => act(task, "open")}>重新打开</button>
                </div>
              )}
            </div>
          </article>
        ))}
        {tasks.length === 0 && <p className="subtle">没有符合条件的审核任务。</p>}
      </div>
    </Page>
  );
}
