import { PackagePlus } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { importLegacy, scanLegacy } from "../api";
import { Badge, Metric, Page } from "../components/Atoms";
import { QualityGateAdmin } from "../components/QualityGateAdmin";

export function Maintenance() {
  const [path, setPath] = useState("D:/projects/knowledge/data");
  const [summary, setSummary] = useState<Awaited<ReturnType<typeof scanLegacy>> | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const queryClient = useQueryClient();

  return (
    <Page title="高级维护" subtitle="给管理员和主开发者查看底层 ID、迁移、审计和调试入口。">
      <QualityGateAdmin />
      <section className="upload-box">
        <div>
          <h2>旧知识库扫描预览</h2>
          <p>先扫描旧 kb-builder data 目录，只生成摘要，不导入、不改动文件。</p>
        </div>
        <div className="upload-form legacy">
          <input value={path} onChange={(event) => setPath(event.target.value)} />
          <button
            onClick={async () => {
              setLoading(true);
              setError("");
              setMessage("");
              try {
                setSummary(await scanLegacy(path));
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              } finally {
                setLoading(false);
              }
            }}
          >
            {loading ? "扫描中..." : "扫描目录"}
          </button>
        </div>
        {error && <p className="error">{error}</p>}
        {message && <p className="notice">{message}</p>}
      </section>
      {summary && (
        <section className="legacy-summary">
          <div className="detail-head">
            <div>
              <h2>{summary.recommendedPackageId}</h2>
              <p>{summary.root}</p>
            </div>
            <div className="detail-actions">
              <Badge label={`${summary.warnings.length} warnings`} tone={summary.warnings.length ? "warn" : "ok"} />
              <button
                className="primary-action"
                disabled={importing}
                onClick={async () => {
                  setImporting(true);
                  setError("");
                  setMessage("");
                  try {
                    const result = await importLegacy(summary.root);
                    setMessage(
                      result.created
                        ? `已生成草稿资产包：${result.package.name}，包含 ${result.createdComponents} 个资产组件、${result.importedSources} 份资料。`
                        : `草稿资产包已存在：${result.package.name}`
                    );
                    await Promise.all([
                      queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
                      queryClient.invalidateQueries({ queryKey: ["packages"] }),
                      queryClient.invalidateQueries({ queryKey: ["sources"] })
                    ]);
                  } catch (err) {
                    setError(err instanceof Error ? err.message : String(err));
                  } finally {
                    setImporting(false);
                  }
                }}
              >
                <PackagePlus size={16} />
                {importing ? "生成中..." : "生成草稿资产包"}
              </button>
            </div>
          </div>
          <div className="metrics compact">
            <Metric label="资料" value={summary.sources.total} hint="gamedocs / gamedata" />
            <Metric label="Wiki" value={summary.wiki.pages} hint="wiki/**/*.md" />
            <Metric label="Index" value={summary.index.files} hint="wiki/_meta" />
            <Metric label="Graph" value={summary.graph.files} hint="graph snapshots" />
            <Metric label="Table" value={summary.tables.files} hint="schemas / table docs" />
          </div>
          {summary.warnings.length > 0 && (
            <div className="warning-list">
              {summary.warnings.map((warning) => <p key={warning}>{warning}</p>)}
            </div>
          )}
        </section>
      )}
    </Page>
  );
}
