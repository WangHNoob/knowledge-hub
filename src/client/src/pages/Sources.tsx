import { AlertTriangle, CheckCircle2, Circle, File, GitBranch, History, Loader2, Server, Upload, UploadCloud } from "lucide-react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useRef, useState } from "react";

import {
  browseLocalFiles,
  getBundleBuildPlan,
  getBundleVersion,
  getFlywheelStatus,
  getSourceFilePreview,
  getSourceVersionPreview,
  importSourceBundle,
  listBundleVersions,
  listSourceBundles,
  updateBundleVersion,
  updateSourceBundle,
  uploadSourceBundle,
  type FlywheelStatus,
  type SourceBundleVersion,
  type SourceBuildPlan,
  type SourceFileChange,
  type SourcePreviewNode
} from "../api";
import { Badge, Loading, Metric, Page, Tabs, type TabItem } from "../components/Atoms";
import { InlineEditor } from "../components/InlineEditor";
import { LocalFileBrowser } from "../components/LocalFileBrowser";
import { formatBytes, formatTime, kindLabel } from "../utils/format";
import { useProject } from "../ui/projectContext";

type SourceTab = "upload" | "server" | "preview" | "history";

export function Sources() {
  const queryClient = useQueryClient();
  const { currentProjectId, currentProject } = useProject();
  const [tab, setTab] = useState<SourceTab>("upload");
  const [rootPath, setRootPath] = useState("");
  const [note, setNote] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [browsePath, setBrowsePath] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const directoryInputRef = useRef<HTMLInputElement | null>(null);

  const versions = useQuery({
    queryKey: ["bundle-versions", currentProjectId],
    queryFn: async () => {
      const bundle = await loadDefaultBundle(currentProjectId);
      return bundle ? listBundleVersions(bundle.bundleId, currentProjectId) : [];
    }
  });
  const bundles = useQuery({
    queryKey: ["source-bundles", currentProjectId],
    queryFn: () => listSourceBundles(currentProjectId)
  });
  const bundle = (bundles.data ?? [])[0] ?? null;
  const bundleId = bundle?.bundleId ?? "";
  const bundleMutation = useMutation({
    mutationFn: (patch: { name?: string; description?: string }) => updateSourceBundle(bundleId, patch, currentProjectId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["source-bundles", currentProjectId] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] })
      ]);
    }
  });
  const versionMutation = useMutation({
    mutationFn: ({ versionId, patch }: { versionId: string; patch: { label?: string; note?: string } }) =>
      updateBundleVersion(bundleId, versionId, patch),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["bundle-versions", currentProjectId] }),
        selectedVersion
          ? queryClient.invalidateQueries({ queryKey: ["bundle-version", currentProjectId, selectedVersion] })
          : Promise.resolve()
      ]);
    }
  });
  const detail = useQuery({
    queryKey: ["bundle-version", currentProjectId, bundleId, selectedVersion],
    queryFn: () => getBundleVersion(bundleId, selectedVersion!, currentProjectId),
    enabled: Boolean(bundleId && selectedVersion)
  });
  const preview = useQuery({
    queryKey: ["bundle-preview", currentProjectId, bundleId, selectedVersion],
    queryFn: () => getSourceVersionPreview(bundleId, selectedVersion!, currentProjectId),
    enabled: Boolean(bundleId && selectedVersion)
  });
  const buildPlan = useQuery({
    queryKey: ["bundle-build-plan", currentProjectId, bundleId, selectedVersion],
    queryFn: () => getBundleBuildPlan(bundleId, selectedVersion!, currentProjectId),
    enabled: Boolean(bundleId && selectedVersion)
  });
  const filePreview = useQuery({
    queryKey: ["source-file-preview", currentProjectId, bundleId, selectedVersion, selectedPath],
    queryFn: () => getSourceFilePreview(bundleId, selectedVersion!, selectedPath, currentProjectId),
    enabled: Boolean(bundleId && selectedVersion && selectedPath)
  });
  const browser = useQuery({
    queryKey: ["local-files", browsePath],
    queryFn: () => browseLocalFiles(browsePath.trim() || undefined),
    enabled: Boolean(browsePath)
  });
  const importUploadedFiles = async () => {
    if (selectedFiles.length === 0) throw new Error("请选择文件或目录。");
    return uploadSourceBundle(bundleId, selectedFiles, note.trim() || undefined, currentProjectId, true);
  };
  const handleImportResult = async (result: Awaited<ReturnType<typeof importSourceBundle>>) => {
    const syncText = result.sync
      ? `已自动启动${result.sync.mode === "incremental" ? "增量" : "全量"}构建，完成后会自动治理并发布——进度见下方流水线状态。`
      : "已导入新版本。未开启自动构建，请联系管理员或在系统设置中开启。";
    setMessage(
      `已生成版本 ${result.version.label}：新增 ${result.version.addedCount}，修改 ${result.version.modifiedCount}，删除 ${result.version.removedCount}，未变 ${result.version.unchangedCount}（新增 blob ${result.newBlobCount}）。${syncText}`
    );
    setSelectedVersion(result.version.versionId);
    setSelectedPath(result.changes.find((change) => change.kind !== "removed")?.logicalPath ?? "");
    setNote("");
    setSelectedFiles([]);
    setTab("preview");
    await queryClient.invalidateQueries({ queryKey: ["bundle-versions", currentProjectId] });
    await queryClient.invalidateQueries({ queryKey: ["bundle-preview", currentProjectId, bundleId, result.version.versionId] });
    await queryClient.invalidateQueries({ queryKey: ["bundle-build-plan", currentProjectId, bundleId, result.version.versionId] });
    await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    await queryClient.invalidateQueries({ queryKey: ["flywheel", "status", currentProjectId] });
  };
  const versionCount = (versions.data ?? []).length;
  const tabs: ReadonlyArray<TabItem<SourceTab>> = [
    { id: "upload", label: "上传导入", icon: UploadCloud },
    { id: "server", label: "服务器导入", icon: Server },
    { id: "preview", label: "资料预览", icon: GitBranch },
    { id: "history", label: "历史版本", icon: History, count: versionCount }
  ];

  return (
    <Page
      title="资料库"
      subtitle="批量导入 gamedata/ 与 gamedocs/，按内容哈希去重并按时间生成版本。"
    >
      <p className="context-line">当前项目：{currentProject?.name ?? currentProjectId}</p>
      <Tabs items={tabs} active={tab} onChange={setTab} />
      {!bundle && <div className="tab-panel"><p>当前项目还没有资料库。新建项目会自动创建默认资料库；如果这里为空，请刷新项目列表或联系管理员。</p></div>}
      {bundle && (
        <div className="tab-panel" style={{ marginBottom: 20 }}>
          <div className="detail-head">
            <div>
              <h2 style={{ margin: 0 }}>{bundle.name}</h2>
              <p style={{ margin: "4px 0 0" }}>{bundle.description || "暂无备注"}</p>
            </div>
            <InlineEditor
              saving={bundleMutation.isPending}
              title="编辑资料库名称与备注"
              onSave={(patch) => bundleMutation.mutateAsync(patch)}
              fields={[
                { key: "name", label: "资料库名称", value: bundle.name, required: true, placeholder: "便于识别的名称" },
                { key: "description", label: "备注", value: bundle.description, multiline: true, placeholder: "说明这个资料库的范围（可选）" }
              ]}
            />
          </div>
        </div>
      )}
      {(message || error) && (
        <div className="tab-panel" style={{ marginBottom: 20 }}>
          {message && <p className="notice">{message}</p>}
          {error && <p className="error">{error}</p>}
        </div>
      )}

      {bundle && <PipelineStatusStrip projectId={currentProjectId} />}

      <div className="tab-panel" key={tab}>
        {tab === "upload" && (
          <section className="upload-box">
            <div>
              <h2>批量导入新版本</h2>
              <p>
                推荐根目录包含 <code>gamedata/</code> 和 <code>gamedocs/</code>。策划文档放在 gamedocs，
                游戏配表放在 gamedata，可继续按系统或模块分子目录。
              </p>
              <div className="folder-guide">
                <code>资料根目录/</code>
                <code>├─ gamedocs/战斗/技能设计.md</code>
                <code>└─ gamedata/Combat/Skill.xlsx</code>
              </div>
            </div>
            <div className="upload-stack">
              <div className="upload-mode">
                <div>
                  <strong>Web 上传</strong>
                  <span>{selectedFiles.length ? `${selectedFiles.length} 个文件已选择` : "适合本机浏览器直接导入"}</span>
                </div>
                <div className="detail-actions">
                  <button type="button" onClick={() => fileInputRef.current?.click()}>
                    <File size={15} />
                    选择文件
                  </button>
                  <button type="button" onClick={() => directoryInputRef.current?.click()}>
                    <Upload size={15} />
                    选择目录
                  </button>
                </div>
                <input
                  ref={fileInputRef}
                  className="hidden-input"
                  type="file"
                  multiple
                  onChange={(event) => setSelectedFiles(Array.from(event.target.files ?? []))}
                />
                <input
                  ref={directoryInputRef}
                  className="hidden-input"
                  type="file"
                  multiple
                  {...{ webkitdirectory: "", directory: "" }}
                  onChange={(event) => setSelectedFiles(Array.from(event.target.files ?? []))}
                />
              </div>
              {selectedFiles.length > 0 && (
                <div className="selected-files">
                  {summarizeSelectedFiles(selectedFiles).map((line) => <span key={line}>{line}</span>)}
                </div>
              )}
              <div className="upload-form web">
                <input
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="备注（可选）"
                />
                <button
                  disabled={!bundleId || selectedFiles.length === 0 || busy}
                  onClick={async () => {
                    setBusy(true);
                    setMessage("");
                    setError("");
                    try {
                      await handleImportResult(await importUploadedFiles());
                    } catch (err) {
                      setError(err instanceof Error ? err.message : "上传导入失败。");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? "导入中..." : "上传并导入"}
                </button>
              </div>
            </div>
          </section>
        )}

        {tab === "server" && (
          <section className="upload-box">
            <div>
              <h2>服务器路径导入</h2>
              <p>当资料已经在运行 Knowledge Hub 的机器上时，输入或浏览服务器本地目录；浏览器不会打开具体文件内容。</p>
            </div>
            <div className="upload-stack">
              <div className="upload-form">
                <input
                  value={rootPath}
                  onChange={(event) => setRootPath(event.target.value)}
                  placeholder="例：D:/raw/2026-06-10"
                  style={{ minWidth: 320 }}
                />
                <input
                  value={browsePath}
                  onChange={(event) => setBrowsePath(event.target.value)}
                  placeholder="浏览路径（可选）"
                />
                <button type="button" onClick={() => browser.refetch()}>
                  浏览
                </button>
                <button
                  disabled={!bundleId || !rootPath.trim() || busy}
                  onClick={async () => {
                    setBusy(true);
                    setMessage("");
                    setError("");
                    try {
                      const result = await importSourceBundle(bundleId, rootPath.trim(), note.trim() || undefined, currentProjectId, true);
                      await handleImportResult(result);
                    } catch (err) {
                      setError(err instanceof Error ? err.message : "导入失败。");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? "导入中..." : "导入新版本"}
                </button>
              </div>
              {browser.data && (
                <LocalFileBrowser
                  data={browser.data}
                  onOpen={(path) => {
                    setBrowsePath(path);
                  }}
                  onUse={(path) => setRootPath(path)}
                />
              )}
            </div>
          </section>
        )}

        {tab === "preview" && (
          <div className="source-preview-layout">
            <section className="source-preview-sidebar">
              <h3>资料变更</h3>
              {preview.data ? (
                <>
                  <div className="evidence-panel compact">
                    <Metric label="新增" value={preview.data.version.addedCount} hint="本次导入" />
                    <Metric label="修改" value={preview.data.version.modifiedCount} hint="内容变化" />
                    <Metric label="删除" value={preview.data.version.removedCount} hint="需要确认" />
                  </div>
                  <BuildPlanHint plan={buildPlan.data} />
                  <div className="source-tree">
                    {preview.data.tree.map((node) => (
                      <SourceTreeNode key={node.path} node={node} selectedPath={selectedPath} onSelect={setSelectedPath} />
                    ))}
                  </div>
                </>
              ) : selectedVersion ? (
                <Loading title="读取资料预览" />
              ) : (
                <p>导入或选择一个历史版本后查看资料预览。</p>
              )}
            </section>
            <section className="source-preview-content">
              {selectedPath ? (
                filePreview.data ? (
                  <>
                    <div className="detail-head">
                      <div>
                        <h2>{filePreview.data.logicalPath}</h2>
                        <p>{filePreview.data.fileType} · {formatBytes(filePreview.data.byteSize)} · {filePreview.data.contentHash.slice(7, 19)}</p>
                      </div>
                      {filePreview.data.sheet && <Badge label={`Sheet ${filePreview.data.sheet}`} />}
                    </div>
                    <pre className="source-preview-text">{filePreview.data.preview.join("\n")}</pre>
                  </>
                ) : (
                  <Loading title="读取文件预览" />
                )
              ) : (
                <p>从左侧选择一个新增或修改的资料文件。</p>
              )}
            </section>
          </div>
        )}

        {tab === "history" && (
          <div className="package-grid">
            <section className="package-list">
              <h3 style={{ margin: "0 0 8px" }}>历史版本</h3>
              {versionCount === 0 && <p>尚未导入任何版本。</p>}
              {(versions.data ?? []).map((version: SourceBundleVersion) => (
                <button
                  key={version.versionId}
                  className={selectedVersion === version.versionId ? "package-row selected" : "package-row"}
                  onClick={() => setSelectedVersion(version.versionId)}
                >
                  <strong>{version.label}</strong>
                  <span>
                    文件 {version.fileCount}　+{version.addedCount}　~{version.modifiedCount}　-{version.removedCount}
                  </span>
                  <small>{version.versionId}</small>
                </button>
              ))}
            </section>
            <section className="package-detail">
              {detail.data ? (
                <>
                  <div className="detail-head">
                    <div>
                      <h2>{detail.data.version.label}</h2>
                      <p>
                        {detail.data.version.note || "无备注"}
                        　·　创建于 {formatTime(detail.data.version.createdAt)}
                        　·　共 {detail.data.version.fileCount} 个文件，{(detail.data.version.totalBytes / 1024).toFixed(1)} KiB
                      </p>
                    </div>
                    <div className="asset-meta">
                      <Badge label={detail.data.version.parentVersionId ? "增量版本" : "首版"} />
                      <InlineEditor
                        saving={versionMutation.isPending}
                        title="编辑版本名称与备注"
                        onSave={(patch) => versionMutation.mutateAsync({ versionId: detail.data!.version.versionId, patch })}
                        fields={[
                          { key: "label", label: "版本名称", value: detail.data.version.label, required: true, placeholder: "便于识别的版本名" },
                          { key: "note", label: "备注", value: detail.data.version.note, multiline: true, placeholder: "本次导入的说明（可选）" }
                        ]}
                      />
                    </div>
                  </div>
                  <div className="evidence-panel">
                    <Metric label="新增" value={detail.data.version.addedCount} hint="本版相对上一版" />
                    <Metric label="修改" value={detail.data.version.modifiedCount} hint="内容哈希变化" />
                    <Metric label="删除" value={detail.data.version.removedCount} hint="本版不再包含" />
                    <Metric label="未变" value={detail.data.version.unchangedCount} hint="复用 blob" />
                  </div>
                  <h3>变更明细</h3>
                  {detail.data.changes.length === 0 ? (
                    <p>与上一版相比无变更。</p>
                  ) : (
                    <div className="source-list">
                      {detail.data.changes.map((change: SourceFileChange) => (
                        <article className="source-row" key={`${change.kind}:${change.logicalPath}`}>
                          <div>
                            <strong>{kindLabel(change.kind)} · {change.logicalPath}</strong>
                            <span>{change.category}</span>
                          </div>
                          <code>{"contentHash" in change ? change.contentHash.slice(7, 19) : change.previousHash.slice(7, 19)}</code>
                        </article>
                      ))}
                    </div>
                  )}
                </>
              ) : selectedVersion ? (
                <Loading title="读取版本详情" />
              ) : (
                <p>选择左侧版本查看变更详情。</p>
              )}
            </section>
          </div>
        )}
      </div>
    </Page>
  );
}

async function loadDefaultBundle(projectId: string) {
  const bundles = await listSourceBundles(projectId);
  return bundles[0] ?? null;
}

function BuildPlanHint({ plan }: { plan?: SourceBuildPlan }) {
  if (!plan) return null;
  const incremental = plan.recommendedMode === "incremental" && plan.targets.length > 0;
  return (
    <div className="build-plan-panel readonly">
      <strong>{incremental ? `增量构建：仅重建 ${plan.targets.length} 处变更` : "全量构建"}</strong>
      <p>{plan.reason}</p>
      {plan.warnings.map((warning) => <small key={warning}>{warning}</small>)}
      {plan.affectedKnowledge.length > 0 && (
        <div className="affected-list">
          {plan.affectedKnowledge.slice(0, 4).map((item) => (
            <span key={item.componentId}>{item.title || item.legacyPath}</span>
          ))}
        </div>
      )}
      <small className="build-plan-auto">上传后系统已自动按此方案构建、治理并发布，无需手动操作。</small>
    </div>
  );
}

interface PipelineStep {
  key: string;
  label: string;
  state: "done" | "active" | "pending" | "blocked";
}

/**
 * 上传后的实时流水线状态条：把飞轮的粗粒度状态映射成
 * 「构建 → 治理 → 发布」三步的可视进度，构建中自动轮询。
 */
function PipelineStatusStrip({ projectId }: { projectId: string }) {
  const statusQuery = useQuery({
    queryKey: ["flywheel", "status", projectId],
    queryFn: () => getFlywheelStatus(projectId),
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === "building" || state === "source_changed" ? 3000 : false;
    },
  });
  const status = statusQuery.data;
  if (!status) return null;

  const steps = derivePipelineSteps(status);
  const building = status.state === "building" || status.metrics.runningBuilds > 0;
  const version = status.metrics.currentReleaseVersion;

  return (
    <section className={`pipeline-strip ${status.state}`}>
      <div className="pipeline-strip-head">
        {building ? <Loader2 size={16} className="spin" /> : <CheckCircle2 size={16} />}
        <div>
          <strong>{status.headline}</strong>
          <p>{status.summary}</p>
        </div>
        {version && <span className="pipeline-strip-version">当前发布 {version}</span>}
      </div>
      <ol className="pipeline-steps">
        {steps.map((step) => (
          <li key={step.key} className={`pipeline-step ${step.state}`}>
            <PipelineStepIcon state={step.state} />
            <span>{step.label}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function PipelineStepIcon({ state }: { state: PipelineStep["state"] }) {
  if (state === "done") return <CheckCircle2 size={14} />;
  if (state === "active") return <Loader2 size={14} className="spin" />;
  if (state === "blocked") return <AlertTriangle size={14} />;
  return <Circle size={14} />;
}

function derivePipelineSteps(status: FlywheelStatus): PipelineStep[] {
  const label = { build: "构建知识", govern: "治理 Lint", publish: "发布版本" };
  switch (status.state) {
    case "building":
      return [
        { key: "build", label: label.build, state: "active" },
        { key: "govern", label: label.govern, state: "active" },
        { key: "publish", label: label.publish, state: "pending" },
      ];
    case "ready_to_publish":
      return [
        { key: "build", label: label.build, state: "done" },
        { key: "govern", label: label.govern, state: "done" },
        { key: "publish", label: label.publish, state: "active" },
      ];
    case "needs_attention":
      return [
        { key: "build", label: label.build, state: "done" },
        { key: "govern", label: label.govern, state: "done" },
        { key: "publish", label: label.publish, state: "blocked" },
      ];
    case "source_changed":
      return [
        { key: "build", label: label.build, state: "active" },
        { key: "govern", label: label.govern, state: "pending" },
        { key: "publish", label: label.publish, state: "pending" },
      ];
    case "published":
      return [
        { key: "build", label: label.build, state: "done" },
        { key: "govern", label: label.govern, state: "done" },
        { key: "publish", label: label.publish, state: "done" },
      ];
    case "idle":
    default:
      return [
        { key: "build", label: label.build, state: "pending" },
        { key: "govern", label: label.govern, state: "pending" },
        { key: "publish", label: label.publish, state: "pending" },
      ];
  }
}

function SourceTreeNode({ node, selectedPath, onSelect }: { node: SourcePreviewNode; selectedPath: string; onSelect(path: string): void }) {
  if (node.kind === "directory") {
    return (
      <div className="source-tree-dir">
        <strong>{node.name}</strong>
        <div>{node.children?.map((child) => <SourceTreeNode key={child.path} node={child} selectedPath={selectedPath} onSelect={onSelect} />)}</div>
      </div>
    );
  }
  return (
    <button className={selectedPath === node.path ? "source-tree-file selected" : "source-tree-file"} onClick={() => onSelect(node.path)}>
      <span>{node.name}</span>
      <small>{node.changeKind === "unchanged" ? node.fileType : `${kindLabel(node.changeKind ?? "modified")} · ${node.fileType}`}</small>
    </button>
  );
}

function summarizeSelectedFiles(files: File[]): string[] {
  const roots = new Set(files.map((file) => webkitRelativePath(file).split("/")[0]).filter(Boolean));
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const samples = files.slice(0, 3).map((file) => webkitRelativePath(file) || file.name);
  return [
    roots.size ? `目录：${[...roots].slice(0, 3).join(", ")}` : "散装文件选择",
    `文件：${files.length} 个，${formatBytes(totalBytes)}`,
    ...samples
  ];
}

function webkitRelativePath(file: File): string {
  return typeof (file as File & { webkitRelativePath?: string }).webkitRelativePath === "string"
    ? (file as File & { webkitRelativePath: string }).webkitRelativePath
    : "";
}
