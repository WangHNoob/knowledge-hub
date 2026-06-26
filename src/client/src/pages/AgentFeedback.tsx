import { Play } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { listAgentEvents, listMcpAudit, listOutputAudits, simulateMcpQuery, type AgentEvent, type KnowledgeEnvelope } from "../api";
import { Badge, ErrorState, Loading, Metric, Page, Tabs } from "../components/Atoms";
import { insightFromEvent, type FeedbackInsight } from "../utils/feedback";
import { formatPercent, formatTime } from "../utils/format";
import { TRUST_DIMENSIONS, trustLabel, trustStatusLabel, trustTone } from "../utils/trust";
import { IdChip, useNav } from "../ui/navigation";

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

type AgentTab = "connect" | "simulate" | "audit" | "feedback" | "attribution";

export function AgentFeedback() {
  const { navigate, params } = useNav();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<AgentTab>("simulate");
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
  useEffect(() => {
    if (!params.toolName && !params.query) return;
    if (params.toolName) setToolName(params.toolName);
    if (params.query) setPayload(JSON.stringify({ query: params.query }, null, 2));
    setTab("simulate");
  }, [params.toolName, params.query]);

  const retest = (insight: FeedbackInsight) => {
    setToolName(insight.toolName || "kb_search");
    setPayload(JSON.stringify({ query: insight.queryText }, null, 2));
    setTab("simulate");
  };
  const eventRows = events.data ?? [];
  const pressureRows = useMemo(() => buildFeedbackPressure(eventRows), [eventRows]);
  const rebuildCandidates = pressureRows.filter((row) => row.negativeCount >= 2).length;
  if (events.isLoading || audit.isLoading || outputAudits.isLoading) return <Loading title="正在读取 MCP 控制台" />;
  if (events.error || audit.error || outputAudits.error) return <ErrorState error={events.error ?? audit.error ?? outputAudits.error} />;
  const auditRows = audit.data ?? [];
  const missCount = eventRows.filter((event) => event.status === "miss").length;
  const flaggedCount = eventRows.filter((event) => event.qualityFlags.length > 0).length;
  const latestFlag = eventRows.find((event) => event.qualityFlags.length > 0)?.qualityFlags[0] ?? "";
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
      <Tabs
        active={tab}
        onChange={setTab}
        items={[
          { id: "connect", label: "连接配置" },
          { id: "simulate", label: "模拟查询" },
          { id: "audit", label: "查询审计", count: audit.data?.length },
          { id: "feedback", label: "反馈回流", count: events.data?.length },
          { id: "attribution", label: "归因审计", count: outputAudits.data?.length }
        ]}
      />
      <section className="agent-flow">
        <div className="metrics compact">
          <Metric label="查询审计" value={auditRows.length} hint="最近 100 条" />
          <Metric label="未命中" value={missCount} hint="会生成补资产任务" tone={missCount ? "hot" : "ok"} />
          <Metric label="质量反馈" value={flaggedCount} hint={latestFlag || "clean"} tone={flaggedCount ? "warn" : "ok"} />
          <Metric label="重建候选" value={rebuildCandidates} hint="负反馈 >= 2" tone={rebuildCandidates ? "warn" : "ok"} />
        </div>
        <div className="flow-cards">
          <button type="button" className="flow-card" onClick={() => setTab("simulate")}>
            <strong>1. 模拟消费</strong>
            <span>选择 MCP 工具并运行查询，生成 hit/miss、trace 和 quality flags。</span>
          </button>
          <button type="button" className="flow-card" onClick={() => setTab("feedback")}>
            <strong>2. 查看回流</strong>
            <span>miss 或低质量命中会沉淀为反馈记录，并同步进入审核中心。</span>
          </button>
          <button type="button" className="flow-card" onClick={() => navigate("review")}>
            <strong>3. 处理任务</strong>
            <span>回到审核中心处理证据、质量或缺资产问题，再重新发布验证。</span>
          </button>
        </div>
      </section>
      <div className="mcp-console" key={tab}>
        {tab === "connect" && (
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
        )}

        {tab === "simulate" && (
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
                  <Metric
                    label="平均可信度"
                    value={envelope.trust.averageScore === null ? "n/a" : formatPercent(envelope.trust.averageScore)}
                    hint={envelope.trust.minScore === null ? "无命中组件" : `最低 ${formatPercent(envelope.trust.minScore)}`}
                    tone={envelope.trust.minScore !== null && envelope.trust.minScore < 0.7 ? "warn" : "ok"}
                  />
                  <Metric label="质量 flags" value={envelope.qualityFlags.length} hint={envelope.qualityFlags.join(", ") || "clean"} tone={envelope.qualityFlags.length ? "warn" : "ok"} />
                </div>
                {envelope.trust.components.length > 0 && (
                  <div className="trust-stack">
                    {envelope.trust.components.map((component) => (
                      <TrustPanel
                        key={component.componentId}
                        title={component.title || component.artifactId}
                        subtitle={component.artifactId}
                        trust={component.trust}
                        onClick={() => navigate("assets", { componentId: component.componentId })}
                      />
                    ))}
                  </div>
                )}
                <div className="agent-diagnosis">
                  {diagnosisForEnvelope(envelope).map((item) => (
                    <div className="diagnosis-item" key={item.title}>
                      <strong>{item.title}</strong>
                      <span>{item.body}</span>
                    </div>
                  ))}
                  {envelope.trace.componentIds.length > 0 && (
                    <div className="asset-link">
                      {envelope.trace.componentIds.map((componentId) => (
                        <IdChip key={componentId} label={componentId} title="在知识资产中定位该组件" onClick={() => navigate("assets", { componentId })} />
                      ))}
                    </div>
                  )}
                </div>
                <pre>{JSON.stringify(envelope, null, 2)}</pre>
              </div>
            )}
          </section>
        )}

        {tab === "audit" && (
          <section className="mcp-panel">
            <h2>查询审计</h2>
            <div className="event-list">
              {(audit.data ?? []).map((record) => (
                <article className="event" key={record.auditId}>
                  <Badge label={record.status} tone={record.status === "miss" || record.status === "error" ? "hot" : "ok"} />
                  <div>
                    <strong>{record.toolName}</strong>
                    <span>{record.hitComponentIds.length ? "命中组件：" : "无命中组件"} · {record.latencyMs} ms</span>
                    {record.hitComponentIds.length > 0 && (
                      <div className="asset-link">
                        {record.hitComponentIds.map((componentId) => (
                          <IdChip key={componentId} label={componentId} title="在知识资产中定位该组件" onClick={() => navigate("assets", { componentId })} />
                        ))}
                      </div>
                    )}
                  </div>
                  <small>{formatTime(record.createdAt)}</small>
                </article>
              ))}
              {(audit.data ?? []).length === 0 && <p className="subtle">暂无查询审计记录。</p>}
            </div>
          </section>
        )}

        {tab === "feedback" && (
          <section className="mcp-panel">
            <h2>反馈回流</h2>
            {pressureRows.length > 0 && (
              <div className="feedback-pressure-grid">
                {pressureRows.slice(0, 6).map((row) => (
                  <button key={row.componentId} type="button" className="feedback-pressure" onClick={() => navigate("assets", { componentId: row.componentId })}>
                    <span>
                      <strong>{row.title}</strong>
                      <code>{row.componentId}</code>
                    </span>
                    <span className="component-quality">
                      <Badge label={`${row.negativeCount} 次负反馈`} tone={row.negativeCount >= 2 ? "warn" : "ok"} />
                      {row.negativeCount >= 2 && <Badge label="建议重建" tone="hot" />}
                    </span>
                  </button>
                ))}
              </div>
            )}
            <div className="event-list">
              {(events.data ?? []).map((event) => (
                <AgentFeedbackCard
                  key={event.eventId}
                  event={event}
                  onRetest={retest}
                  onNavigateReview={() => navigate("review")}
                  onNavigateAsset={(componentId) => navigate("assets", { componentId })}
                />
              ))}
              {(events.data ?? []).length === 0 && <p className="subtle">暂无反馈记录。</p>}
            </div>
          </section>
        )}

        {tab === "attribution" && (
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
                  <small>{formatTime(auditRecord.createdAt)}</small>
                </article>
              ))}
              {(outputAudits.data ?? []).length === 0 && <p className="subtle">暂无归因审计记录。</p>}
            </div>
          </section>
        )}
      </div>
    </Page>
  );
}

function buildFeedbackPressure(events: AgentEvent[]): Array<{ componentId: string; title: string; negativeCount: number }> {
  const rows = new Map<string, { componentId: string; title: string; negativeCount: number }>();
  for (const event of events) {
    const negative = event.status === "miss" || event.feedbackType !== "hit" || event.qualityFlags.length > 0;
    if (!negative) continue;
    const componentIds = event.components.length
      ? event.components.map((component) => component.componentId)
      : event.hitComponentIds;
    for (const componentId of componentIds) {
      const component = event.components.find((item) => item.componentId === componentId);
      const current = rows.get(componentId) ?? { componentId, title: component?.title || componentId, negativeCount: 0 };
      current.negativeCount += 1;
      if (component?.title) current.title = component.title;
      rows.set(componentId, current);
    }
  }
  return [...rows.values()].sort((a, b) => b.negativeCount - a.negativeCount || a.title.localeCompare(b.title));
}

function diagnosisForEnvelope(envelope: KnowledgeEnvelope): Array<{ title: string; body: string }> {
  const items: Array<{ title: string; body: string }> = [];
  if (envelope.trace.componentIds.length === 0) {
    items.push({ title: "未命中资产", body: "这会形成 miss 反馈；下一步是在审核中心补候选资产或扩展索引词。" });
  } else {
    items.push({ title: "已命中资产", body: "trace 中的组件就是 Agent 实际消费的知识入口，可直接跳到资产详情复核来源。" });
  }
  if (envelope.qualityFlags.some((flag) => flag.startsWith("evidence_missing:"))) {
    items.push({ title: "证据缺失", body: "优先补证据记录或重新构建；发布 OKF 的引用覆盖会随之改善。" });
  }
  if (envelope.qualityFlags.some((flag) => flag.startsWith("low_quality:") || flag.startsWith("low_trust:"))) {
    items.push({ title: "低可信命中", body: "命中内容 Trust Score 偏低；查看证据、全面性、审计时效和一致性后再决定是否消费。" });
  }
  if (envelope.qualityFlags.length === 0 && envelope.trace.componentIds.length > 0) {
    items.push({ title: "可用结果", body: "当前命中没有质量 flags，可以作为一次飞轮闭环通过样例。" });
  }
  return items;
}

function AgentFeedbackCard({
  event,
  onRetest,
  onNavigateReview,
  onNavigateAsset,
}: {
  event: AgentEvent;
  onRetest: (insight: FeedbackInsight) => void;
  onNavigateReview: () => void;
  onNavigateAsset: (componentId: string) => void;
}) {
  const insight = insightFromEvent(event);
  return (
    <article className="event actionable-event">
      <Badge label={event.feedbackType || event.status} tone={event.status === "miss" ? "hot" : event.qualityFlags.length ? "warn" : "ok"} />
      <div>
        <div className="task-title-row">
          <strong>{insight.headline}</strong>
          <Badge label={event.status === "miss" ? "未命中" : "已命中"} tone={event.status === "miss" ? "hot" : "ok"} />
        </div>
        <div className="feedback-brief">
          <div>
            <span>影响</span>
            <strong>{insight.impact}</strong>
          </div>
          <div>
            <span>下一步</span>
            <strong>{insight.nextStep}</strong>
          </div>
          <div>
            <span>审核任务</span>
            <strong>{event.taskId || "未生成任务"}</strong>
          </div>
        </div>
        {insight.componentIds.length > 0 && (
          <div className="asset-link">
            {insight.componentIds.map((componentId) => (
              <IdChip key={componentId} label={componentId} title="在知识资产中定位该组件" onClick={() => onNavigateAsset(componentId)} />
            ))}
          </div>
        )}
        {event.components.length > 0 && (
          <div className="feedback-components">
            {event.components.map((component) => (
              <button
                key={component.componentId}
                type="button"
                className="feedback-component"
                onClick={() => onNavigateAsset(component.componentId)}
              >
                <span>
                  <strong>{component.title}</strong>
                  <code>{component.artifactId}</code>
                </span>
                <span className="component-quality">
                  <Badge label={component.kind} />
                  <Badge
                    label={trustLabel(component.trust)}
                    tone={trustTone(component.trust)}
                  />
                  <Badge label={`证据 ${component.evidenceRecords}`} tone={component.evidenceRecords > 0 ? "ok" : "warn"} />
                </span>
                {component.trust && <TrustBreakdown trust={component.trust} />}
              </button>
            ))}
          </div>
        )}
        <div className="task-primary-actions">
          <button className="secondary-action" type="button" onClick={() => onRetest(insight)}>复测此查询</button>
          <button className="secondary-action" type="button" onClick={onNavigateReview}>去审核中心处理</button>
          {insight.componentIds[0] && <button className="secondary-action" type="button" onClick={() => onNavigateAsset(insight.componentIds[0])}>查看首个命中资产</button>}
        </div>
      </div>
      <small>{formatTime(event.createdAt)}</small>
    </article>
  );
}

function TrustPanel({ title, subtitle, trust, onClick }: { title: string; subtitle: string; trust: AgentEvent["components"][number]["trust"]; onClick?: () => void }) {
  return (
    <button type="button" className="trust-panel" onClick={onClick}>
      <span>
        <strong>{title}</strong>
        <code>{subtitle}</code>
      </span>
      <span className="trust-panel-score">
        <Badge label={trustLabel(trust)} tone={trustTone(trust)} />
        {trust && <Badge label={trustStatusLabel(trust.status)} tone={trustTone(trust)} />}
      </span>
      {trust && <TrustBreakdown trust={trust} />}
      {trust?.caps.length ? <small>封顶：{trust.caps.map((cap) => cap.label).join(" / ")}</small> : null}
    </button>
  );
}

function TrustBreakdown({ trust }: { trust: NonNullable<AgentEvent["components"][number]["trust"]> }) {
  return (
    <span className="trust-breakdown">
      {TRUST_DIMENSIONS.map((dimension) => (
        <span key={dimension.key}>
          <b>{dimension.label}</b>
          <i>{formatPercent(trust.breakdown[dimension.key])}</i>
        </span>
      ))}
    </span>
  );
}
