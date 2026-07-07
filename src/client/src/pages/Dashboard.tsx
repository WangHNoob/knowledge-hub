import { ArrowRight, EyeOff, RefreshCw, RotateCcw, ShieldAlert, Sparkles, Square, Workflow } from "lucide-react";
import { useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  dismissException,
  getDashboard,
  getFlywheelStatus,
  listDismissedExceptions,
  restoreException,
  stopFlywheelBuilds,
  syncFlywheel,
  type DismissedException,
  type FlywheelAutomationItem,
  type FlywheelPrimaryAction,
  type FlywheelStatus,
  type FlywheelWorkbenchView,
  type HumanException,
} from "../api";
import { Badge, ErrorState, Loading, Metric, Page, TechRef } from "../components/Atoms";
import { useNav } from "../ui/navigation";
import type { NavParams, View } from "../ui/navigation";
import { useProject } from "../ui/projectContext";
import { formatCounts, formatPercent, formatTime } from "../utils/format";

const STATE_TONE: Record<FlywheelStatus["state"], "hot" | "warn" | "ok"> = {
  needs_attention: "hot",
  building: "warn",
  source_changed: "warn",
  ready_to_publish: "warn",
  published: "ok",
  idle: "ok",
};

export function Dashboard() {
  const { navigate } = useNav();
  const queryClient = useQueryClient();
  const { currentProjectId, currentProject } = useProject();
  const exceptionsRef = useRef<HTMLElement | null>(null);

  const dashboard = useQuery({ queryKey: ["dashboard", currentProjectId], queryFn: () => getDashboard(currentProjectId) });
  const statusQuery = useQuery({
    queryKey: ["flywheel", "status", currentProjectId],
    queryFn: () => getFlywheelStatus(currentProjectId),
    refetchInterval: 5000,
  });

  const syncMutation = useMutation({
    mutationFn: () => syncFlywheel(currentProjectId),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["flywheel", "status", currentProjectId] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard", currentProjectId] });
    },
  });

  const stopMutation = useMutation({
    mutationFn: () => stopFlywheelBuilds(currentProjectId),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["flywheel", "status", currentProjectId] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard", currentProjectId] });
    },
  });

  const dismissedQuery = useQuery({
    queryKey: ["flywheel", "dismissed", currentProjectId],
    queryFn: () => listDismissedExceptions(currentProjectId),
  });

  const invalidateExceptions = () => {
    void queryClient.invalidateQueries({ queryKey: ["flywheel", "status", currentProjectId] });
    void queryClient.invalidateQueries({ queryKey: ["flywheel", "dismissed", currentProjectId] });
  };

  const dismissMutation = useMutation({
    mutationFn: (input: { item: HumanException; reason: string }) =>
      dismissException(
        { key: input.item.id, exceptionType: input.item.type, title: input.item.title, reason: input.reason },
        currentProjectId,
      ),
    onSettled: invalidateExceptions,
  });

  const restoreMutation = useMutation({
    mutationFn: (key: string) => restoreException(key, currentProjectId),
    onSettled: invalidateExceptions,
  });

  const handleDismiss = (item: HumanException) => {
    const reason = window.prompt(`忽略「${item.title}」的原因（可选，仅用于留痕）：`, "");
    if (reason === null) return; // 用户取消
    dismissMutation.mutate({ item, reason: reason.trim() });
  };

  const status = statusQuery.data;

  const runPrimaryAction = useMemo(
    () => (action: FlywheelPrimaryAction) => {
      switch (action.action) {
        case "sync_and_publish":
          syncMutation.mutate();
          break;
        case "open_exceptions":
          exceptionsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
          break;
        case "open_sources":
          navigate("sources", action.params as NavParams | undefined);
          break;
        case "open_release":
          navigate("buildrelease", action.params as NavParams | undefined);
          break;
        case "retest_agent":
          navigate("agent", action.params as NavParams | undefined);
          break;
        default:
          break;
      }
    },
    [navigate, syncMutation],
  );

  if (statusQuery.isLoading || dashboard.isLoading) return <Loading title="正在整理知识运营台" />;
  if (statusQuery.error || !status) return <ErrorState error={statusQuery.error} />;

  const data = dashboard.data;
  const isSyncing = syncMutation.isPending || status.state === "building";

  return (
    <Page
      title="知识运营台"
      subtitle={`当前项目：${currentProject?.name ?? currentProjectId}。构建、治理、发布尽量自动完成，你只处理少量例外。`}
    >
      <section className={`flywheel-command ${STATE_TONE[status.state]}`}>
        <div>
          <span className="command-kicker">当前状态</span>
          <h2>{status.headline}</h2>
          <p>{status.summary}</p>
          {syncMutation.data?.message && (
            <p className="command-note">{syncMutation.data.message}</p>
          )}
          {syncMutation.error && (
            <p className="command-note error">
              {syncMutation.error instanceof Error ? syncMutation.error.message : "同步失败，请重试。"}
            </p>
          )}
          {stopMutation.data && (
            <p className="command-note">已请求停止 {stopMutation.data.stopped} 个构建；正在跑的会在当前文档/超时后退出。</p>
          )}
        </div>
        <div className="command-actions">
          <button
            className="primary-action"
            type="button"
            disabled={status.primaryAction.action === "sync_and_publish" && isSyncing}
            onClick={() => runPrimaryAction(status.primaryAction)}
          >
            {status.primaryAction.action === "sync_and_publish" && isSyncing ? "正在同步…" : status.primaryAction.label}
            {status.primaryAction.action === "sync_and_publish" ? <RefreshCw size={16} /> : <ArrowRight size={16} />}
          </button>
          {status.metrics.runningBuilds > 0 && (
            <button
              className="secondary-action danger"
              type="button"
              disabled={stopMutation.isPending}
              onClick={() => stopMutation.mutate()}
              title="停止该项目当前所有正在运行的构建"
            >
              <Square size={15} />
              {stopMutation.isPending ? "停止中…" : `停止构建（${status.metrics.runningBuilds}）`}
            </button>
          )}
        </div>
      </section>

      <div className="metrics workbench-metrics">
        <Metric label="待处理例外" value={status.metrics.pendingExceptions} hint="必须人工判断的问题" tone={status.metrics.pendingExceptions ? "hot" : "ok"} />
        <Metric label="资料待同步" value={status.metrics.sourceChanges} hint="最新资料尚未构建" tone={status.metrics.sourceChanges ? "warn" : "ok"} />
        <Metric label="构建进行中" value={status.metrics.runningBuilds} hint="自动流水线运行中" tone={status.metrics.runningBuilds ? "warn" : "ok"} />
        <Metric label="Agent 反馈" value={status.metrics.agentFeedbackOpen} hint="可复测的负反馈" tone={status.metrics.agentFeedbackOpen ? "warn" : "ok"} />
        <Metric label="今日自动治理" value={status.metrics.autoGovernedToday} hint={`Lint 自动 ${status.remediation.autoGoverned} / 人工 ${status.remediation.needsHuman}`} tone="ok" />
        <Metric label="当前发布" value={status.metrics.currentReleaseVersion || "未发布"} hint="Agent 正在消费的版本" tone={status.metrics.currentReleaseVersion ? "ok" : "warn"} />
      </div>

      <section className="workbench-board dual">
        <section className="workbench-lane" ref={exceptionsRef}>
          <div className="lane-head">
            <ShieldAlert size={17} />
            <div>
              <h2>需要你处理的例外</h2>
              <p>只列出系统无法自动处理的问题；正常情况下这里应接近为空。</p>
            </div>
          </div>
          <div className="lane-list">
            {status.attentionItems.length === 0 ? (
              <p className="lane-empty">没有需要人工处理的例外，飞轮在自动运转。</p>
            ) : (
              status.attentionItems.map((item) => (
                <ExceptionCard
                  key={item.id}
                  item={item}
                  onOpen={() => openException(navigate, item)}
                  onDismiss={() => handleDismiss(item)}
                  dismissing={dismissMutation.isPending}
                />
              ))
            )}
          </div>
          <DismissedExceptions
            items={dismissedQuery.data ?? []}
            onRestore={(key) => restoreMutation.mutate(key)}
            restoring={restoreMutation.isPending}
          />
        </section>

        <section className="workbench-lane">
          <div className="lane-head">
            <Sparkles size={17} />
            <div>
              <h2>最近自动化</h2>
              <p>系统最近自动完成或跳过的构建、治理与发布动作。</p>
            </div>
          </div>
          <div className="lane-list">
            {status.recentAutomation.length === 0 ? (
              <p className="lane-empty">还没有自动化记录。</p>
            ) : (
              status.recentAutomation.map((item) => <AutomationRow key={item.id} item={item} />)
            )}
          </div>
        </section>
      </section>

      {data && (
        <section className="band workbench-health">
          <div>
            <h2>系统健康</h2>
            <p>工程细节仍可追溯，但不再抢占主工作流。需要排障时从这里进入详情页。</p>
          </div>
          <div className="health-grid">
            <span><b>资料版本</b><strong>{data.sources.versions}</strong><small>{data.sources.latest ? `最新 ${data.sources.latest.label}` : "尚未导入"}</small></span>
            <span><b>知识资产包</b><strong>{data.packages.total}</strong><small>{formatCounts(data.packages.byStatus)}</small></span>
            <span><b>待修问题</b><strong>{data.review.open}</strong><small>{data.review.blocking} 个阻断</small></span>
            <span><b>证据覆盖</b><strong>{formatPercent(data.evidence.coverageRate)}</strong><small>{data.evidence.coveredComponents}/{data.evidence.totalComponents} 组件</small></span>
            <span><b>Agent 查询</b><strong>{data.agent.recentQueries}</strong><small>{data.agent.misses} 次未命中</small></span>
          </div>
        </section>
      )}
    </Page>
  );
}

function ExceptionCard({
  item,
  onOpen,
  onDismiss,
  dismissing,
}: {
  item: HumanException;
  onOpen: () => void;
  onDismiss: () => void;
  dismissing: boolean;
}) {
  return (
    <article className="workbench-card risk">
      <div className="card-row">
        <Badge label={attentionLevelLabel(item.attentionLevel)} tone={attentionTone(item.attentionLevel)} />
        <span>{formatTime(item.createdAt)}</span>
      </div>
      <strong>{item.title}</strong>
      <p>{item.body}</p>
      <p className="exception-why"><b>为何需要你：</b>{item.whyHumanNeeded}</p>
      <p className="exception-fix"><b>建议：</b>{item.recommendedAction}</p>
      <div className="card-row">
        <button className="secondary-action" type="button" onClick={onOpen}>{item.primaryAction.label}</button>
        <button className="ghost-action" type="button" onClick={onDismiss} disabled={dismissing} title="从收件箱隐藏，可在下方“已忽略”里恢复">
          <EyeOff size={14} />
          忽略
        </button>
        <ExceptionTechIds ids={item.technicalIds} />
      </div>
    </article>
  );
}

/**
 * 已忽略的例外：软忽略后从上方收件箱隐藏，但保留可审计痕迹，可随时恢复。
 * 恢复后若底层问题仍在，例外会重新出现在收件箱。
 */
function DismissedExceptions({
  items,
  onRestore,
  restoring,
}: {
  items: DismissedException[];
  onRestore: (key: string) => void;
  restoring: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <details className="dismissed-exceptions">
      <summary>已忽略（{items.length}）</summary>
      <div className="lane-list">
        {items.map((item) => (
          <article className="workbench-card muted" key={item.dismissalId}>
            <div className="card-row">
              <strong>{item.title || item.dedupKey}</strong>
              <span>{formatTime(item.dismissedAt)}</span>
            </div>
            <p className="exception-fix">
              <b>忽略人：</b>{item.dismissedBy || "—"}
              {item.reason ? <> · <b>原因：</b>{item.reason}</> : null}
            </p>
            <div className="card-row">
              <button className="ghost-action" type="button" onClick={() => onRestore(item.dedupKey)} disabled={restoring}>
                <RotateCcw size={14} />
                恢复
              </button>
            </div>
          </article>
        ))}
      </div>
    </details>
  );
}

/**
 * 阶段6：技术 ID 降噪。例外卡默认只显示业务信息，技术 ID 折叠进「排障 ID」详情，
 * 排障人员展开后可逐个复制，主列表不再出现撑破 UI 的长串。
 */
function ExceptionTechIds({ ids }: { ids?: HumanException["technicalIds"] }) {
  const entries = ids
    ? (Object.entries(ids).filter(([, value]) => Boolean(value)) as Array<[string, string]>)
    : [];
  if (entries.length === 0) return null;
  return (
    <details className="exception-tech-ids">
      <summary>排障 ID</summary>
      <div className="exception-tech-id-list">
        {entries.map(([key, value]) => (
          <TechRef key={key} kind={TECH_ID_LABELS[key] ?? key} title={TECH_ID_LABELS[key] ?? key} technicalId={value} />
        ))}
      </div>
    </details>
  );
}

const TECH_ID_LABELS: Record<string, string> = {
  componentId: "组件",
  packageId: "资产包",
  releaseId: "发布",
  taskId: "任务",
  eventId: "事件",
};

function AutomationRow({ item }: { item: FlywheelAutomationItem }) {
  return (
    <article className="workbench-card automation">
      <div className="card-row">
        <Badge label={automationStatusLabel(item.status)} tone={automationTone(item.status)} />
        <span>{formatTime(item.createdAt)}</span>
      </div>
      <strong>{item.title}</strong>
    </article>
  );
}

function openException(navigate: (view: View, params?: NavParams) => void, item: HumanException) {
  if (!item.target) return;
  navigate(mapPageToView(item.target.page), item.target.params as NavParams | undefined);
}

function mapPageToView(page: FlywheelWorkbenchView): View {
  switch (page) {
    case "release":
    case "builder":
      return "buildrelease";
    case "legislation":
    case "aliases":
      return "rules";
    case "review":
      return "review";
    case "agent":
      return "agent";
    case "sources":
      return "sources";
    case "assets":
      return "assets";
    case "storage":
    case "diagnostics":
    case "maintenance":
      return "system";
    case "dashboard":
    default:
      return "dashboard";
  }
}

function attentionLevelLabel(level: HumanException["attentionLevel"]): string {
  if (level === "blocking") return "阻断";
  if (level === "needs_decision") return "待决策";
  return "观察";
}

function attentionTone(level: HumanException["attentionLevel"]): "hot" | "warn" | undefined {
  if (level === "blocking") return "hot";
  if (level === "needs_decision") return "warn";
  return undefined;
}

function automationStatusLabel(status: FlywheelAutomationItem["status"]): string {
  if (status === "running") return "进行中";
  if (status === "completed") return "已完成";
  if (status === "skipped") return "已跳过";
  return "失败";
}

function automationTone(status: FlywheelAutomationItem["status"]): "hot" | "warn" | "ok" | undefined {
  if (status === "failed") return "hot";
  if (status === "skipped") return "warn";
  if (status === "completed") return "ok";
  return undefined;
}
