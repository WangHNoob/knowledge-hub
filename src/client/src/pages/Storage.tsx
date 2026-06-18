import { useState } from "react";
import { HardDrive, RefreshCw, Trash2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getStorageOverview, reclaimStorage, scanStorage } from "../api";
import type { StorageCategory, StorageEntry } from "../api";
import { Badge, ErrorState, Loading, Metric, Page } from "../components/Atoms";
import { formatBytes, formatTime } from "../utils/format";

const CATEGORY_LABEL: Record<StorageCategory, string> = {
  blobs: "资料 Blob 存储",
  kb_build_runs: "构建工作区",
  web_imports: "上传暂存",
  releases: "发布产物",
  logs: "运行日志"
};

const CATEGORY_HINT: Record<StorageCategory, string> = {
  blobs: "内容寻址去重，仅回收无 DB 记录的孤儿文件",
  kb_build_runs: "每次构建的工作区，回收已无构建记录的残留目录",
  web_imports: "上传暂存目录，超过保留期即可回收",
  releases: "OKF 发布产物，仅回收无对应发布版本的残留",
  logs: "按天切分的运行日志，超过保留期可清理"
};

export function Storage() {
  const queryClient = useQueryClient();
  const overview = useQuery({ queryKey: ["storage", "overview"], queryFn: getStorageOverview });
  const scan = useQuery({ queryKey: ["storage", "scan"], queryFn: scanStorage, enabled: false });
  const [selected, setSelected] = useState<Set<StorageCategory>>(new Set());
  const [error, setError] = useState("");

  const reclaim = useMutation({
    mutationFn: (categories: StorageCategory[]) => reclaimStorage(categories),
    onSuccess: async () => {
      setError("");
      setSelected(new Set());
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["storage"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] })
      ]);
      await scan.refetch();
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e))
  });

  if (overview.isLoading) return <Loading title="正在统计存储占用" />;
  if (overview.error) return <ErrorState error={overview.error} />;

  const toggle = (cat: StorageCategory) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next;
    });
  };

  const reclaimableEntries = (scan.data?.entries ?? []).filter((e) => e.status === "reclaimable");
  const byCategory = new Map<StorageCategory, StorageEntry[]>();
  for (const entry of reclaimableEntries) {
    byCategory.set(entry.category, [...(byCategory.get(entry.category) ?? []), entry]);
  }

  const runReclaim = () => {
    const cats = [...selected];
    if (cats.length === 0) return;
    const base = "将永久删除选中类别的可回收文件，该操作不可撤销。";
    const blobsWarning = cats.includes("blobs")
      ? "\n\n注意：包含 Blob 孤儿文件，请确认这些文件确实没有被任何资料版本引用。"
      : "";
    if (window.confirm(`${base}${blobsWarning}\n\n确认继续？`)) reclaim.mutate(cats);
  };

  return (
    <Page title="存储治理" subtitle="一眼看清 data/ 下各类存储的占用与可回收量，按类别显式回收孤儿数据。">
      <div className="evidence-panel">
        <Metric label="总占用" value={formatBytes(overview.data!.totalBytes)} hint="data/ 下全部受治理存储" />
        <Metric
          label="可回收"
          value={formatBytes(overview.data!.reclaimableBytes)}
          hint="孤儿/过期数据，可安全清理"
          tone={overview.data!.reclaimableBytes > 0 ? "warn" : "ok"}
        />
        <Metric label="统计时间" value={formatTime(overview.data!.scannedAt)} hint="overview 扫描时刻" />
      </div>

      <div className="detail-head">
        <div>
          <h2>分类占用</h2>
          <p>勾选要回收的类别后点击「回收选中」。回收前服务端会重新扫描以重算存活性。</p>
        </div>
        <button className="secondary-action" type="button" disabled={scan.isFetching} onClick={() => scan.refetch()}>
          <RefreshCw size={15} />
          {scan.isFetching ? "扫描中..." : "扫描可回收项"}
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="storage-categories">
        {overview.data!.categories.map((cat) => {
          const entries = byCategory.get(cat.category) ?? [];
          const scanned = scan.data !== undefined;
          const checkboxDisabled = !scanned || cat.reclaimableEntries === 0;
          return (
            <article className="storage-category" key={cat.category}>
              <header>
                <label className="storage-pick">
                  <input
                    type="checkbox"
                    disabled={checkboxDisabled}
                    checked={selected.has(cat.category)}
                    onChange={() => toggle(cat.category)}
                  />
                  <HardDrive size={16} />
                  <strong>{CATEGORY_LABEL[cat.category]}</strong>
                </label>
                <div className="storage-meta">
                  <Badge label={`总 ${formatBytes(cat.totalBytes)}`} />
                  <Badge
                    label={`可回收 ${formatBytes(cat.reclaimableBytes)} · ${cat.reclaimableEntries} 项`}
                    tone={cat.reclaimableBytes > 0 ? "warn" : "ok"}
                  />
                </div>
              </header>
              <p className="subtle">{CATEGORY_HINT[cat.category]} · {cat.fileCount} 个文件</p>
              {scanned && entries.length > 0 && (
                <ul className="storage-entries">
                  {entries.slice(0, 50).map((entry) => (
                    <li key={entry.key}>
                      <code>{entry.key}</code>
                      <span>{formatBytes(entry.bytes)}</span>
                      <small>{entry.reason}</small>
                    </li>
                  ))}
                  {entries.length > 50 && <li className="subtle">…还有 {entries.length - 50} 项</li>}
                </ul>
              )}
            </article>
          );
        })}
      </div>

      <div className="detail-actions">
        <button
          className="secondary-action danger"
          type="button"
          disabled={selected.size === 0 || reclaim.isPending}
          onClick={runReclaim}
        >
          <Trash2 size={15} />
          {reclaim.isPending ? "回收中..." : `回收选中（${selected.size}）`}
        </button>
        {reclaim.data && (
          <p className="notice">
            已回收 {reclaim.data.deletedEntries} 项，释放 {formatBytes(reclaim.data.reclaimedBytes)}。
          </p>
        )}
      </div>
    </Page>
  );
}
