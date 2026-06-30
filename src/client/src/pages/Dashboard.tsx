import { ArrowRight, CircleDot, GitBranch, SearchCheck, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  getDashboard,
  listAgentEvents,
  listAnnotationExamples,
  listBuildRuns,
  listReleases,
  listReviewTasks,
  type AgentEvent,
  type AnnotationExample,
  type KnowledgeBuildRun,
  type ReleaseRecord,
  type ReviewTask
} from "../api";
import { Badge, ErrorState, Loading, Metric, Page } from "../components/Atoms";
import { useNav } from "../ui/navigation";
import type { NavParams, View } from "../ui/navigation";
import { componentLabel } from "../utils/componentLabel";
import { formatCounts, formatPercent, formatTime } from "../utils/format";

export function Dashboard() {
  const { navigate } = useNav();
  const dashboard = useQuery({ queryKey: ["dashboard"], queryFn: getDashboard });
  const reviewTasks = useQuery({ queryKey: ["review", "open", "workbench"], queryFn: () => listReviewTasks(undefined, "open") });
  const annotations = useQuery({ queryKey: ["annotation-examples", "workbench"], queryFn: listAnnotationExamples });
  const agentEvents = useQuery({ queryKey: ["agent-events", "workbench"], queryFn: listAgentEvents });
  const runs = useQuery({ queryKey: ["build-runs", "workbench"], queryFn: listBuildRuns });
  const releases = useQuery({ queryKey: ["releases", "workbench"], queryFn: listReleases });

  const isLoading = dashboard.isLoading || reviewTasks.isLoading || annotations.isLoading || agentEvents.isLoading || runs.isLoading || releases.isLoading;
  const error = dashboard.error ?? reviewTasks.error ?? annotations.error ?? agentEvents.error ?? runs.error ?? releases.error;
  const data = dashboard.data;
  const workbench = useMemo(() => createWorkbenchModel({
    tasks: reviewTasks.data ?? [],
    annotations: annotations.data ?? [],
    events: agentEvents.data ?? [],
    runs: runs.data ?? [],
    releases: releases.data ?? []
  }), [agentEvents.data, annotations.data, releases.data, reviewTasks.data, runs.data]);

  if (isLoading) return <Loading title="正在整理飞轮工作台" />;
  if (error || !data) return <ErrorState error={error} />;

  return (
    <Page title="飞轮工作台" subtitle="把 Agent 反馈、标注、重建、发布收敛成可直接处理的任务队列。">
      <section className={`flywheel-command ${workbench.state}`}>
        <div>
          <span className="command-kicker">当前主线</span>
          <h2>{workbench.headline}</h2>
          <p>{workbench.summary}</p>
        </div>
        <button className="primary-action" type="button" onClick={() => navigate(workbench.primary.view, workbench.primary.params)}>
          {workbench.primary.label}
          <ArrowRight size={16} />
        </button>
      </section>

      <div className="metrics workbench-metrics">
        <Metric label="待标注" value={workbench.annotationTasks.length} hint="AI 不确定，需要人选答案" tone={workbench.annotationTasks.length ? "warn" : "ok"} />
        <Metric label="待复测" value={workbench.retestItems.length} hint="来自 Agent 负反馈" tone={workbench.retestItems.length ? "warn" : "ok"} />
        <Metric label="待发布" value={workbench.publishItems.length} hint="draft / revision 可检查" tone={workbench.publishItems.length ? "warn" : "ok"} />
        <Metric label="风险知识" value={workbench.riskItems.length} hint="低可信或证据不足" tone={workbench.riskItems.length ? "hot" : "ok"} />
        <Metric label="证据覆盖" value={formatPercent(data.evidence.coverageRate)} hint={`${data.evidence.coveredComponents}/${data.evidence.totalComponents} 组件`} tone={data.evidence.missingComponents > 0 ? "warn" : "ok"} />
      </div>

      <section className="workbench-board">
        <WorkbenchLane
          title="1. 待标注"
          icon={CircleDot}
          empty="没有待标注任务。"
          caption="优先处理 AI 不确定、样例复盘和可沉淀为规则的问题。"
        >
          {workbench.annotationTasks.map((task) => (
            <TaskCard key={task.taskId} task={task} onOpen={() => navigate("review", { taskId: task.taskId })} />
          ))}
        </WorkbenchLane>

        <WorkbenchLane
          title="2. 待复测"
          icon={SearchCheck}
          empty="没有新的 Agent 反馈需要复测。"
          caption="沿用原查询复测，判断修改是否真的让 MCP 命中收敛。"
        >
          {workbench.retestItems.map((item) => (
            <AgentCard key={item.eventId} event={item} onRetest={() => navigate("agent", { query: item.query })} onReview={() => navigate("review", { taskId: item.taskId })} />
          ))}
        </WorkbenchLane>

        <WorkbenchLane
          title="3. 待发布"
          icon={GitBranch}
          empty="没有待发布版本。"
          caption="构建完成后，检查 draft / revision 是否可以推给 Agent。"
        >
          {workbench.publishItems.map((release) => (
            <ReleaseCard key={release.releaseId} release={release} onOpen={() => navigate("release", { releaseId: release.releaseId })} />
          ))}
        </WorkbenchLane>

        <WorkbenchLane
          title="4. 风险知识"
          icon={ShieldAlert}
          empty="暂无高风险知识。"
          caption="低可信、缺证据、负反馈复发会进入这里。"
        >
          {workbench.riskItems.map((item) => (
            <RiskCard key={item.key} item={item} onOpen={() => navigate(item.view, item.params)} />
          ))}
        </WorkbenchLane>
      </section>

      <section className="band workbench-health">
        <div>
          <h2>系统健康</h2>
          <p>工程健康指标仍保留，但不再抢占策划主工作流。</p>
        </div>
        <div className="health-grid">
          <span><b>资料版本</b><strong>{data.sources.versions}</strong><small>{data.sources.latest ? `最新 ${data.sources.latest.label}` : "尚未导入"}</small></span>
          <span><b>知识资产包</b><strong>{data.packages.total}</strong><small>{formatCounts(data.packages.byStatus)}</small></span>
          <span><b>待修问题</b><strong>{data.review.open}</strong><small>{data.review.blocking} 个阻断</small></span>
          <span><b>Agent 查询</b><strong>{data.agent.recentQueries}</strong><small>{data.agent.misses} 次未命中</small></span>
          <span><b>当前发布</b><strong>{data.release.current?.version ?? "未发布"}</strong><small>{data.release.current?.releaseId ?? "no published release"}</small></span>
        </div>
      </section>
    </Page>
  );
}

function WorkbenchLane({
  title,
  icon: Icon,
  caption,
  empty,
  children
}: {
  title: string;
  icon: typeof CircleDot;
  caption: string;
  empty: string;
  children: ReactNode;
}) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <section className="workbench-lane">
      <div className="lane-head">
        <Icon size={17} />
        <div>
          <h2>{title}</h2>
          <p>{caption}</p>
        </div>
      </div>
      <div className="lane-list">
        {hasChildren ? children : <p className="lane-empty">{empty}</p>}
      </div>
    </section>
  );
}

function TaskCard({ task, onOpen }: { task: ReviewTask; onOpen: () => void }) {
  return (
    <article className="workbench-card">
      <div className="card-row">
        <Badge label={task.ruleId === "annotation_example.review" ? "样例复盘" : task.taskKind === "annotation" ? "标注" : "审核"} tone={task.severity === "blocking" ? "hot" : task.severity === "warning" ? "warn" : undefined} />
        <span>{confidenceLabel(task.confidence)}</span>
      </div>
      <strong>{task.title}</strong>
      <p>{task.suggestedAction || task.description}</p>
      <code title={task.componentId}>{componentLabel(task.componentId)}</code>
      <button className="secondary-action" type="button" onClick={onOpen}>去处理</button>
    </article>
  );
}

function AgentCard({ event, onRetest, onReview }: { event: AgentEvent; onRetest: () => void; onReview: () => void }) {
  const component = event.components[0];
  return (
    <article className="workbench-card">
      <div className="card-row">
        <Badge label={agentFeedbackLabel(event.feedbackType)} tone={event.status === "miss" ? "hot" : "warn"} />
        <span>{formatTime(event.createdAt)}</span>
      </div>
      <strong>{event.query || "未解析查询"}</strong>
      <p>{event.suggestedAction || "复测该查询，确认命中与证据是否已收敛。"}</p>
      <code title={component?.componentId ?? event.hitComponentIds[0] ?? ""}>{componentLabel(component?.componentId ?? event.hitComponentIds[0] ?? "", component?.title)}</code>
      <div className="card-actions">
        {event.taskId && <button className="secondary-action" type="button" onClick={onReview}>看任务</button>}
        <button className="primary-action" type="button" onClick={onRetest}>复测</button>
      </div>
    </article>
  );
}

function ReleaseCard({ release, onOpen }: { release: ReleaseRecord; onOpen: () => void }) {
  return (
    <article className="workbench-card">
      <div className="card-row">
        <Badge label={release.parentReleaseId ? "revision" : "draft"} tone="warn" />
        <span>{formatTime(release.createdAt)}</span>
      </div>
      <strong>{release.version}</strong>
      <p>{release.note || "检查变更组件、Lint 和可信度后发布给 Agent。"}</p>
      <code>{release.releaseId}</code>
      <button className="secondary-action" type="button" onClick={onOpen}>去发布</button>
    </article>
  );
}

function RiskCard({ item, onOpen }: { item: RiskItem; onOpen: () => void }) {
  return (
    <article className="workbench-card risk">
      <div className="card-row">
        <Badge label={item.label} tone={item.tone} />
        <span>{item.meta}</span>
      </div>
      <strong>{item.title}</strong>
      <p>{item.body}</p>
      <code title={item.code}>{componentLabel(item.code)}</code>
      <button className="secondary-action" type="button" onClick={onOpen}>查看</button>
    </article>
  );
}

type NavTarget = { view: View; params?: NavParams };

interface RiskItem {
  key: string;
  label: string;
  tone: "hot" | "warn" | "ok" | undefined;
  title: string;
  body: string;
  code: string;
  meta: string;
  view: NavTarget["view"];
  params: NavTarget["params"];
}

function createWorkbenchModel(input: {
  tasks: ReviewTask[];
  annotations: AnnotationExample[];
  events: AgentEvent[];
  runs: KnowledgeBuildRun[];
  releases: ReleaseRecord[];
}) {
  const annotationTasks = input.tasks
    .filter((task) => task.taskKind === "annotation" || task.ruleId === "annotation_example.review")
    .slice(0, 4);
  const retestItems = input.events
    .filter((event) => event.feedbackType !== "hit" || event.status === "miss" || event.qualityFlags.length > 0)
    .slice(0, 4);
  const publishItems = input.releases
    .filter((release) => release.status === "draft")
    .slice(0, 4);
  const riskItems = buildRiskItems(input).slice(0, 4);
  const running = input.runs.filter((run) => run.status === "running");

  const primary = annotationTasks[0]
    ? { label: "处理首个标注", view: "review" as const, params: { taskId: annotationTasks[0].taskId } }
    : retestItems[0]
      ? { label: "复测最新反馈", view: "agent" as const, params: { query: retestItems[0].query } }
      : publishItems[0]
        ? { label: "检查待发布版本", view: "release" as const, params: { releaseId: publishItems[0].releaseId } }
        : running[0]
          ? { label: "查看构建进度", view: "builder" as const, params: { runId: running[0].runId } }
          : { label: "导入或构建知识", view: "builder" as const, params: {} };

  const headline = annotationTasks.length
    ? `先处理 ${annotationTasks.length} 个标注任务`
    : retestItems.length
      ? `先复测 ${retestItems.length} 条 Agent 反馈`
      : publishItems.length
        ? `有 ${publishItems.length} 个版本待发布`
        : running.length
          ? `有 ${running.length} 个构建正在运行`
          : "当前没有阻塞项";
  const summary = annotationTasks.length
    ? "这些任务最能把人的判断沉淀回规则和样例池，优先处理会让飞轮更快收敛。"
    : retestItems.length
      ? "反馈已经进入系统，下一步应该复测原查询，确认命中、证据和可信度是否改善。"
      : publishItems.length
        ? "构建结果已经形成草案或修订，检查无阻断后发布给 Agent 消费。"
        : running.length
          ? "等待构建完成后，系统会进入发布或复测环节。"
          : "可以从导入资料或启动构建开始；后续问题会自动进入这张工作台。";

  return {
    state: annotationTasks.length || retestItems.length || riskItems.length ? "attention" : publishItems.length ? "publish" : "clear",
    headline,
    summary,
    primary,
    annotationTasks,
    retestItems,
    publishItems,
    riskItems
  };
}

function buildRiskItems(input: {
  tasks: ReviewTask[];
  annotations: AnnotationExample[];
  events: AgentEvent[];
}): RiskItem[] {
  const blocking = input.tasks
    .filter((task) => task.severity === "blocking")
    .map((task): RiskItem => ({
      key: `task-${task.taskId}`,
      label: "阻断",
      tone: "hot",
      title: task.title,
      body: task.suggestedAction || task.description,
      code: task.componentId,
      meta: "审核中心",
      view: "review",
      params: { taskId: task.taskId }
    }));
  const recurring = input.annotations
    .filter((example) => example.effect.status === "needs_review")
    .map((example): RiskItem => ({
      key: `ann-${example.exampleId}`,
      label: "复发",
      tone: "warn",
      title: example.ruleId || "标注样例复盘",
      body: example.effect.summary,
      code: example.componentId,
      meta: `${example.effect.openTasksAfter} 待处理`,
      view: "legislation",
      params: {}
    }));
  const negativeFeedback = input.events
    .filter((event) => event.feedbackType !== "hit" && event.hitComponentIds.length > 0)
    .map((event): RiskItem => ({
      key: `event-${event.eventId}`,
      label: agentFeedbackLabel(event.feedbackType),
      tone: event.status === "miss" ? "hot" : "warn",
      title: event.query || "未解析查询",
      body: event.suggestedAction || "Agent 反馈显示该知识需要复核。",
      code: event.hitComponentIds[0],
      meta: "Agent 回流",
      view: "agent",
      params: { query: event.query }
    }));
  return [...blocking, ...recurring, ...negativeFeedback];
}

function confidenceLabel(confidence: number): string {
  if (!confidence) return "未评分";
  return `confidence ${Math.round(confidence * 100)}%`;
}

function agentFeedbackLabel(type: string): string {
  if (type === "miss") return "未命中";
  if (type === "low_quality_hit") return "低质命中";
  if (type === "evidence_insufficient") return "证据不足";
  if (type === "repeated_query") return "重复查询";
  if (type === "relation_inference_failed") return "关系失败";
  return type || "反馈";
}
