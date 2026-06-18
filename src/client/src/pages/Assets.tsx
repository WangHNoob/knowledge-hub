import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Trash2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { deletePackage, getComponentContent, getComponentOwner, getPackage, listPackages, type AssetPackage } from "../api";
import { Badge, Metric, Page } from "../components/Atoms";
import { formatPercent } from "../utils/format";
import { IdChip, useNav } from "../ui/navigation";

type TreeNode = {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  component?: { componentId: string; kind: string; legacyPath: string };
};

const STATUS_OPTIONS = ["draft", "reviewing", "approved", "published", "stale"];

function buildTree(components: Array<{ componentId: string; kind: string; legacyPath: string }>): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map() };
  for (const component of components) {
    const parts = (component.legacyPath || component.componentId).split("/").filter(Boolean);
    let node = root;
    parts.forEach((part, index) => {
      const childPath = parts.slice(0, index + 1).join("/");
      if (!node.children.has(part)) node.children.set(part, { name: part, path: childPath, children: new Map() });
      node = node.children.get(part)!;
      if (index === parts.length - 1) node.component = component;
    });
  }
  return root;
}

function formatContent(pathName: string, content: string): string {
  if (pathName.endsWith(".json")) {
    try { return JSON.stringify(JSON.parse(content), null, 2); } catch { return content; }
  }
  return content;
}

export function Assets() {
  const { navigate, params } = useNav();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string>("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [openFile, setOpenFile] = useState<{ componentId: string } | null>(null);
  const packages = useQuery({ queryKey: ["packages", { q, status }], queryFn: () => listPackages({ q, status }) });

  // Honor cross-navigation (e.g. from global search, builder, release, review).
  useEffect(() => {
    if (params.packageId) setSelected(params.packageId);
    if (params.componentId) setOpenFile({ componentId: params.componentId });
  }, [params.packageId, params.componentId]);

  // When navigated with only a componentId (e.g. from Agent feedback), resolve its package.
  const owner = useQuery({
    queryKey: ["component-owner", params.componentId],
    queryFn: () => getComponentOwner(params.componentId!),
    enabled: Boolean(params.componentId && !params.packageId)
  });
  useEffect(() => {
    if (owner.data) setSelected(owner.data);
  }, [owner.data]);

  const effectiveSelected = selected || packages.data?.[0]?.packageId || "";
  const detail = useQuery({
    queryKey: ["package", effectiveSelected],
    queryFn: () => getPackage(effectiveSelected),
    enabled: Boolean(effectiveSelected)
  });

  const deleteMutation = useMutation({
    mutationFn: deletePackage,
    onSuccess: async () => {
      setDeleteError("");
      setOpenFile(null);
      setSelected("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["packages"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] })
      ]);
    },
    onError: (error) => setDeleteError(error instanceof Error ? error.message : String(error))
  });
  const fileContent = useQuery({
    queryKey: ["component-content", effectiveSelected, openFile?.componentId],
    queryFn: () => getComponentContent(effectiveSelected, openFile!.componentId),
    enabled: Boolean(effectiveSelected && openFile),
  });
  const tree = useMemo(() => buildTree(detail.data?.components ?? []), [detail.data]);

  const confirmDelete = (pkg: AssetPackage) => {
    const confirmed = window.confirm(`确认删除知识资产包「${pkg.name}」？\n\n未发布资产包会连同组件、证据和审核任务一起删除；已被发布版本引用的资产包会被后台拒绝。`);
    if (confirmed) deleteMutation.mutate(pkg.packageId);
  };

  const renderNode = (node: TreeNode, depth: number): JSX.Element[] =>
    [...node.children.values()]
      .sort((a, b) => (a.children.size === b.children.size ? a.name.localeCompare(b.name) : b.children.size - a.children.size))
      .flatMap((child) => {
        const isFile = child.children.size === 0 && Boolean(child.component);
        const row = (
          <button
            key={child.path}
            className={`tree-node ${isFile ? "file" : "dir"} ${openFile?.componentId === child.component?.componentId ? "active" : ""}`}
            style={{ paddingLeft: `${depth * 14 + 8}px` }}
            onClick={() => { if (isFile && child.component) setOpenFile({ componentId: child.component.componentId }); }}
          >
            {isFile ? "📄" : "📁"} {child.name}
          </button>
        );
        return isFile ? [row] : [row, ...renderNode(child, depth + 1)];
      });

  const pkg = detail.data?.package;
  const openReviewTasks = (detail.data?.reviewTasks ?? []).filter((task) => task.status === "open");

  return (
    <Page title="知识资产" subtitle="资产包保留 Wiki、Index、Graph、表结构、证据和质量报告之间的关系。">
      <div className="package-grid">
        <section className="package-list">
          <div className="list-filters">
            <input
              className="filter-input"
              value={q}
              placeholder="搜索资产包名称 / 描述"
              onChange={(event) => setQ(event.target.value)}
            />
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">全部状态</option>
              {STATUS_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </div>
          {(packages.data ?? []).map((item: AssetPackage) => (
            <button
              key={item.packageId}
              className={effectiveSelected === item.packageId ? "package-row selected" : "package-row"}
              onClick={() => setSelected(item.packageId)}
            >
              <strong>{item.name}</strong>
              <span>{item.description}</span>
              <small>{item.packageId}</small>
            </button>
          ))}
          {packages.data && packages.data.length === 0 && <p className="subtle">没有匹配的资产包。</p>}
        </section>
        <section className="package-detail">
          {detail.data && pkg && (
            <>
              <div className="detail-head">
                <div>
                  <h2>{pkg.name}</h2>
                  <p>{pkg.description}</p>
                </div>
                <div className="asset-meta">
                  <Badge label={pkg.status} />
                  <button className="secondary-action danger" type="button" disabled={deleteMutation.isPending} onClick={() => confirmDelete(pkg)}>
                    <Trash2 size={15} />
                    {deleteMutation.isPending ? "删除中..." : "删除资产包"}
                  </button>
                </div>
              </div>
              <div className="asset-links">
                {pkg.createdByRunId && (
                  <span className="asset-link">
                    构建来源：
                    <IdChip label={pkg.createdByRunId} title="在知识构建中查看该构建" onClick={() => navigate("builder", { runId: pkg.createdByRunId })} />
                  </span>
                )}
                {pkg.sourceVersionIds.length > 0 && (
                  <span className="asset-link">
                    资料版本：
                    {pkg.sourceVersionIds.map((versionId) => (
                      <IdChip key={versionId} label={versionId} title="在资料库中查看该版本" onClick={() => navigate("sources", { versionId })} />
                    ))}
                  </span>
                )}
                {openReviewTasks.length > 0 && (
                  <span className="asset-link">
                    审核任务：
                    <IdChip label={`${openReviewTasks.length} 个待处理`} title="在审核中心查看该资产包的任务" onClick={() => navigate("review", { packageId: pkg.packageId })} />
                  </span>
                )}
              </div>
              {deleteError && <p className="error">{deleteError}</p>}
              <div className="evidence-panel">
                <Metric
                  label="证据覆盖"
                  value={formatPercent(detail.data.evidenceCoverage.coverageRate)}
                  hint={`${detail.data.evidenceCoverage.coveredComponents}/${detail.data.evidenceCoverage.totalComponents} 个组件`}
                  tone={detail.data.evidenceCoverage.missingComponents > 0 ? "warn" : "ok"}
                />
                <Metric label="证据记录" value={detail.data.evidenceCoverage.evidenceRecords} hint="可追溯 source version" />
                <Metric label="待补证据" value={detail.data.evidenceCoverage.missingComponents} hint="优先进入审核中心" tone={detail.data.evidenceCoverage.missingComponents > 0 ? "warn" : "ok"} />
              </div>
              <div className="asset-browser">
                <div className="asset-tree">{renderNode(tree, 0)}</div>
                <div className="asset-viewer">
                  {!openFile && <p className="subtle">点击左侧文件查看内容。</p>}
                  {openFile && fileContent.isLoading && <p className="subtle">加载中…</p>}
                  {openFile && fileContent.isError && <p className="error">{(fileContent.error as Error).message}</p>}
                  {openFile && fileContent.data && (
                    <>
                      <div className="viewer-head">
                        <code>{fileContent.data.legacyPath}</code>
                        <span>{fileContent.data.kind}{fileContent.data.truncated ? " · 已截断" : ""}</span>
                      </div>
                      <pre className="viewer-body">{formatContent(fileContent.data.legacyPath, fileContent.data.content)}</pre>
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </Page>
  );
}
