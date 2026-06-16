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
import { Badge, ErrorState, Loading, Metric, Page } from "../components/Atoms";
import { errorMessage, qualityScore, releaseVersion } from "../utils/format";

export function Release() {
  const queryClient = useQueryClient();
  const [selectedPackageIds, setSelectedPackageIds] = useState<string[]>([]);
  const [version, setVersion] = useState(() => releaseVersion());
  const packages = useQuery({ queryKey: ["packages"], queryFn: listPackages });
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
      <div className="release-workbench">
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

        <section className="release-panel">
          <div className="detail-head">
            <div>
              <h2>Agent 当前版本</h2>
              <p>{current.data ? current.data.releaseId : "还没有 published release。"}</p>
            </div>
            {current.data && <Badge label={current.data.version} tone="ok" />}
          </div>
          {current.data && (
            <div className="release-current">
              <strong>{current.data.manifestHash || "manifest pending"}</strong>
              <span>{current.data.publishedAt}</span>
              <span>{current.data.packageIds.length} 个资产包</span>
            </div>
          )}
          <h3>发布历史</h3>
          <div className="release-history">
            {(releases.data ?? []).map((release) => (
              <article className="history-row" key={release.releaseId}>
                <div>
                  <strong>{release.version}</strong>
                  <span>{release.releaseId}</span>
                  <small>{release.manifestHash}</small>
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
      </div>
    </Page>
  );
}
