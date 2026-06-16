import { Play } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { listAgentEvents, listMcpAudit, listOutputAudits, simulateMcpQuery, type KnowledgeEnvelope } from "../api";
import { Badge, ErrorState, Loading, Metric, Page } from "../components/Atoms";

const MCP_TOOLS = [
  "kb_search",
  "kb_resolve_topic",
  "kb_get_page",
  "kb_get_section",
  "kb_list_pages",
  "kb_get_page_tables",
  "kb_get_entity",
  "kb_get_neighbors",
  "kb_list_entities",
  "kb_get_relations",
  "kb_list_tables",
  "kb_get_table_schema",
  "kb_query_table",
  "kb_validate_table",
  "kb_check_table_value",
  "kb_get_quality",
  "kb_get_evidence",
  "kb_get_release"
];

export function AgentFeedback() {
  const queryClient = useQueryClient();
  const [toolName, setToolName] = useState("kb_search");
  const [payload, setPayload] = useState('{\n  "query": "Battle System"\n}');
  const [envelope, setEnvelope] = useState<KnowledgeEnvelope | null>(null);
  const events = useQuery({ queryKey: ["agent-events"], queryFn: listAgentEvents });
  const audit = useQuery({ queryKey: ["mcp-audit"], queryFn: listMcpAudit });
  const outputAudits = useQuery({ queryKey: ["output-audits"], queryFn: listOutputAudits });
  const simulate = useMutation({
    mutationFn: async () => simulateMcpQuery(toolName, JSON.parse(payload) as Record<string, unknown>),
    onSuccess: async (result) => {
      setEnvelope(result);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["agent-events"] }),
        queryClient.invalidateQueries({ queryKey: ["mcp-audit"] }),
        queryClient.invalidateQueries({ queryKey: ["review"] })
      ]);
    }
  });
  if (events.isLoading || audit.isLoading || outputAudits.isLoading) return <Loading title="正在读取 MCP 控制台" />;
  if (events.error || audit.error || outputAudits.error) return <ErrorState error={events.error ?? audit.error ?? outputAudits.error} />;
  const configSnippet = {
    mcpServers: {
      "knowledge-hub": {
        command: "npm",
        args: ["run", "mcp:stdio"],
        cwd: "D:/knowledge-hub"
      }
    }
  };
  return (
    <Page title="MCP 控制台" subtitle="Agent 通过 Knowledge MCP 只读 current release；审计和反馈会回流为维护任务。">
      <div className="mcp-console">
        <section className="mcp-panel">
          <div className="detail-head">
            <div>
              <h2>启动命令</h2>
              <p>在支持 MCP stdio 的 Agent 客户端里使用 OpenAI-compatible 风格的工具调用配置。</p>
            </div>
            <Badge label="stdio" />
          </div>
          <code className="code-block">npm run mcp:stdio</code>
          <textarea className="code-editor small" value={JSON.stringify(configSnippet, null, 2)} readOnly />
        </section>

        <section className="mcp-panel">
          <div className="detail-head">
            <div>
              <h2>模拟查询</h2>
              <p>调用与 MCP 同源的 QueryService，便于桌面端验证 envelope、trace 和质量 flags。</p>
            </div>
            <Badge label={toolName} tone="ok" />
          </div>
          <div className="model-grid">
            <label className="field-label">
              Tool
              <select value={toolName} onChange={(event) => setToolName(event.target.value)}>
                {MCP_TOOLS.map((tool) => <option key={tool} value={tool}>{tool}</option>)}
              </select>
            </label>
            <label className="field-label model-secret">
              Payload JSON
              <textarea className="code-editor small" value={payload} onChange={(event) => setPayload(event.target.value)} spellCheck={false} />
            </label>
          </div>
          <button className="primary-action" disabled={simulate.isPending} onClick={() => simulate.mutate()}>
            <Play size={16} />
            {simulate.isPending ? "查询中..." : "运行模拟查询"}
          </button>
          {simulate.error && <p className="error">{simulate.error instanceof Error ? simulate.error.message : String(simulate.error)}</p>}
          {envelope && (
            <div className="envelope-view">
              <div className="metrics compact">
                <Metric label="Release" value={envelope.release.version} hint={envelope.release.releaseId} />
                <Metric label="组件命中" value={envelope.trace.componentIds.length} hint={envelope.trace.componentIds.join(", ") || "none"} />
                <Metric label="质量 flags" value={envelope.qualityFlags.length} hint={envelope.qualityFlags.join(", ") || "clean"} tone={envelope.qualityFlags.length ? "warn" : "ok"} />
              </div>
              <pre>{JSON.stringify(envelope, null, 2)}</pre>
            </div>
          )}
        </section>

        <section className="mcp-panel">
          <h2>查询审计</h2>
          <div className="event-list">
            {(audit.data ?? []).map((record) => (
              <article className="event" key={record.auditId}>
                <Badge label={record.status} tone={record.status === "miss" || record.status === "error" ? "hot" : "ok"} />
                <div>
                  <strong>{record.toolName}</strong>
                  <span>{record.hitComponentIds.length ? `命中 ${record.hitComponentIds.join(", ")}` : "无命中组件"} · {record.latencyMs} ms</span>
                </div>
                <small>{record.createdAt}</small>
              </article>
            ))}
          </div>
        </section>

        <section className="mcp-panel">
          <h2>反馈回流</h2>
          <div className="event-list">
            {(events.data ?? []).map((event) => (
              <article className="event" key={event.eventId}>
                <Badge label={event.feedbackType || event.status} tone={event.status === "miss" ? "hot" : event.qualityFlags.length ? "warn" : "ok"} />
                <div>
                  <strong>{event.query}</strong>
                  <span>{event.hitComponentIds.length ? `命中 ${event.hitComponentIds.join(", ")}` : "未命中任何资产"}</span>
                  {event.suggestedAction && <small>{event.suggestedAction}</small>}
                </div>
                <small>{event.taskId || event.createdAt}</small>
              </article>
            ))}
          </div>
        </section>

        <section className="mcp-panel">
          <h2>输出归因审计</h2>
          <div className="event-list">
            {(outputAudits.data ?? []).map((auditRecord) => (
              <article className="event" key={auditRecord.auditId}>
                <Badge label={`${auditRecord.segments.length} 段`} tone={auditRecord.segments.some((segment) => segment.attributionType === "创作" || segment.attributionType === "无法判断") ? "warn" : "ok"} />
                <div>
                  <strong>{auditRecord.title}</strong>
                  <span>{auditRecord.releaseId}</span>
                  <small>
                    {auditRecord.segments.map((segment) => `${segment.segmentId}:${segment.attributionType}`).join(" / ")}
                  </small>
                </div>
                <small>{auditRecord.createdAt}</small>
              </article>
            ))}
          </div>
        </section>
      </div>
    </Page>
  );
}
