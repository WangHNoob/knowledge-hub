import { RefreshCw } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { getDiagnosticSummary, getDiagnosticTrace, listDiagnosticLogs } from "../api";
import { Badge, EmptyWork, ErrorState, Loading, Metric, Page } from "../components/Atoms";
import { formatTime } from "../utils/format";

export function Diagnostics() {
  const [filters, setFilters] = useState({
    level: "",
    category: "",
    status: "",
    traceId: "",
    runId: "",
    releaseId: "",
    entityId: "",
    q: ""
  });
  const [selectedTraceId, setSelectedTraceId] = useState("");
  const query = {
    ...filters,
    traceId: filters.traceId || undefined,
    level: filters.level || undefined,
    category: filters.category || undefined,
    status: filters.status || undefined,
    runId: filters.runId || undefined,
    releaseId: filters.releaseId || undefined,
    entityId: filters.entityId || undefined,
    q: filters.q || undefined,
    limit: 100
  };
  const summary = useQuery({ queryKey: ["diagnostics", "summary"], queryFn: getDiagnosticSummary, refetchInterval: 15000 });
  const logs = useQuery({ queryKey: ["diagnostics", "logs", query], queryFn: () => listDiagnosticLogs(query), refetchInterval: 10000 });
  const trace = useQuery({
    queryKey: ["diagnostics", "trace", selectedTraceId],
    queryFn: () => getDiagnosticTrace(selectedTraceId),
    enabled: Boolean(selectedTraceId)
  });
  const selectedLog = (logs.data ?? [])[0] ?? null;

  if (summary.isLoading && logs.isLoading) return <Loading title="正在读取运行诊断" />;
  if (summary.error || logs.error) return <ErrorState error={summary.error ?? logs.error} />;

  const applyTrace = (traceId: string) => {
    setSelectedTraceId(traceId);
    setFilters((current) => ({ ...current, traceId }));
  };

  return (
    <Page title="运行诊断" subtitle="按 trace、run、release 和组件实体追踪 HTTP、构建、LLM、发布与 MCP 的运行问题。">
      <div className="metrics compact diagnostics-metrics">
        <Metric label="24h 错误" value={summary.data?.errors24h ?? 0} hint="error / failed" tone={(summary.data?.errors24h ?? 0) > 0 ? "hot" : "ok"} />
        <Metric label="慢请求" value={summary.data?.slowRequests24h ?? 0} hint="HTTP >= 1000ms" tone={(summary.data?.slowRequests24h ?? 0) > 0 ? "warn" : "ok"} />
        <Metric label="失败构建" value={summary.data?.failedBuilds24h ?? 0} hint="kb_build failed" tone={(summary.data?.failedBuilds24h ?? 0) > 0 ? "hot" : "ok"} />
        <Metric label="MCP 错误" value={summary.data?.mcpErrors24h ?? 0} hint="Agent 查询异常" tone={(summary.data?.mcpErrors24h ?? 0) > 0 ? "warn" : "ok"} />
        <Metric label="LLM 错误" value={summary.data?.llmErrors24h ?? 0} hint="连接 / 生成阶段" tone={(summary.data?.llmErrors24h ?? 0) > 0 ? "warn" : "ok"} />
      </div>

      <div className="diagnostics-workbench">
        <section className="diagnostics-filter">
          <h2>筛选</h2>
          <label>
            级别
            <select value={filters.level} onChange={(event) => setFilters({ ...filters, level: event.target.value })}>
              <option value="">全部</option>
              {["debug", "info", "warn", "error"].map((item) => <option value={item} key={item}>{item}</option>)}
            </select>
          </label>
          <label>
            类别
            <select value={filters.category} onChange={(event) => setFilters({ ...filters, category: event.target.value })}>
              <option value="">全部</option>
              {["http", "source_import", "kb_build", "llm", "release", "mcp", "db", "system"].map((item) => <option value={item} key={item}>{item}</option>)}
            </select>
          </label>
          <label>
            状态
            <select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}>
              <option value="">全部</option>
              {["started", "completed", "failed", "event"].map((item) => <option value={item} key={item}>{item}</option>)}
            </select>
          </label>
          <label>
            Trace ID
            <input value={filters.traceId} onChange={(event) => setFilters({ ...filters, traceId: event.target.value })} placeholder="trc_..." />
          </label>
          <label>
            Run ID
            <input value={filters.runId} onChange={(event) => setFilters({ ...filters, runId: event.target.value })} placeholder="run_..." />
          </label>
          <label>
            Release ID
            <input value={filters.releaseId} onChange={(event) => setFilters({ ...filters, releaseId: event.target.value })} placeholder="rel_..." />
          </label>
          <label>
            Entity ID
            <input value={filters.entityId} onChange={(event) => setFilters({ ...filters, entityId: event.target.value })} placeholder="component / package / release" />
          </label>
          <label>
            关键词
            <input value={filters.q} onChange={(event) => setFilters({ ...filters, q: event.target.value })} placeholder="错误、阶段、路径" />
          </label>
          <button type="button" onClick={() => setFilters({ level: "", category: "", status: "", traceId: "", runId: "", releaseId: "", entityId: "", q: "" })}>
            清空筛选
          </button>
        </section>

        <section className="diagnostics-list">
          <div className="detail-head">
            <div>
              <h2>日志记录</h2>
              <p>{logs.data?.length ?? 0} 条，按时间倒序</p>
            </div>
            <button type="button" className="icon-button" title="刷新" onClick={() => logs.refetch()}>
              <RefreshCw size={16} />
            </button>
          </div>
          <div className="log-list">
            {(logs.data ?? []).map((log) => (
              <button
                type="button"
                className={selectedTraceId === log.traceId ? "log-row active" : "log-row"}
                key={log.logId}
                onClick={() => applyTrace(log.traceId)}
              >
                <span className="log-row-top">
                  <Badge label={log.level} tone={log.level === "error" ? "hot" : log.level === "warn" ? "warn" : "ok"} />
                  <Badge label={log.category} />
                  <strong>{log.message}</strong>
                  <small>{formatTime(log.createdAt)}</small>
                </span>
                <span className="log-row-meta">
                  <code>{log.traceId}</code>
                  {log.runId && <code>{log.runId}</code>}
                  {log.releaseId && <code>{log.releaseId}</code>}
                  {log.durationMs !== null && <span>{log.durationMs}ms</span>}
                </span>
                {log.errorMessage && <span className="log-error">{log.errorMessage}</span>}
              </button>
            ))}
            {(logs.data ?? []).length === 0 && <EmptyWork title="没有匹配日志" body="调整筛选条件或触发一次导入、构建、发布、MCP 查询。" />}
          </div>
        </section>

        <section className="diagnostics-trace">
          <div className="detail-head">
            <div>
              <h2>Trace 时间线</h2>
              <p>{selectedTraceId || "选择一条日志查看完整链路"}</p>
            </div>
            {selectedTraceId && <button type="button" onClick={() => navigator.clipboard?.writeText(selectedTraceId)}>复制 trace</button>}
          </div>
          <div className="trace-timeline">
            {(trace.data ?? []).map((log) => (
              <article className={`trace-step ${log.status}`} key={log.logId}>
                <div>
                  <Badge label={log.status} tone={log.status === "failed" ? "hot" : log.level === "warn" ? "warn" : "ok"} />
                  <strong>{log.message}</strong>
                  <span>{log.durationMs !== null ? `${log.durationMs}ms` : formatTime(log.createdAt)}</span>
                </div>
                <code>{log.spanId}</code>
                {(log.runId || log.releaseId || log.entityId) && (
                  <small>{[log.runId, log.releaseId, log.entityId].filter(Boolean).join(" / ")}</small>
                )}
                {log.errorStack && <pre>{log.errorStack}</pre>}
              </article>
            ))}
            {selectedTraceId && trace.isLoading && <Loading title="正在读取 trace" />}
            {!selectedTraceId && selectedLog && (
              <article className="trace-step event">
                <div>
                  <Badge label={selectedLog.status} />
                  <strong>{selectedLog.message}</strong>
                </div>
                <pre>{JSON.stringify({ context: selectedLog.context, requestPayload: selectedLog.requestPayload }, null, 2)}</pre>
              </article>
            )}
          </div>
        </section>
      </div>
    </Page>
  );
}
