import { useQuery } from "@tanstack/react-query";

import { getDashboard } from "../api";
import { Badge, ErrorState, Loading, Metric, Page } from "../components/Atoms";
import { formatCounts, formatPercent } from "../utils/format";

export function Dashboard() {
  const { data, isLoading, error } = useQuery({ queryKey: ["dashboard"], queryFn: getDashboard });
  if (isLoading) return <Loading title="正在读取知识库健康度" />;
  if (error || !data) return <ErrorState error={error} />;

  return (
    <Page title="知识库进化飞轮" subtitle="从资料进入到 Agent 反馈，所有资产都保留来源、版本、质量与追溯。">
      <div className="metrics">
        <Metric label="资料版本" value={data.sources.versions} hint={data.sources.latest ? `最新 ${data.sources.latest.label}` : "尚未导入"} />
        <Metric label="知识资产包" value={data.packages.total} hint={formatCounts(data.packages.byStatus)} />
        <Metric label="待修问题" value={data.review.open} hint={`${data.review.blocking} 个阻断`} tone={data.review.blocking > 0 ? "hot" : "ok"} />
        <Metric label="Agent 查询" value={data.agent.recentQueries} hint={`${data.agent.misses} 次未命中`} tone={data.agent.misses > 0 ? "warn" : "ok"} />
        <Metric label="证据覆盖" value={formatPercent(data.evidence.coverageRate)} hint={`${data.evidence.coveredComponents}/${data.evidence.totalComponents} 个组件`} tone={data.evidence.missingComponents > 0 ? "warn" : "ok"} />
      </div>
      <section className="flow">
        {["资料进入", "生成资产包", "审核证据和结构", "质量门禁", "发布给 Agent", "反馈修订"].map((step, index) => (
          <div className="flow-step" key={step}>
            <span>{index + 1}</span>
            <strong>{step}</strong>
          </div>
        ))}
      </section>
      <section className="band">
        <h2>当前发布</h2>
        {data.release.current ? (
          <div className="release-line">
            <strong>{data.release.current.version}</strong>
            <span>{data.release.current.releaseId}</span>
            <Badge label={String(data.release.current.qualityGate.status ?? "unknown")} />
          </div>
        ) : (
          <p>还没有 published release。</p>
        )}
      </section>
    </Page>
  );
}
