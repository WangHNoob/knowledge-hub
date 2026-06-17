import { File, History, Server, Upload, UploadCloud } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import {
  browseLocalFiles,
  getBundleVersion,
  importSourceBundle,
  listBundleVersions,
  uploadSourceBundle,
  type SourceBundleVersion,
  type SourceFileChange
} from "../api";
import { Badge, Loading, Metric, Page, Tabs, type TabItem } from "../components/Atoms";
import { LocalFileBrowser } from "../components/LocalFileBrowser";
import { formatBytes, kindLabel } from "../utils/format";

type SourceTab = "upload" | "server" | "history";

export function Sources() {
  const queryClient = useQueryClient();
  const bundleId = "default";
  const [tab, setTab] = useState<SourceTab>("upload");
  const [rootPath, setRootPath] = useState("");
  const [note, setNote] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [browsePath, setBrowsePath] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const directoryInputRef = useRef<HTMLInputElement | null>(null);

  const versions = useQuery({
    queryKey: ["bundle-versions", bundleId],
    queryFn: () => listBundleVersions(bundleId)
  });
  const detail = useQuery({
    queryKey: ["bundle-version", bundleId, selectedVersion],
    queryFn: () => getBundleVersion(bundleId, selectedVersion!),
    enabled: Boolean(selectedVersion)
  });
  const browser = useQuery({
    queryKey: ["local-files", browsePath],
    queryFn: () => browseLocalFiles(browsePath.trim() || undefined),
    enabled: Boolean(browsePath)
  });
  const importUploadedFiles = async () => {
    if (selectedFiles.length === 0) throw new Error("请选择文件或目录。");
    return uploadSourceBundle(bundleId, selectedFiles, note.trim() || undefined);
  };
  const handleImportResult = async (result: Awaited<ReturnType<typeof importSourceBundle>>) => {
    setMessage(
      `已生成版本 ${result.version.label}：新增 ${result.version.addedCount}，修改 ${result.version.modifiedCount}，删除 ${result.version.removedCount}，未变 ${result.version.unchangedCount}（新增 blob ${result.newBlobCount}）。`
    );
    setSelectedVersion(result.version.versionId);
    setNote("");
    setSelectedFiles([]);
    setTab("history");
    await queryClient.invalidateQueries({ queryKey: ["bundle-versions", bundleId] });
    await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };
  const versionCount = (versions.data ?? []).length;
  const tabs: ReadonlyArray<TabItem<SourceTab>> = [
    { id: "upload", label: "上传导入", icon: UploadCloud },
    { id: "server", label: "服务器导入", icon: Server },
    { id: "history", label: "历史版本", icon: History, count: versionCount }
  ];

  return (
    <Page
      title="资料库"
      subtitle="批量导入 gamedata/ 与 gamedocs/，按内容哈希去重并按时间生成版本。"
    >
      <Tabs items={tabs} active={tab} onChange={setTab} />
      {(message || error) && (
        <div className="tab-panel" style={{ marginBottom: 20 }}>
          {message && <p className="notice">{message}</p>}
          {error && <p className="error">{error}</p>}
        </div>
      )}

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
                  disabled={selectedFiles.length === 0 || busy}
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
                  disabled={!rootPath.trim() || busy}
                  onClick={async () => {
                    setBusy(true);
                    setMessage("");
                    setError("");
                    try {
                      const result = await importSourceBundle(bundleId, rootPath.trim(), note.trim() || undefined);
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
                        　·　创建于 {detail.data.version.createdAt}
                        　·　共 {detail.data.version.fileCount} 个文件，{(detail.data.version.totalBytes / 1024).toFixed(1)} KiB
                      </p>
                    </div>
                    <Badge label={detail.data.version.parentVersionId ? "增量版本" : "首版"} />
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
