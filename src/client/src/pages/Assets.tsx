import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { getPackage, listPackages, type AssetPackage } from "../api";
import { Badge, Metric, Page } from "../components/Atoms";
import { formatPercent, groupBy, groupLabel } from "../utils/format";

export function Assets({ highlightedPackage, onConsumeHighlight }: { highlightedPackage: string | null; onConsumeHighlight: () => void }) {
  const [selected, setSelected] = useState<string>("");
  const packages = useQuery({ queryKey: ["packages"], queryFn: listPackages });

  useEffect(() => {
    if (highlightedPackage) {
      setSelected(highlightedPackage);
      onConsumeHighlight();
    }
  }, [highlightedPackage, onConsumeHighlight]);

  const effectiveSelected = selected || packages.data?.[0]?.packageId || "";
  const detail = useQuery({
    queryKey: ["package", effectiveSelected],
    queryFn: () => getPackage(effectiveSelected),
    enabled: Boolean(effectiveSelected)
  });
  const byGroup = useMemo(() => groupBy(detail.data?.components ?? [], (component) => component.group), [detail.data]);
  const evidenceByComponent = useMemo(() => groupBy(detail.data?.evidenceRecords ?? [], (record) => record.componentId), [detail.data]);

  return (
    <Page title="知识资产" subtitle="资产包保留 Wiki、Index、Graph、表结构、证据和质量报告之间的关系。">
      <div className="package-grid">
        <section className="package-list">
          {(packages.data ?? []).map((pkg: AssetPackage) => (
            <button
              key={pkg.packageId}
              className={effectiveSelected === pkg.packageId ? "package-row selected" : "package-row"}
              onClick={() => setSelected(pkg.packageId)}
            >
              <strong>{pkg.name}</strong>
              <span>{pkg.description}</span>
              <small>{pkg.packageId}</small>
            </button>
          ))}
        </section>
        <section className="package-detail">
          {detail.data && (
            <>
              <div className="detail-head">
                <div>
                  <h2>{detail.data.package.name}</h2>
                  <p>{detail.data.package.description}</p>
                </div>
                <Badge label={detail.data.package.status} />
              </div>
              <div className="evidence-panel">
                <Metric
                  label="证据覆盖"
                  value={formatPercent(detail.data.evidenceCoverage.coverageRate)}
                  hint={`${detail.data.evidenceCoverage.coveredComponents}/${detail.data.evidenceCoverage.totalComponents} 个组件`}
                  tone={detail.data.evidenceCoverage.missingComponents > 0 ? "warn" : "ok"}
                />
                <Metric label="证据记录" value={detail.data.evidenceCoverage.evidenceRecords} hint="可追溯 source version" />
                <Metric label="待补证据" value={detail.data.evidenceCoverage.missingComponents} hint="优先进入审核中心" tone={detail.data.evidenceCoverage.missingComponents > 0 ? "warn" : "ok"} />
              </div>
              {Object.entries(byGroup).map(([group, components]) => (
                <div className="asset-group" key={group}>
                  <h3>{groupLabel(group)}</h3>
                  <div className="asset-list">
                    {components.map((component) => (
                      <article className="asset-item" key={component.componentId}>
                        <div>
                          <strong>{component.title}</strong>
                          <span>{component.kind} · {component.legacyPath}</span>
                        </div>
                        <div className="asset-meta">
                          <code>{component.artifactId}</code>
                          <span className={evidenceByComponent[component.componentId]?.length ? "evidence-chip ok" : "evidence-chip"}>
                            {evidenceByComponent[component.componentId]?.length ?? 0} 条证据
                          </span>
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
              ))}
            </>
          )}
        </section>
      </div>
    </Page>
  );
}
