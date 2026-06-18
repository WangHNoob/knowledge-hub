import { useMemo, useState } from "react";
import { Save, Upload } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { importTableAliases, listTableAliases, saveTableAliases, type TableAliasEntry } from "../api";
import { Badge, ErrorState, Loading, Metric, Page } from "../components/Atoms";
import { formatTime } from "../utils/format";

const DISPLAY_CAP = 400;

function splitAliases(value: string): string[] {
  return [...new Set(value.split(/[,，、;；/|\n]+/u).map((item) => item.trim()).filter(Boolean))];
}

export function TableAliases() {
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: ["table-aliases"], queryFn: listTableAliases });
  const [q, setQ] = useState("");
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [savedNote, setSavedNote] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState("");

  const save = useMutation({
    mutationFn: (entries: Array<{ canonical: string; aliases: string[] }>) => saveTableAliases(entries),
    onSuccess: async (entries) => {
      setEdits({});
      setSavedNote(`已保存 ${entries.length} 条翻译。`);
      await queryClient.invalidateQueries({ queryKey: ["table-aliases"] });
    }
  });

  const importMutation = useMutation({
    mutationFn: (map: unknown) => importTableAliases(map),
    onSuccess: async (result) => {
      setImportError("");
      setShowImport(false);
      setImportText("");
      setSavedNote(`已导入 ${result.imported} 条翻译。`);
      await queryClient.invalidateQueries({ queryKey: ["table-aliases"] });
    },
    onError: (error) => setImportError(error instanceof Error ? error.message : String(error))
  });

  const runImport = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(importText);
    } catch {
      setImportError("不是合法的 JSON，请检查内容。");
      return;
    }
    importMutation.mutate(parsed);
  };

  const draftValue = (entry: TableAliasEntry) => edits[entry.canonical] ?? entry.aliases.join("、");
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (list.data ?? []).filter((entry) => {
      if (onlyMissing && entry.aliases.length > 0 && !(entry.canonical in edits)) return false;
      if (!needle) return true;
      return entry.canonical.toLowerCase().includes(needle) || entry.aliases.some((a) => a.toLowerCase().includes(needle));
    });
  }, [list.data, q, onlyMissing, edits]);

  if (list.isLoading) return <Loading title="正在读取翻译表" />;
  if (list.error) return <ErrorState error={list.error} />;

  const entries = list.data ?? [];
  const translated = entries.filter((e) => e.aliases.length > 0).length;
  const changedCount = Object.keys(edits).length;

  const onSave = () => {
    const byCanonical = new Map(entries.map((e) => [e.canonical, e]));
    const payload = Object.entries(edits)
      .map(([canonical, raw]) => ({ canonical, aliases: splitAliases(raw) }))
      .filter((entry) => {
        const original = byCanonical.get(entry.canonical);
        return original ? original.aliases.join("") !== entry.aliases.join("") : true;
      });
    if (payload.length > 0) save.mutate(payload);
  };

  return (
    <Page title="翻译表" subtitle="维护数据表的中文别名；构建时用于把策划文档里的中文表名解析回规范表名（可由 LLM 生成初稿）。">
      <div className="evidence-panel">
        <Metric label="表总数" value={entries.length} hint="已纳入翻译表" />
        <Metric label="已翻译" value={translated} hint="至少有一个别名" tone={translated === entries.length ? "ok" : "warn"} />
        <Metric label="待翻译" value={entries.length - translated} hint="别名为空" tone={entries.length - translated > 0 ? "warn" : "ok"} />
      </div>

      <div className="detail-head review-toolbar">
        <div>
          <h2>别名编辑</h2>
          <p>用逗号 / 顿号分隔多个别名；改完点「保存修改」。LLM 生成的初稿请人工校对。</p>
        </div>
        <div className="review-controls">
          <input className="filter-input" value={q} placeholder="搜索表名 / 别名" onChange={(event) => setQ(event.target.value)} />
          <label className="inline-check">
            <input type="checkbox" checked={onlyMissing} onChange={(event) => setOnlyMissing(event.target.checked)} />
            仅看待翻译
          </label>
          <button className="secondary-action" type="button" onClick={() => setShowImport((v) => !v)}>
            <Upload size={15} />
            导入 cn_en_map
          </button>
          <button className="primary-action" type="button" disabled={changedCount === 0 || save.isPending} onClick={onSave}>
            <Save size={15} />
            {save.isPending ? "保存中..." : `保存修改（${changedCount}）`}
          </button>
        </div>
      </div>

      {showImport && (
        <section className="alias-import">
          <p className="subtle">粘贴 cn_en_map.json 内容：扁平映射 <code>{'{ "EnglishTable": "中文名" }'}</code> 或数组 <code>{'[{ "table", "aliases" }]'}</code>。导入会与现有别名合并。</p>
          <textarea
            className="code-editor"
            value={importText}
            placeholder={'{\n  "Achievement": "成就",\n  "Activity": "活动"\n}'}
            onChange={(event) => setImportText(event.target.value)}
            spellCheck={false}
          />
          {importError && <p className="error">{importError}</p>}
          <div className="detail-actions">
            <button className="primary-action" type="button" disabled={!importText.trim() || importMutation.isPending} onClick={runImport}>
              <Upload size={15} />
              {importMutation.isPending ? "导入中..." : "导入"}
            </button>
          </div>
        </section>
      )}

      {save.error && <p className="error">{save.error instanceof Error ? save.error.message : String(save.error)}</p>}
      {savedNote && changedCount === 0 && <p className="notice">{savedNote}</p>}

      <table className="alias-table">
        <thead>
          <tr><th>规范表名</th><th>中文别名</th><th>来源</th><th>更新</th></tr>
        </thead>
        <tbody>
          {filtered.slice(0, DISPLAY_CAP).map((entry) => (
            <tr key={entry.canonical} className={entry.canonical in edits ? "dirty" : ""}>
              <td><code>{entry.canonical}</code></td>
              <td>
                <input
                  className="alias-input"
                  value={draftValue(entry)}
                  placeholder="中文别名，逗号分隔"
                  onChange={(event) => setEdits((prev) => ({ ...prev, [entry.canonical]: event.target.value }))}
                />
              </td>
              <td>{entry.source === "llm" ? <Badge label="LLM 初稿" tone="warn" /> : <Badge label="人工" tone="ok" />}</td>
              <td className="subtle">{entry.updatedBy ? `${entry.updatedBy} · ${formatTime(entry.updatedAt)}` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {filtered.length > DISPLAY_CAP && <p className="subtle">仅显示前 {DISPLAY_CAP} 条，请用搜索缩小范围。</p>}
      {filtered.length === 0 && <p className="subtle">没有匹配的表。构建一次知识资产后，这里会自动列出所有数据表。</p>}
    </Page>
  );
}
