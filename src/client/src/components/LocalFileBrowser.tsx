import { Database, File } from "lucide-react";

import type { LocalBrowseResult } from "../api";
import { formatBytes } from "../utils/format";

export function LocalFileBrowser({
  data,
  onOpen,
  onUse
}: {
  data: LocalBrowseResult;
  onOpen: (path: string) => void;
  onUse: (path: string) => void;
}) {
  return (
    <div className="local-browser">
      <div className="local-browser-head">
        <div>
          <strong>{data.path}</strong>
          <span>{data.entries.length} 个条目</span>
        </div>
        <div className="detail-actions">
          {data.parentPath && <button type="button" onClick={() => onOpen(data.parentPath!)}>上级</button>}
          <button type="button" onClick={() => onUse(data.path)}>使用当前目录</button>
        </div>
      </div>
      <div className="local-browser-list">
        {data.entries.map((entry) => (
          <button
            type="button"
            key={entry.path}
            className="local-browser-row"
            onClick={() => entry.kind === "directory" ? onOpen(entry.path) : undefined}
            disabled={entry.kind !== "directory"}
          >
            {entry.kind === "directory" ? <Database size={15} /> : <File size={15} />}
            <span>{entry.name}</span>
            <small>{entry.kind === "directory" ? "目录" : formatBytes(entry.size ?? 0)}</small>
          </button>
        ))}
      </div>
    </div>
  );
}
