import { AlertTriangle, CheckCircle2, FileText, GitBranch, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import {
  createRelease,
  deleteRelease,
  getCurrentRelease,
  listFlywheelEvents,
  listPackages,
  listReleases,
  listReviewTasks,
  publishRelease,
  rollbackRelease,
  updateRelease,
  type FlywheelEvent,
  type KnowledgeLintSummary,
  type ReleaseAuditSummary,
  type ReleaseRecord
} from "../api";
import { Badge, ErrorState, Loading, Metric, Page, Tabs } from "../components/Atoms";
import { InlineEditor } from "../components/InlineEditor";
import { errorMessage, formatTime, qualityScore, releaseVersion } from "../utils/format";
import { componentLabel } from "../utils/componentLabel";
import { IdChip, useNav } from "../ui/navigation";

type ReleaseTab = "compose" | "current";

export function Release() {
  const { navigate, params } = useNav();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<ReleaseTab>("compose");
  const [selectedPackageIds, setSelectedPackageIds] = useState<string[]>([]);
  const [version, setVersion] = useState(() => releaseVersion());
  const packages = useQuery({ queryKey: ["packages"], queryFn: () => listPackages() });
  const tasks = useQuery({ queryKey: ["review", "blocking"], queryFn: () => listReviewTasks("blocking") });
  const releases = useQuery({ queryKey: ["releases"], queryFn: listReleases });
  const current = useQuery({ queryKey: ["releases", "current"], queryFn: getCurrentRelease });
  const flywheelEvents = useQuery({ queryKey: ["agent", "flywheel-events"], queryFn: listFlywheelEvents, refetchInterval: 5000 });
  const [draft, setDraft] = useState<ReleaseRecord | null>(null);

  useEffect(() => {
    if (params.releaseId || params.eventId) setTab("current");
  }, [params.eventId, params.releaseId]);

  const selectedPackageIdSet = useMemo(() => new Set(selectedPackageIds), [selectedPackageIds]);
  const blockersByPackage = useMemo(() => {
    const byPackage = new Map<string, NonNullable<typeof tasks.data>>();
    for (const task of tasks.data ?? []) {
      if (task.status !== "open" || task.severity !== "blocking") continue;
      const bucket = byPackage.get(task.packageId) ?? [];
      bucket.push(task);
      byPackage.set(task.packageId, bucket);
    }
    return byPackage;
  }, [tasks.data]);
  const blockers = useMemo(
    () => [...blockersByPackage.entries()]
      .filter(([packageId]) => selectedPackageIdSet.has(packageId))
      .flatMap(([, packageTasks]) => packageTasks ?? []),
    [blockersByPackage, selectedPackageIdSet]
  );
  const selectedPackages = useMemo(
    () => (packages.data ?? []).filter((pkg) => selectedPackageIdSet.has(pkg.packageId)),
    [packages.data, selectedPackageIdSet]
  );
  const selectedComponents = useMemo(
    () => selectedPackages.reduce((sum, pkg) => sum + Number(pkg.qualitySummary.componentCount ?? 0), 0),
    [selectedPackages]
  );
  const autoPublishEvents = useMemo(
    () => buildAutoPublishEvents(flywheelEvents.data ?? [], releases.data ?? []),
    [flywheelEvents.data, releases.data]
  );
  const createMutation = useMutation({
    mutationFn: () => createRelease(version.trim(), selectedPackageIds, current.data?.releaseId ?? null),
    onSuccess: async (release) => {
      setDraft(release);
      await queryClient.invalidateQueries({ queryKey: ["releases"] });
    }
  });
  const publishMutation = useMutation({
    mutationFn: async (input: { autoMode?: boolean } = {}) => publishRelease(draft?.releaseId ?? "", input),
    onSuccess: async () => {
      setDraft(null);
      setVersion(releaseVersion());
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["releases"] }),
        queryClient.invalidateQueries({ queryKey: ["releases", "current"] }),
        queryClient.invalidateQueries({ queryKey: ["agent", "flywheel-events"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] })
      ]);
    }
  });
  const rollbackMutation = useMutation({
    mutationFn: rollbackRelease,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["releases"] }),
        queryClient.invalidateQueries({ queryKey: ["releases", "current"] }),
        queryClient.invalidateQueries({ queryKey: ["agent", "flywheel-events"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] })
      ]);
    }
  });
  const renameMutation = useMutation({
    mutationFn: ({ releaseId, patch }: { releaseId: string; patch: { version?: string; note?: string } }) =>
      updateRelease(releaseId, patch),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["releases"] }),
        queryClient.invalidateQueries({ queryKey: ["releases", "current"] })
      ]);
    }
  });
  const deleteMutation = useMutation({
    mutationFn: deleteRelease,
    onSuccess: async (_release, releaseId) => {
      if (draft?.releaseId === releaseId) setDraft(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["releases"] }),
        queryClient.invalidateQueries({ queryKey: ["releases", "current"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["storage"] })
      ]);
    }
  });

  if (packages.isLoading || releases.isLoading || current.isLoading || tasks.isLoading || flywheelEvents.isLoading) return <Loading title="正在读取发布工作台" />;
  if (packages.error || releases.error || current.error || tasks.error || flywheelEvents.error) return <ErrorState error={packages.error ?? releases.error ?? current.error ?? tasks.error ?? flywheelEvents.error} />;

  return (
    <Page title="发布" subtitle="发布版本是 Agent 正式消费的不可变知识视图。">
      <Tabs
        active={tab}
        onChange={setTab}
        items={[
          { id: "compose", label: "组建发布" },
          { id: "current", label: "当前与历史", count: releases.data?.length }
        ]}
      />
      <div className={`release-workbench ${tab}`} key={tab}>
        {tab === "compose" && (
          <>
            <section className="release-panel">
          <div className="detail-head">
            <div>
              <h2>选择资产包</h2>
              <p>draft/reviewing/approved 都可进入发布候选，但 open blocking 任务会阻断发布。</p>
            </div>
            <Badge label={`${selectedPackageIds.length} selected`} />
          </div>
          <div className="package-picker">
            {(packages.data ?? []).map((pkg) => {
              const selected = selectedPackageIds.includes(pkg.packageId);
              const pkgBlockers = blockersByPackage.get(pkg.packageId) ?? [];
              return (
                <button
                  key={pkg.packageId}
                  className={selected ? "package-row selected" : "package-row"}
                  onClick={() => setSelectedPackageIds((currentIds) => selected
                    ? currentIds.filter((id) => id !== pkg.packageId)
                    : [...currentIds, pkg.packageId])}
                >
                  <strong>{pkg.name}</strong>
                  <span>{pkg.status} · score {qualityScore(pkg.qualitySummary)}</span>
                  <small>{pkg.packageId}</small>
                  {pkgBlockers.length > 0 && <Badge label={`${pkgBlockers.length} blocking`} tone="hot" />}
                </button>
              );
            })}
          </div>
        </section>

        <section className="release-panel">
          <div className="detail-head">
            <div>
              <h2>发布预览</h2>
              <p>发布后会冻结 package/component/source 以及质量摘要，Agent 只读 current release。</p>
            </div>
            <Badge label={blockers.length ? "blocked" : "ready"} tone={blockers.length ? "hot" : "ok"} />
          </div>
          <label className="field-label">
            版本号
            <input value={version} onChange={(event) => setVersion(event.target.value)} />
          </label>
          <div className="metrics compact release-metrics">
            <Metric label="资产包" value={selectedPackages.length} hint="本次发布包含" />
            <Metric label="来源版本" value={new Set(selectedPackages.flatMap((pkg) => pkg.sourceVersionIds)).size} hint="冻结到 manifest" />
            <Metric label="组件估算" value={selectedComponents || "-"} hint="发布时实际冻结" />
            <Metric label="发布基线" value={current.data ? "revision" : "initial"} hint={current.data?.version ?? "首次发布"} />
          </div>
          {blockers.length > 0 ? (
            <div className="warning-list">
              {blockers.map((task) => <p key={task.taskId}>{task.packageId} · {task.title}</p>)}
            </div>
          ) : (
            <p className="notice">门禁通过：所选资产包没有 open blocking 任务。</p>
          )}
          {draft && (
            <div className="release-draft">
              <strong>草案：{draft.version}</strong>
              <code>{draft.releaseId}</code>
              {draft.parentReleaseId && <span>基于 {draft.parentReleaseId}</span>}
            </div>
          )}
          <div className="detail-actions">
            <button
              className="primary-action"
              disabled={selectedPackageIds.length === 0 || blockers.length > 0 || !version.trim() || createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              <GitBranch size={16} />
              {createMutation.isPending ? "创建中..." : "创建发布草案"}
            </button>
            <button
              className="primary-action"
              disabled={!draft || blockers.length > 0 || publishMutation.isPending}
              onClick={() => publishMutation.mutate({ autoMode: false })}
            >
              <CheckCircle2 size={16} />
              {publishMutation.isPending ? "发布中..." : "发布为 Agent 当前版本"}
            </button>
            <button
              className="secondary-action"
              disabled={!draft || publishMutation.isPending}
              onClick={() => publishMutation.mutate({ autoMode: true })}
            >
              自动条件发布
            </button>
          </div>
          {(createMutation.error || publishMutation.error) && (
            <p className="error">{errorMessage(createMutation.error ?? publishMutation.error, "发布失败。")}</p>
          )}
        </section>
          </>
        )}

        {tab === "current" && (
        <section className="release-panel">
          <div className="detail-head">
            <div>
              <h2>Agent 当前版本</h2>
              <p>{current.data ? current.data.releaseId : "还没有 published release。"}</p>
            </div>
            {current.data && <Badge label={current.data.version} tone="ok" />}
          </div>
          {current.data && (
            <>
              <div className="release-current">
                <strong>{current.data.manifestHash || "manifest pending"}</strong>
                <span>{current.data.publishedAt ? formatTime(current.data.publishedAt) : "未发布"}</span>
                <span>{current.data.packageIds.length} 个资产包</span>
              </div>
              <ReleaseAuditSummaryView release={current.data} />
            </>
          )}
          <AutoPublishEventsPanel
            events={autoPublishEvents}
            focusedEventId={params.eventId}
            onNavigateReview={() => navigate("review")}
            onNavigateBuilder={() => navigate("builder")}
            onNavigateAssets={(packageId) => navigate("assets", { packageId })}
          />
          <h3>发布历史</h3>
          <div className="release-history">
            {(releases.data ?? []).map((release) => (
              <article className="history-row" key={release.releaseId}>
                <div>
                  <strong>{release.version}</strong>
                  <span>{release.releaseId}</span>
                  {release.parentReleaseId && <span className="subtle">基于 {release.parentReleaseId}</span>}
                  {release.note && <span className="subtle">{release.note}</span>}
                  <small>{release.manifestHash}</small>
                  {release.publishedAt && <small>发布于 {formatTime(release.publishedAt)}</small>}
                  {okfManifest(release) && <small>OKF · {okfManifest(release)?.bundleUri}</small>}
                  {release.packageIds.length > 0 && (
                    <div className="asset-link">
                      {release.packageIds.map((packageId) => (
                        <IdChip key={packageId} label={packageId} title="在知识资产中查看该资产包" onClick={() => navigate("assets", { packageId })} />
                      ))}
                    </div>
                  )}
                </div>
                <div className="detail-actions">
                  <Badge label={release.status} tone={release.status === "published" ? "ok" : undefined} />
                  <InlineEditor
                    saving={renameMutation.isPending}
                    title="编辑发布版本号与备注"
                    onSave={(patch) => renameMutation.mutateAsync({ releaseId: release.releaseId, patch })}
                    fields={[
                      { key: "version", label: "版本号", value: release.version, required: true, placeholder: "如 2026.06.22.001" },
                      { key: "note", label: "备注", value: release.note, multiline: true, placeholder: "本次发布说明（可选）" }
                    ]}
                  />
                  <button
                    className="icon-button"
                    title="回滚到此发布"
                    disabled={release.status !== "published" || current.data?.releaseId === release.releaseId || rollbackMutation.isPending}
                    onClick={() => rollbackMutation.mutate(release.releaseId)}
                  >
                    <RotateCcw size={16} />
                  </button>
                  <button
                    className="icon-button"
                    title={current.data?.releaseId === release.releaseId ? "当前 Agent 版本不能删除" : "删除此发布版本"}
                    disabled={current.data?.releaseId === release.releaseId || deleteMutation.isPending}
                    onClick={() => {
                      const ok = window.confirm(`确认删除发布版本 ${release.version}？\n\n将删除该 release 记录和对应 OKF bundle，已经不是当前 Agent 版本时才允许删除。`);
                      if (ok) deleteMutation.mutate(release.releaseId);
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </article>
            ))}
          </div>
          {deleteMutation.error && <p className="error">{errorMessage(deleteMutation.error, "删除发布版本失败。")}</p>}
        </section>
        )}
      </div>
    </Page>
  );
}

function AutoPublishEventsPanel({
  events,
  focusedEventId,
  onNavigateReview,
  onNavigateBuilder,
  onNavigateAssets,
}: {
  events: AutoPublishEventView[];
  focusedEventId?: string;
  onNavigateReview: () => void;
  onNavigateBuilder: () => void;
  onNavigateAssets: (packageId: string) => void;
}) {
  const latestBase = events.slice(0, 5);
  const focusedEvent = focusedEventId ? events.find((event) => event.eventId === focusedEventId) : undefined;
  const latest = focusedEvent && !latestBase.some((event) => event.eventId === focusedEvent.eventId)
    ? [focusedEvent, ...latestBase.slice(0, 4)]
    : latestBase;
  const currentStatus = latest[0]?.type ?? null;
  return (
    <section className="auto-publish-panel">
      <div className="detail-head">
        <div>
          <h3>{currentStatus === "skipped" ? <AlertTriangle size={17} /> : <CheckCircle2 size={17} />} 自动发布状态</h3>
          <p>系统自动尝试发布 revision 时，会把成功或跳过原因写在这里。</p>
        </div>
        <Badge label={currentStatus === "skipped" ? "需要处理" : currentStatus === "succeeded" ? "正常" : "暂无事件"} tone={currentStatus === "skipped" ? "warn" : currentStatus === "succeeded" ? "ok" : undefined} />
      </div>

      {latest.length === 0 ? (
        <p className="subtle">还没有自动发布事件。完成构建或反馈驱动重建后，这里会显示是否触发了自动发布。</p>
      ) : (
        <div className="auto-publish-list">
          {latest.map((event) => (
            <article className={`auto-publish-event ${event.type}${event.eventId === focusedEventId ? " targeted" : ""}`} key={event.eventId}>
              <header>
                <div>
                  <strong>{event.type === "skipped" ? "自动发布已跳过" : "自动发布成功"}</strong>
                  <span>{event.releaseVersion || event.releaseId || "未关联发布草案"} · {formatTime(event.createdAt)}</span>
                </div>
                <Badge label={event.type === "skipped" ? "blocked" : "published"} tone={event.type === "skipped" ? "warn" : "ok"} />
              </header>

              <div className="asset-link">
                {event.releaseId && <IdChip label={event.releaseId} title="发布版本 ID" />}
                {event.runId && <IdChip label={event.runId} title="构建 run ID" />}
                {event.packageId && <IdChip label={event.packageId} title="在知识资产中查看该资产包" onClick={() => onNavigateAssets(event.packageId)} />}
              </div>

              {event.type === "skipped" ? (
                <div className="auto-publish-reasons">
                  {event.reasons.map((reason) => (
                    <p key={reason}>
                      <strong>{autoPublishReasonLabel(reason)}</strong>
                      <span>{autoPublishReasonAction(reason)}</span>
                    </p>
                  ))}
                </div>
              ) : (
                <p className="notice">本次 revision 满足自动发布条件，已经成为 Agent 当前可消费版本。</p>
              )}

              <div className="auto-publish-actions">
                {event.type === "skipped" && (
                  <button className="secondary-action" onClick={onNavigateReview}>处理审核任务</button>
                )}
                {event.runId && <button className="secondary-action" onClick={onNavigateBuilder}>查看构建记录</button>}
                {event.packageId && <button className="secondary-action" onClick={() => onNavigateAssets(event.packageId)}>查看资产包</button>}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function ReleaseAuditSummaryView({ release }: { release: ReleaseRecord }) {
  const { navigate } = useNav();
  const audit = auditSummary(release);
  const okf = okfManifest(release);
  const revision = revisionInfo(release);
  const autoPublish = autoPublishInfo(release);
  if (!audit) return <OkfSummary release={release} />;
  const okfStats = audit.okf ?? okf;
  const missingCitations = okfStats ? Math.max(okfStats.citationSummary.required - okfStats.citationSummary.present, 0) : 0;
  const evidencePercent = Math.round(audit.evidence.coverageRate * 100);
  const averageTrust = audit.trust.averageScore === null ? "-" : `${Math.round(audit.trust.averageScore * 100)}%`;
  const minTrust = audit.trust.minScore === null ? "-" : `${Math.round(audit.trust.minScore * 100)}%`;
  return (
    <div className="release-audit">
      <div className="audit-head">
        <div>
          <h3><ShieldCheck size={17} /> 发布审计摘要</h3>
          <p>这份摘要同时写入 OKF bundle 的 log.md，Agent 和人工审核看到的是同一份发布事实。</p>
        </div>
        <Badge label={`v${audit.version}`} tone="ok" />
      </div>

      <div className="metrics compact audit-metrics">
        <Metric label="资产组件" value={audit.sources.componentCount} hint={`${audit.sources.packageCount} 个资产包`} />
        <Metric label="构建 Run" value={`${audit.build.completed}/${audit.build.runCount}`} hint={audit.build.failed ? `${audit.build.failed} failed` : "完成 / 总数"} tone={audit.build.failed ? "hot" : "ok"} />
        <Metric label="证据覆盖" value={`${evidencePercent}%`} hint={`${audit.evidence.coveredComponents}/${audit.evidence.requiredComponents} 组件`} tone={audit.evidence.missingComponents ? "warn" : "ok"} />
        <Metric label="可信均分" value={averageTrust} hint={`最低 ${minTrust}`} tone={trustTone(audit.trust.minScore)} />
        <Metric label="审核未关" value={audit.review.open} hint={`${audit.review.blocking} blocking`} tone={audit.review.blocking ? "hot" : audit.review.open ? "warn" : "ok"} />
        <Metric label="反馈回流" value={audit.agentFeedback.feedbackEvents} hint={`${audit.agentFeedback.mcpCalls} MCP calls`} tone={audit.agentFeedback.mcpMisses || audit.agentFeedback.mcpErrors ? "warn" : "ok"} />
        <Metric label="变更组件" value={revision ? revision.summary.componentsChanged + revision.summary.componentsAdded + revision.summary.componentsRemoved : "-"} hint={revision?.mode ?? "无版本链"} />
        <Metric label="自动发布" value={autoPublish?.eligible ? "可用" : "不可用"} hint={autoPublish?.reasons[0] ?? autoPublish?.mode ?? "未检查"} tone={autoPublish?.eligible ? "ok" : "warn"} />
      </div>

      {revision && (
        <RevisionPatchView
          revision={revision}
          onNavigateComponent={(componentId) => navigate("assets", { componentId })}
        />
      )}

      <div className="audit-grid">
        <section className="audit-card">
          <h4>来源与构建</h4>
          <div className="audit-kv">
            {revision && (
              <>
                <span>发布模式</span>
                <strong>{revision.mode}</strong>
              </>
            )}
            <span>资料版本</span>
            <strong>{audit.sources.sourceVersionIds.length}</strong>
            <span>缓存阶段</span>
            <strong>{audit.build.cachedStages}</strong>
            {revision?.parentReleaseId && (
              <>
                <span>基线版本</span>
                <strong>{revision.parentReleaseId}</strong>
              </>
            )}
          </div>
          <div className="audit-list">
            {audit.sources.packages.slice(0, 5).map((pkg) => (
              <p key={pkg.packageId}><strong>{pkg.name}</strong><span>{pkg.status} · {pkg.sourceVersionIds.join(", ") || "无来源版本"}</span></p>
            ))}
          </div>
        </section>

        <section className="audit-card">
          <h4>可信度与证据</h4>
          <div className="trust-bars">
            {Object.entries(audit.trust.statusCounts).map(([status, count]) => (
              <span key={status}><b>{status}</b><i>{count}</i></span>
            ))}
          </div>
          <div className="audit-list">
            {audit.trust.lowTrustComponents.slice(0, 4).map((component) => (
              <p key={component.componentId}>
                <strong>{component.title}</strong>
                <span>{component.score === null ? "无分数" : `${Math.round(component.score * 100)}%`} · {component.status} · {component.reasons[0] ?? component.kind}</span>
              </p>
            ))}
          </div>
        </section>

        <section className="audit-card">
          <h4>审核与反馈</h4>
          <div className="audit-kv">
            <span>已解决</span>
            <strong>{audit.review.resolvedSincePreviousRelease}</strong>
            <span>MCP Miss</span>
            <strong>{audit.agentFeedback.mcpMisses}</strong>
          </div>
          <div className="audit-list">
            {audit.review.topOpenTasks.slice(0, 3).map((task) => (
              <p key={task.taskId}><strong>{task.title}</strong><span>{task.severity} · {task.suggestedAction || "需要人工判断"}</span></p>
            ))}
            {audit.agentFeedback.topQueries.slice(0, 3).map((query) => (
              <p key={query.query}><strong>{query.query}</strong><span>Agent 查询 {query.count} 次</span></p>
            ))}
          </div>
        </section>

        <section className="audit-card">
          <h4>OKF 与健康检查</h4>
          {okfStats ? (
            <div className="audit-kv">
              {okf?.lintSummary && (
                <>
                  <span>健康分</span>
                  <strong>{Math.round(okf.lintSummary.score * 100)}%</strong>
                </>
              )}
              <span>Warning</span>
              <strong>{okfStats.summary.warning}</strong>
              {okf?.lintSummary && (
                <>
                  <span>Lint 问题</span>
                  <strong>{okf.lintSummary.blocking}/{okf.lintSummary.warning}</strong>
                </>
              )}
              <span>引用</span>
              <strong>{okfStats.citationSummary.present}/{okfStats.citationSummary.required}</strong>
              <span>链接</span>
              <strong>{okfStats.linkSummary.resolved}</strong>
              <span>断链</span>
              <strong>{okfStats.linkSummary.unresolved}</strong>
            </div>
          ) : (
            <p className="subtle">暂无 OKF 扫描结果。</p>
          )}
          <div className="okf-paths">
            {okf?.logUri && <code><FileText size={14} /> {okf.logUri}</code>}
            {okf?.revisionUri && <code>{okf.revisionUri}</code>}
            {okf?.lintMarkdownUri && <code>{okf.lintMarkdownUri}</code>}
            {okf?.reportUri && <code>{okf.reportUri}</code>}
          </div>
          {missingCitations > 0 && <p className="audit-warning">还有 {missingCitations} 个需要引用的页面没有 Citations。</p>}
          {okf?.lintSummary && okf.lintSummary.blocking > 0 && <p className="audit-warning">Knowledge Lint 发现 {okf.lintSummary.blocking} 个阻断级健康问题。</p>}
        </section>
      </div>
    </div>
  );
}

function OkfSummary({ release }: { release: ReleaseRecord }) {
  const okf = okfManifest(release);
  if (!okf) return <p className="subtle">当前发布尚未记录 OKF 导出信息。</p>;
  const missingCitations = Math.max(okf.citationSummary.required - okf.citationSummary.present, 0);
  const linkHint = okf.linkSummary.resolved === 0 && okf.linkSummary.unresolved === 0
    ? "暂无正文内交叉链接，不阻断发布"
    : `${okf.linkSummary.unresolved} unresolved`;
  return (
    <div className="okf-summary">
      <div className="metrics compact">
        <Metric label="OKF Blocking" value={okf.summary.blocking} hint="必须为 0 才能发布" tone={okf.summary.blocking ? "hot" : "ok"} />
        <Metric label="OKF Warning" value={okf.summary.warning} hint="非阻断合规提示" tone={okf.summary.warning ? "warn" : "ok"} />
        <Metric label="引用" value={`${okf.citationSummary.present}/${okf.citationSummary.required}`} hint={missingCitations ? `缺 ${missingCitations} 个引用` : "Citations 已覆盖"} tone={missingCitations ? "warn" : "ok"} />
        <Metric label="链接" value={okf.linkSummary.resolved} hint={linkHint} tone={okf.linkSummary.unresolved ? "warn" : "ok"} />
      </div>
      <div className="okf-guidance">
        {missingCitations > 0 ? (
          <p><strong>引用缺口：</strong>重新构建会为 wiki 页自动生成基础 evidence；剩余缺口通常来自需要人工补来源的规则页。</p>
        ) : (
          <p><strong>引用状态：</strong>当前导出的规则类页面已经带有 Citations，Agent 后续消费可以追溯到 source version。</p>
        )}
        {okf.summary.warning > 0 && (
          <p><strong>Warning 处理：</strong>warning 不阻断试发布，优先看缺引用、断链和 Obsidian 链接；确认是表目录或非规范页时可作为发布后优化项。</p>
        )}
        {okf.linkSummary.resolved === 0 && okf.linkSummary.unresolved === 0 && (
          <p><strong>链接说明：</strong>OKF 只统计正文里的标准 markdown 绝对链接，发布索引不计入链接数；0 不代表 Agent 无法检索。</p>
        )}
      </div>
      <div className="okf-paths">
        <code>{okf.bundleUri}</code>
        {okf.revisionUri && <code>{okf.revisionUri}</code>}
        <code>{okf.reportUri}</code>
      </div>
    </div>
  );
}

function okfManifest(release: ReleaseRecord): OkfManifest | null {
  const value = release.manifest.okf;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const okf = value as Record<string, unknown>;
  const summary = objectValue(okf.summary);
  const linkSummary = objectValue(okf.linkSummary);
  const citationSummary = objectValue(okf.citationSummary);
  return {
    bundleUri: String(okf.bundleUri ?? ""),
    reportUri: String(okf.reportUri ?? ""),
    revisionUri: String(okf.revisionUri ?? ""),
    logUri: String(okf.logUri ?? ""),
    lintUri: String(okf.lintUri ?? ""),
    lintMarkdownUri: String(okf.lintMarkdownUri ?? ""),
    lintSummary: lintSummary(okf.lintSummary),
    summary: {
      blocking: Number(summary.blocking ?? 0),
      warning: Number(summary.warning ?? 0),
      info: Number(summary.info ?? 0),
    },
    linkSummary: {
      resolved: Number(linkSummary.resolved ?? 0),
      unresolved: Number(linkSummary.unresolved ?? 0),
    },
    citationSummary: {
      required: Number(citationSummary.required ?? 0),
      present: Number(citationSummary.present ?? 0),
    },
  };
}

function lintSummary(value: unknown): KnowledgeLintSummary | null {
  const summary = objectValue(value);
  if (Object.keys(summary).length === 0) return null;
  return {
    score: Number(summary.score ?? 0),
    blocking: Number(summary.blocking ?? 0),
    warning: Number(summary.warning ?? 0),
    info: Number(summary.info ?? 0),
  };
}

function auditSummary(release: ReleaseRecord): ReleaseAuditSummary | null {
  const value = release.manifest.auditSummary;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const audit = value as ReleaseAuditSummary;
  if (!audit.sources || !audit.build || !audit.evidence || !audit.trust) return null;
  return audit;
}

function RevisionPatchView({
  revision,
  onNavigateComponent,
}: {
  revision: ReleaseRevision;
  onNavigateComponent: (componentId: string) => void;
}) {
  const reused = revision.diff.componentIds.unchanged.length;
  const rewritten = revision.diff.componentIds.added.length + revision.diff.changedComponents.length;
  return (
    <section className="revision-patch">
      <div className="revision-patch-head">
        <div>
          <h4>Revision Patch 明细</h4>
          <p>{revision.mode === "revision" ? `基于 ${revision.parentReleaseId}` : "首次发布，没有可复用基线。"}</p>
        </div>
        <Badge label={`${rewritten} rewrite / ${reused} reuse`} tone={revision.diff.componentIds.removed.length ? "warn" : "ok"} />
      </div>
      <div className="revision-patch-grid">
        <PatchGroup title="组件新增" ids={revision.diff.componentIds.added} onClick={onNavigateComponent} />
        <PatchGroup title="组件变更" ids={revision.diff.changedComponents} onClick={onNavigateComponent} />
        <PatchGroup title="组件删除" ids={revision.diff.componentIds.removed} tone="warn" />
        <PatchGroup title="组件复用" ids={revision.diff.componentIds.unchanged} />
        <PatchGroup title="资料版本新增" ids={revision.diff.sourceVersionIds.added} />
        <PatchGroup title="资料版本移除" ids={revision.diff.sourceVersionIds.removed} tone="warn" />
      </div>
    </section>
  );
}

function PatchGroup({
  title,
  ids,
  tone,
  suffix,
  onClick,
}: {
  title: string;
  ids: string[];
  tone?: "warn";
  suffix?: string;
  onClick?: (id: string) => void;
}) {
  return (
    <div className={`patch-group ${tone ?? ""}`}>
      <div className="patch-group-head">
        <strong>{title}</strong>
        {ids.length > 0 && <span className="patch-count">{ids.length}</span>}
      </div>
      <div className="patch-id-list">
        {ids.length === 0 ? <span className="subtle">无</span> : ids.map((id) => (
          // 显示人话名称（wiki/.../x.md 等），完整 ID 放进 tooltip，避免一长串 ID 撑爆列表。
          <IdChip key={id} label={componentLabel(id)} title={id} onClick={onClick ? () => onClick(id) : undefined} />
        ))}
        {suffix && <span className="subtle">{suffix}</span>}
      </div>
    </div>
  );
}

function revisionInfo(release: ReleaseRecord): ReleaseRevision | null {
  const revision = objectValue(release.manifest.revision);
  const summary = objectValue(revision.summary);
  const diff = objectValue(revision.diff);
  if (Object.keys(revision).length === 0) return null;
  return {
    mode: String(revision.mode ?? "initial"),
    parentReleaseId: typeof revision.parentReleaseId === "string" ? revision.parentReleaseId : null,
    diff: {
      packageIds: diffBucket(diff.packageIds),
      componentIds: diffBucket(diff.componentIds),
      sourceVersionIds: diffBucket(diff.sourceVersionIds),
      changedComponents: stringArray(diff.changedComponents),
      unchangedComponents: stringArray(diff.unchangedComponents),
    },
    summary: {
      packagesAdded: Number(summary.packagesAdded ?? 0),
      packagesRemoved: Number(summary.packagesRemoved ?? 0),
      componentsAdded: Number(summary.componentsAdded ?? 0),
      componentsRemoved: Number(summary.componentsRemoved ?? 0),
      componentsChanged: Number(summary.componentsChanged ?? 0),
      componentsUnchanged: Number(summary.componentsUnchanged ?? 0),
      sourceVersionsAdded: Number(summary.sourceVersionsAdded ?? 0),
      sourceVersionsRemoved: Number(summary.sourceVersionsRemoved ?? 0),
    },
  };
}

function autoPublishInfo(release: ReleaseRecord): AutoPublishInfo | null {
  const value = objectValue(release.manifest.autoPublish);
  if (Object.keys(value).length === 0) return null;
  return {
    eligible: Boolean(value.eligible),
    mode: String(value.mode ?? "manual"),
    reasons: Array.isArray(value.reasons) ? value.reasons.filter((item): item is string => typeof item === "string") : [],
  };
}

function trustTone(score: number | null): "hot" | "warn" | "ok" | undefined {
  if (score === null) return undefined;
  if (score < 0.55) return "hot";
  if (score < 0.75) return "warn";
  return "ok";
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function buildAutoPublishEvents(events: FlywheelEvent[], releases: ReleaseRecord[]): AutoPublishEventView[] {
  const releaseById = new Map(releases.map((release) => [release.releaseId, release]));
  return events
    .filter((event) => event.eventType === "release.auto_publish_skipped" || event.eventType === "release.auto_publish_succeeded")
    .map((event) => {
      const payload = objectValue(event.payload);
      const releaseId = stringField(payload.releaseId);
      return {
        eventId: event.eventId,
        type: event.eventType === "release.auto_publish_succeeded" ? "succeeded" : "skipped",
        releaseId,
        releaseVersion: releaseById.get(releaseId)?.version ?? "",
        runId: stringField(payload.runId),
        packageId: stringField(payload.packageId),
        reasons: parseAutoPublishReasons(stringField(payload.reason)),
        createdAt: event.createdAt,
      };
    });
}

function parseAutoPublishReasons(reason: string): string[] {
  const normalized = reason
    .replace(/^Auto publish is not eligible:\s*/u, "")
    .trim();
  if (!normalized) return ["unknown"];
  return normalized
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function autoPublishReasonLabel(reason: string): string {
  switch (reason) {
    case "changed_components_have_blocking_tasks":
      return "变更组件还有阻断审核";
    case "trust_score_declined_or_missing":
      return "可信度下降或缺失";
    case "removed_components_present":
      return "本次包含组件删除";
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

function autoPublishReasonAction(reason: string): string {
  switch (reason) {
    case "changed_components_have_blocking_tasks":
      return "先到审核中心完成阻断任务，再重新发布或等待下一次自动发布。";
    case "trust_score_declined_or_missing":
      return "检查变更资产的可信度明细，补证据或完成人工标注后再发布。";
    case "removed_components_present":
      return "删除知识会影响 Agent 消费，需要管理员手动确认发布。";
    case "missing_parent_release":
      return "先发布一个基线版本，后续 revision 才能自动比较差异。";
    case "no_component_changes":
      return "没有需要发布的变化，通常不需要处理。";
    default:
      return "查看关联构建 run、资产包和审核任务后决定是否手动发布。";
  }
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function diffBucket(value: unknown): ReleaseDiffBucket {
  const bucket = objectValue(value);
  return {
    added: stringArray(bucket.added),
    removed: stringArray(bucket.removed),
    unchanged: stringArray(bucket.unchanged),
  };
}

interface OkfManifest {
  bundleUri: string;
  reportUri: string;
  revisionUri: string;
  logUri: string;
  lintUri: string;
  lintMarkdownUri: string;
  lintSummary: KnowledgeLintSummary | null;
  summary: { blocking: number; warning: number; info: number };
  linkSummary: { resolved: number; unresolved: number };
  citationSummary: { required: number; present: number };
}

interface ReleaseRevision {
  mode: string;
  parentReleaseId: string | null;
  diff: {
    packageIds: ReleaseDiffBucket;
    componentIds: ReleaseDiffBucket;
    sourceVersionIds: ReleaseDiffBucket;
    changedComponents: string[];
    unchangedComponents: string[];
  };
  summary: {
    packagesAdded: number;
    packagesRemoved: number;
    componentsAdded: number;
    componentsRemoved: number;
    componentsChanged: number;
    componentsUnchanged: number;
    sourceVersionsAdded: number;
    sourceVersionsRemoved: number;
  };
}

interface ReleaseDiffBucket {
  added: string[];
  removed: string[];
  unchanged: string[];
}

interface AutoPublishInfo {
  eligible: boolean;
  mode: string;
  reasons: string[];
}

interface AutoPublishEventView {
  eventId: string;
  type: "skipped" | "succeeded";
  releaseId: string;
  releaseVersion: string;
  runId: string;
  packageId: string;
  reasons: string[];
  createdAt: string;
}
