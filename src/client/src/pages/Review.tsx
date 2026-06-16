import { useQuery } from "@tanstack/react-query";

import { listReviewTasks } from "../api";
import { Badge, ErrorState, Loading, Page } from "../components/Atoms";

export function Review() {
  const { data, isLoading, error } = useQuery({ queryKey: ["review", "blocking"], queryFn: () => listReviewTasks("blocking") });
  if (isLoading) return <Loading title="正在整理审核任务" />;
  if (error) return <ErrorState error={error} />;
  return (
    <Page title="审核中心" subtitle="把质量门禁结果翻译成可处理的维护任务。">
      <div className="task-list">
        {(data ?? []).map((task) => (
          <article className="task" key={task.taskId}>
            <Badge label={task.severity} tone="hot" />
            <div>
              <h3>{task.title}</h3>
              <p>{task.description}</p>
              <strong>{task.suggestedAction}</strong>
            </div>
          </article>
        ))}
      </div>
    </Page>
  );
}
