import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { listReviewTasks } from "../api";
import { Badge, ErrorState, Loading, Page } from "../components/Atoms";
import { IdChip, useNav } from "../ui/navigation";

const SEVERITY_OPTIONS = [
  { value: "", label: "全部" },
  { value: "blocking", label: "阻断" },
  { value: "warning", label: "警告" },
  { value: "info", label: "提示" }
];

const SEVERITY_TONE: Record<string, "hot" | "warn" | undefined> = {
  blocking: "hot",
  warning: "warn",
  info: undefined
};

export function Review() {
  const { navigate, params } = useNav();
  const [severity, setSeverity] = useState("");
  const { data, isLoading, error } = useQuery({
    queryKey: ["review", severity || "all"],
    queryFn: () => listReviewTasks(severity || undefined)
  });
  if (isLoading) return <Loading title="正在整理审核任务" />;
  if (error) return <ErrorState error={error} />;

  const tasks = (data ?? []).filter((task) => !params.packageId || task.packageId === params.packageId);

  return (
    <Page title="审核中心" subtitle="把质量门禁结果翻译成可处理的维护任务。">
      <div className="detail-head">
        <div>
          <h2>审核任务</h2>
          {params.packageId
            ? <p>已按资产包 <code>{params.packageId}</code> 过滤。</p>
            : <p>按严重级别筛选门禁与反馈生成的任务。</p>}
        </div>
        <select value={severity} onChange={(event) => setSeverity(event.target.value)}>
          {SEVERITY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </div>
      <div className="task-list">
        {tasks.map((task) => (
          <article className="task" key={task.taskId}>
            <Badge label={task.severity} tone={SEVERITY_TONE[task.severity]} />
            <div>
              <h3>{task.title}</h3>
              <p>{task.description}</p>
              <strong>{task.suggestedAction}</strong>
              <div className="asset-link">
                <IdChip label={task.packageId} title="在知识资产中查看该资产包" onClick={() => navigate("assets", { packageId: task.packageId })} />
                {task.componentId && (
                  <IdChip label={task.componentId} title="在知识资产中定位该组件" onClick={() => navigate("assets", { packageId: task.packageId, componentId: task.componentId })} />
                )}
              </div>
            </div>
          </article>
        ))}
        {tasks.length === 0 && <p className="subtle">没有符合条件的审核任务。</p>}
      </div>
    </Page>
  );
}
