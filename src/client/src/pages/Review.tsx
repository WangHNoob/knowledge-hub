import { memo, useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { listReviewTasks, transitionReviewTasks, type ReviewTask } from "../api";
import { Badge, ErrorState, Loading, Metric, Page } from "../components/Atoms";
import { formatTime } from "../utils/format";
import { insightFromTask, type FeedbackInsight } from "../utils/feedback";
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

function taskCategory(task: ReviewTask): string {
  const text = `${task.title} ${task.description} ${task.suggestedAction}`.toLowerCase();
  if (/agent|miss|命中|反馈|mcp/.test(text)) return "Agent 回流";
  if (/evidence|citation|引用|证据|source/.test(text)) return "证据";
  if (/spec|frontmatter|字段|facts/.test(text)) return "结构";
  if (/graph|relation|关系|图谱/.test(text)) return "图谱";
  return "质量";
}

function resolutionLabel(insight: FeedbackInsight): string {
  if (insight.problem === "evidence") return "标记已补证据";
  if (insight.problem === "miss" || insight.problem === "repeated") return "标记已补资产";
  if (insight.problem === "quality") return "标记已修复质量";
  return "标记已处理";
}

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

  const tasks = useMemo(
    () => (data ?? []).filter((task) => !params.packageId || task.packageId === params.packageId),
    [data, params.packageId]
  );
  const taskStats = useMemo(() => {
    let open = 0;
    let blocking = 0;
    let warning = 0;
    let agent = 0;
    for (const task of tasks) {
      if (task.status !== "open") continue;
      open += 1;
      if (task.severity === "blocking") blocking += 1;
      if (task.severity === "warning") warning += 1;
      if (/agent|命中|反馈|miss|mcp/i.test(`${task.title} ${task.description} ${task.suggestedAction}`)) agent += 1;
    }
    return { open, blocking, warning, agent };
  }, [tasks]);
  const act = useCallback((task: ReviewTask, next: "open" | "resolved" | "dismissed") => {
    transition.mutate({ taskIds: [task.taskId], next, note: notes[task.taskId] });
  }, [notes, transition]);
  const bulk = useCallback((next: "resolved" | "dismissed") => {
    if (tasks.length === 0) return;
    if (window.confirm(`确认把当前列出的 ${tasks.length} 个任务全部标记为「${STATUS_LABEL[next]}」？`)) {
      transition.mutate({ taskIds: tasks.map((t) => t.taskId), next });
    }
  }, [tasks, transition]);

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

      <section className="review-flow">
        <div className="metrics compact">
          <Metric label="待处理" value={taskStats.open} hint="当前筛选范围" tone={taskStats.open ? "warn" : "ok"} />
          <Metric label="阻断" value={taskStats.blocking} hint="先处理，影响发布" tone={taskStats.blocking ? "hot" : "ok"} />
          <Metric label="可后置" value={taskStats.warning} hint="warning 可试发布后迭代" tone={taskStats.warning ? "warn" : "ok"} />
          <Metric label="Agent 回流" value={taskStats.agent} hint="由消费反馈生成" tone={taskStats.agent ? "warn" : "ok"} />
        </div>
        <div className="flow-cards">
          <button type="button" className="flow-card" onClick={() => navigate("assets", params.packageId ? { packageId: params.packageId } : {})}>
            <strong>1. 定位资产</strong>
            <span>从任务里的资产包 / 组件直接跳到资产详情，先看来源、质量与证据记录。</span>
          </button>
          <button type="button" className="flow-card" onClick={() => navigate("agent")}>
            <strong>2. 复测 Agent</strong>
            <span>修完后去 MCP 控制台跑同一个查询，看 hit、trace、quality flags 是否收敛。</span>
          </button>
        </div>
      </section>

      <div className="task-list">
        {tasks.map((task) => (
          <ReviewTaskCard
            key={task.taskId}
            task={task}
            note={notes[task.taskId] ?? ""}
            isPending={transition.isPending}
            onNote={(note) => setNotes((prev) => ({ ...prev, [task.taskId]: note }))}
            onTransition={(next) => act(task, next)}
            onNavigatePackage={() => navigate("assets", { packageId: task.packageId })}
            onNavigateAsset={(componentId) => navigate("assets", { packageId: task.packageId, componentId })}
            onRetest={(insight) => navigate("agent", { toolName: insight.toolName, query: insight.queryText })}
          />
        ))}
        {tasks.length === 0 && <p className="subtle">没有符合条件的审核任务。</p>}
      </div>
    </Page>
  );
}

const ReviewTaskCard = memo(function ReviewTaskCard({
  task,
  note,
  isPending,
  onNote,
  onTransition,
  onNavigatePackage,
  onNavigateAsset,
  onRetest,
}: {
  task: ReviewTask;
  note: string;
  isPending: boolean;
  onNote: (note: string) => void;
  onTransition: (next: "open" | "resolved" | "dismissed") => void;
  onNavigatePackage: () => void;
  onNavigateAsset: (componentId: string) => void;
  onRetest: (insight: FeedbackInsight) => void;
}) {
  const insight = insightFromTask(task);
  const componentIds = insight.componentIds.length ? insight.componentIds : task.componentId ? [task.componentId] : [];
  return (
    <article className="task actionable-task">
      <Badge label={task.severity} tone={SEVERITY_TONE[task.severity]} />
      <div>
        <div className="task-title-row">
          <h3>{insight.headline}</h3>
          <Badge label={taskCategory(task)} />
          <Badge label={STATUS_LABEL[task.status] ?? task.status} tone={task.status === "open" ? "warn" : "ok"} />
        </div>
        <div className="feedback-brief">
          <div>
            <span>触发查询</span>
            <strong>{insight.toolName}:{insight.queryText}</strong>
          </div>
          <div>
            <span>影响</span>
            <strong>{insight.impact}</strong>
          </div>
          <div>
            <span>下一步</span>
            <strong>{insight.nextStep}</strong>
          </div>
        </div>
        <details className="raw-feedback">
          <summary>查看原始反馈</summary>
          <p>{task.description}</p>
          <strong>{task.suggestedAction}</strong>
        </details>
        <div className="asset-link">
          <IdChip label={task.packageId} title="在知识资产中查看该资产包" onClick={onNavigatePackage} />
          {componentIds.map((componentId) => (
            <IdChip key={componentId} label={componentId} title="定位这个命中组件" onClick={() => onNavigateAsset(componentId)} />
          ))}
        </div>
        {task.status !== "open" && task.resolvedBy && (
          <small className="resolution-meta">
            由 {task.resolvedBy} 于 {formatTime(task.resolvedAt ?? "")} {STATUS_LABEL[task.status]}
            {task.resolutionNote ? `：${task.resolutionNote}` : ""}
          </small>
        )}
        {task.status === "open" ? (
          <div className="task-actions split-actions">
            <div className="task-primary-actions">
              {componentIds[0] && <button className="secondary-action" type="button" onClick={() => onNavigateAsset(componentIds[0])}>查看命中资产</button>}
              <button className="secondary-action" type="button" onClick={() => onRetest(insight)}>复测此查询</button>
              <button className="primary-action" type="button" disabled={isPending} onClick={() => onTransition("resolved")}>{resolutionLabel(insight)}</button>
              <button className="secondary-action" type="button" disabled={isPending} onClick={() => onTransition("dismissed")}>不影响本版</button>
            </div>
            <input
              className="task-note"
              placeholder="处理备注：补了哪个来源、为什么先放行..."
              value={note}
              onChange={(event) => onNote(event.target.value)}
            />
          </div>
        ) : (
          <div className="task-actions">
            <button className="secondary-action" type="button" disabled={isPending} onClick={() => onTransition("open")}>重新打开</button>
          </div>
        )}
      </div>
    </article>
  );
});
