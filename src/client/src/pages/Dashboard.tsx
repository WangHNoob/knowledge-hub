import { ArrowRight, Boxes, Database, PackagePlus, Telescope } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { getDashboard } from "../api";
import { formatPercent, formatTime } from "../utils/format";
import { useNav } from "../ui/navigation";

/**
 * 概览：一屏看清知识资产、当前发布与 Agent 消费情况。
 * 数据来自 /api/dashboard 汇总（getDashboard）。
 */
export function Dashboard() {
  const { navigate } = useNav();
  const data = useQuery({
    queryKey: ["dashboard", "default_project"],
    queryFn: () => getDashboard("default_project"),
    refetchInterval: 15000,
  });

  if (data.isLoading) return <div className="state">正在加载概览...</div>;
  if (data.isError || !data.data) return <div className="state error">概览加载失败，请刷新重试。</div>;
  const d = data.data;
  const release = d.release.current;

  const cards: Array<{ id: "sources" | "buildrelease" | "assets"; title: string; value: string; hint: string }> = [
    { id: "sources", title: "资料库", value: `${d.sources.bundles} 个资料库 / ${d.sources.versions} 个版本`, hint: d.sources.latest ? `最新导入 ${formatTime(d.sources.latest.createdAt)}` : "尚未导入资料" },
    { id: "buildrelease", title: "知识构建", value: `${d.packages.total} 知识包 / ${d.components.total} 组件`, hint: `当前发布 ${release ? release.version : "未发布"}` },
    { id: "assets", title: "知识浏览", value: `${d.components.total} 个组件`, hint: `证据覆盖 ${formatPercent(d.evidence.coverageRate)}` },
  ];

  return (
    <div className="workbench">
      <header className="workbench-head">
        <div>
          <h1>概览</h1>
          <p>知识库运行状态与 Agent 消费情况一览</p>
        </div>
      </header>

      <section className="metric-row">
        <div className="metric-card">
          <span className="metric-label">当前发布</span>
          <strong className="metric-value">{release ? release.version : "未发布"}</strong>
          <small className="metric-hint">{release ? `发布于 ${formatTime(release.createdAt)}` : "构建并发布后 Agent 即可查询"}</small>
        </div>
        <div className="metric-card">
          <span className="metric-label">Agent 近期查询</span>
          <strong className="metric-value">{d.agent.recentQueries}</strong>
          <small className="metric-hint">未命中 {d.agent.misses} · 低质命中 {d.agent.lowQualityHits}</small>
        </div>
        <div className="metric-card">
          <span className="metric-label">证据覆盖</span>
          <strong className="metric-value">{formatPercent(d.evidence.coverageRate)}</strong>
          <small className="metric-hint">{d.evidence.coveredComponents}/{d.evidence.totalComponents} 组件有证据</small>
        </div>
        <div className="metric-card">
          <span className="metric-label">待处理任务</span>
          <strong className="metric-value">{d.review.open}</strong>
          <small className="metric-hint">其中阻塞级 {d.review.blocking}</small>
        </div>
      </section>

      <section className="quick-links">
        {cards.map((card) => (
          <button key={card.id} className="quick-link" onClick={() => navigate(card.id)}>
            <div className="quick-link-icon">
              {card.id === "sources" ? <Database size={18} /> : card.id === "buildrelease" ? <PackagePlus size={18} /> : <Boxes size={18} />}
            </div>
            <div className="quick-link-body">
              <strong>{card.title}</strong>
              <span>{card.value}</span>
              <small>{card.hint}</small>
            </div>
            <ArrowRight size={16} />
          </button>
        ))}
      </section>

      <footer className="dash-foot">
        <Telescope size={14} />
        <span>Agent 通过 MCP 协议（kb_* 工具）查询本知识库，全部回答携带出处与可信度。</span>
      </footer>
    </div>
  );
}
