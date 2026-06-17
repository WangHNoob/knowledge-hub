import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useQuery } from "@tanstack/react-query";

import { getComponentContent, getPackage, listPackages, type AssetPackage } from "../api";
import { Badge, Metric, Page } from "../components/Atoms";
import { formatPercent } from "../utils/format";

type TreeNode = {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  component?: { componentId: string; kind: string; legacyPath: string };
};

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

export function Assets({ highlightedPackage, onConsumeHighlight }: { highlightedPackage: string | null; onConsumeHighlight: () => void }) {
  const [selected, setSelected] = useState<string>("");
  const packages = useQuery({ queryKey: ["packages"], queryFn: listPackages });

  useEffect(() => {
    if (highlightedPackage) {
      setSelected(highlightedPackage);
      onConsumeHighlight();
    }
  }, [highlightedPackage, onConsumeHighlight]);

  const effectiveSelected = selected || packages.data?.[0]?.packageId || "";
  const detail = useQuery({
    queryKey: ["package", effectiveSelected],
    queryFn: () => getPackage(effectiveSelected),
    enabled: Boolean(effectiveSelected)
  });

  const [openFile, setOpenFile] = useState<{ componentId: string } | null>(null);
  const fileContent = useQuery({
    queryKey: ["component-content", effectiveSelected, openFile?.componentId],
    queryFn: () => getComponentContent(effectiveSelected, openFile!.componentId),
    enabled: Boolean(effectiveSelected && openFile),
  });
  const tree = useMemo(() => buildTree(detail.data?.components ?? []), [detail.data]);

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

  return (
    <Page title="知识资产" subtitle="资产包保留 Wiki、Index、Graph、表结构、证据和质量报告之间的关系。">
      <div className="package-grid">
        <section className="package-list">
          {(packages.data ?? []).map((pkg: AssetPackage) => (
            <button
              key={pkg.packageId}
              className={effectiveSelected === pkg.packageId ? "package-row selected" : "package-row"}
              onClick={() => setSelected(pkg.packageId)}
            >
              <strong>{pkg.name}</strong>
              <span>{pkg.description}</span>
              <small>{pkg.packageId}</small>
            </button>
          ))}
        </section>
        <section className="package-detail">
          {detail.data && (
            <>
              <div className="detail-head">
                <div>
                  <h2>{detail.data.package.name}</h2>
                  <p>{detail.data.package.description}</p>
                </div>
                <Badge label={detail.data.package.status} />
              </div>
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
