import { CheckCircle2, GitBranch, RotateCcw } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  createRelease,
  getCurrentRelease,
  listPackages,
  listReleases,
  listReviewTasks,
  publishRelease,
  rollbackRelease,
  type ReleaseRecord
} from "../api";
import { Badge, ErrorState, Loading, Metric, Page, Tabs } from "../components/Atoms";
import { errorMessage, qualityScore, releaseVersion } from "../utils/format";
import { IdChip, useNav } from "../ui/navigation";

type ReleaseTab = "compose" | "current";

export function Release() {
  const { navigate } = useNav();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<ReleaseTab>("compose");
  const [selectedPackageIds, setSelectedPackageIds] = useState<string[]>([]);
  const [version, setVersion] = useState(() => releaseVersion());
  const packages = useQuery({ queryKey: ["packages"], queryFn: () => listPackages() });
  const tasks = useQuery({ queryKey: ["review", "blocking"], queryFn: () => listReviewTasks("blocking") });
  const releases = useQuery({ queryKey: ["releases"], queryFn: listReleases });
  const current = useQuery({ queryKey: ["releases", "current"], queryFn: getCurrentRelease });
  const [draft, setDraft] = useState<ReleaseRecord | null>(null);

  const blockers = (tasks.data ?? []).filter((task) => task.status === "open" && task.severity === "blocking" && selectedPackageIds.includes(task.packageId));
  const selectedPackages = (packages.data ?? []).filter((pkg) => selectedPackageIds.includes(pkg.packageId));
  const selectedComponents = selectedPackages.reduce((sum, pkg) => sum + Number(pkg.qualitySummary.componentCount ?? 0), 0);
  const createMutation = useMutation({
    mutationFn: () => createRelease(version.trim(), selectedPackageIds),
    onSuccess: async (release) => {
      setDraft(release);
      await queryClient.invalidateQueries({ queryKey: ["releases"] });
    }
  });
  const publishMutation = useMutation({
    mutationFn: async () => publishRelease(draft?.releaseId ?? ""),
    onSuccess: async () => {
      setDraft(null);
      setVersion(releaseVersion());
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["releases"] }),
        queryClient.invalidateQueries({ queryKey: ["releases", "current"] }),
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
        queryClient.invalidateQueries({ queryKey: ["dashboard"] })
      ]);
    }
  });

  if (packages.isLoading || releases.isLoading || current.isLoading || tasks.isLoading) return <Loading title="正在读取发布工作台" />;
  if (packages.error || releases.error || current.error || tasks.error) return <ErrorState error={packages.error ?? releases.error ?? current.error ?? tasks.error} />;

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
              const pkgBlockers = (tasks.data ?? []).filter((task) => task.status === "open" && task.packageId === pkg.packageId && task.severity === "blocking");
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
              onClick={() => publishMutation.mutate()}
            >
              <CheckCircle2 size={16} />
              {publishMutation.isPending ? "发布中..." : "发布为 Agent 当前版本"}
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
                <span>{current.data.publishedAt}</span>
                <span>{current.data.packageIds.length} 个资产包</span>
              </div>
              <OkfSummary release={current.data} />
            </>
          )}
          <h3>发布历史</h3>
          <div className="release-history">
            {(releases.data ?? []).map((release) => (
              <article className="history-row" key={release.releaseId}>
                <div>
                  <strong>{release.version}</strong>
                  <span>{release.releaseId}</span>
                  <small>{release.manifestHash}</small>
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
                  <button
                    className="icon-button"
                    title="回滚到此发布"
                    disabled={release.status !== "published" || current.data?.releaseId === release.releaseId || rollbackMutation.isPending}
                    onClick={() => rollbackMutation.mutate(release.releaseId)}
                  >
                    <RotateCcw size={16} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
        )}
      </div>
    </Page>
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

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

interface OkfManifest {
  bundleUri: string;
  reportUri: string;
  summary: { blocking: number; warning: number; info: number };
  linkSummary: { resolved: number; unresolved: number };
  citationSummary: { required: number; present: number };
}
