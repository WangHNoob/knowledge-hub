import { Boxes, Braces, FileText, Gauge, LayoutDashboard, ListChecks, Plus, Save, Share2, ShieldAlert, ShieldCheck, Table, Trash2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { activateLegislationProfile, createAnnotationExampleReviewTask, createLegislationProfile, getLegislationProfile, getTrustPolicy, listAnnotationExamples, setAnnotationExampleActive } from "../api";
import type { AnnotationExample, KnowledgeRuleConfig, RelationTypeSpec, TrustPolicy } from "../api/types";
import { Badge, ErrorState, Loading, Metric, Page, Tabs, type TabItem } from "../components/Atoms";
import { formatPercent, formatTime } from "../utils/format";
import { useNav } from "../ui/navigation";
import {
  addDocumentType,
  addEntityType,
  addPageType,
  addQualityRule,
  addRelationType,
  createRuleDraft,
  removeDocumentType,
  removeEntityType,
  removePageType,
  removeQualityRule,
  removeRelationType,
  setDocumentTypeTags,
  setPageTypeTags,
  updateDocumentType,
  updateEntityType,
  updateGovernanceRule,
  updateGovernanceTags,
  updatePageType,
  updateQualityRule,
  updateRelationType,
  updateTableRuleTags
} from "./legislationEditor";

type LegislationTab = "governance" | "documents" | "entities" | "relations" | "tables" | "quality" | "trust" | "annotations" | "overview" | "advanced";

export function Legislation() {
  const { navigate } = useNav();
  const queryClient = useQueryClient();
  const profiles = useQuery({ queryKey: ["legislation-profile"], queryFn: getLegislationProfile });
  const trustPolicy = useQuery({ queryKey: ["trust-policy"], queryFn: getTrustPolicy });
  const annotationExamples = useQuery({ queryKey: ["annotation-examples"], queryFn: listAnnotationExamples });
  const [tab, setTab] = useState<LegislationTab>("governance");
  const [name, setName] = useState("策划立法规则");
  const [activate, setActivate] = useState(true);
  const [config, setConfig] = useState<KnowledgeRuleConfig | null>(null);
  const [jsonText, setJsonText] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (profiles.data?.profile) {
      const draft = createRuleDraft(profiles.data.profile.config);
      setName(`${profiles.data.profile.name} copy`);
      setConfig(draft);
      setJsonText(JSON.stringify(draft, null, 2));
    }
  }, [profiles.data?.profile]);

  useEffect(() => {
    if (config) setJsonText(JSON.stringify(config, null, 2));
  }, [config]);

  const save = useMutation({
    mutationFn: async () => {
      if (!config) throw new Error("规则配置尚未加载。");
      return createLegislationProfile({ name, activate, config });
    },
    onSuccess: async () => {
      setError("");
      await queryClient.invalidateQueries({ queryKey: ["legislation-profile"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err))
  });

  const activateMutation = useMutation({
    mutationFn: activateLegislationProfile,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["legislation-profile"] });
    }
  });
  const exampleActiveMutation = useMutation({
    mutationFn: ({ exampleId, active }: { exampleId: string; active: boolean }) => setAnnotationExampleActive(exampleId, active),
    onSuccess: async () => {
      await annotationExamples.refetch();
    }
  });
  const exampleReviewMutation = useMutation({
    mutationFn: createAnnotationExampleReviewTask,
    onSuccess: async (task) => {
      await annotationExamples.refetch();
      navigate("review", { taskId: task.taskId });
    }
  });

  const applyJson = () => {
    try {
      setConfig(createRuleDraft(JSON.parse(jsonText) as KnowledgeRuleConfig));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (profiles.isLoading) return <Loading title="正在读取策划立法规则" />;
  if (profiles.error) return <ErrorState error={profiles.error} />;

  const active = profiles.data?.profile;
  const history = profiles.data?.profiles ?? [];

  const tabs: ReadonlyArray<TabItem<LegislationTab>> = [
    { id: "governance", label: "治理总则", icon: ShieldCheck },
    { id: "documents", label: "文档类型", icon: FileText, count: config ? Object.keys(config.documentTypes).length : 0 },
    { id: "entities", label: "业务对象", icon: Boxes, count: config?.entityTypes.length ?? 0 },
    { id: "relations", label: "对象关系", icon: Share2, count: config?.relationTypes.length ?? 0 },
    { id: "tables", label: "表字段", icon: Table },
    { id: "quality", label: "质量红线", icon: ShieldAlert, count: config ? Object.keys(config.qualityRules).length : 0 },
    { id: "trust", label: "可信度", icon: Gauge, count: trustPolicy.data?.dimensions.length ?? 0 },
    { id: "annotations", label: "标注样例", icon: ListChecks, count: annotationExamples.data?.filter((example) => example.active).length ?? 0 },
    { id: "overview", label: "概览 / 历史", icon: LayoutDashboard, count: history.length },
    { id: "advanced", label: "高级规则", icon: Braces }
  ];

  return (
    <Page title="策划立法" subtitle="用业务语言维护页面类型、实体关系、Wiki 标准、表字段策略和质量红线；系统负责把规则编译进构建 Pipeline。">
      {config && (
        <div className="workbench-bar">
          <div className="workbench-fields">
            <label className="field-label">
              版本名称
              <input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="field-label">
              保存动作
              <select value={activate ? "yes" : "no"} onChange={(event) => setActivate(event.target.value === "yes")}>
                <option value="yes">保存并启用</option>
                <option value="no">只保存为草稿</option>
              </select>
            </label>
          </div>
          <div className="workbench-actions">
            <Badge label={activate ? "保存并启用" : "保存草稿"} tone={activate ? "ok" : undefined} />
            <button className="primary-action" disabled={save.isPending} onClick={() => save.mutate()}>
              <Save size={16} />
              {save.isPending ? "保存中..." : "保存规则 Profile"}
            </button>
          </div>
          {error && <p className="error">{error}</p>}
        </div>
      )}

      <Tabs items={tabs} active={tab} onChange={setTab} />

      <div className="tab-panel" key={tab}>
        {!config && tab !== "overview" ? (
          <Loading title="正在加载规则草稿" />
        ) : null}

        {config && tab === "governance" && <GovernanceRuleSection config={config} onChange={setConfig} trustPolicy={trustPolicy.data ?? null} />}
        {config && tab === "documents" && <DocumentTypeSection config={config} onChange={setConfig} />}
        {config && tab === "entities" && <EntityTypeSection config={config} onChange={setConfig} />}
        {config && tab === "relations" && <RelationTypeSection config={config} onChange={setConfig} />}
        {config && tab === "tables" && <TableRuleSection config={config} onChange={setConfig} />}
        {config && tab === "quality" && <QualityRuleSection config={config} onChange={setConfig} />}
        {tab === "trust" && (
          trustPolicy.isLoading ? <Loading title="正在读取可信度规则" /> :
          trustPolicy.error ? <ErrorState error={trustPolicy.error} /> :
          trustPolicy.data ? <TrustPolicySection policy={trustPolicy.data} /> : null
        )}
        {tab === "annotations" && (
          annotationExamples.isLoading ? <Loading title="正在读取标注样例" /> :
          annotationExamples.error ? <ErrorState error={annotationExamples.error} /> :
          <AnnotationExampleSection
            examples={annotationExamples.data ?? []}
            saving={exampleActiveMutation.isPending}
            reviewing={exampleReviewMutation.isPending}
            onToggle={(example) => exampleActiveMutation.mutate({ exampleId: example.exampleId, active: !example.active })}
            onReviewExample={(example) => exampleReviewMutation.mutate(example.exampleId)}
            onNavigateReview={(taskId) => navigate("review", { taskId })}
            onNavigateAsset={(packageId, componentId) => navigate("assets", { packageId, componentId })}
            onNavigateBuild={(runId) => navigate("builder", { runId })}
          />
        )}

        {tab === "overview" && (
          <section className="legislation-workbench">
            {active ? (
              <section className="release-panel">
                <div className="detail-head">
                  <div>
                    <h2>{active.name}</h2>
                    <p>{active.profileId}</p>
                  </div>
                  <Badge label="active" tone="ok" />
                </div>
                <div className="metrics compact">
                  <Metric label="页面类型" value={Object.keys(active.config.pageTypes).length} hint="page types" />
                  <Metric label="实体类型" value={active.config.entityTypes.length} hint="entity types" />
                  <Metric label="关系类型" value={active.config.relationTypes.length} hint="relation types" />
                  <Metric label="Hash" value={active.hash.slice(0, 12)} hint={active.hash} />
                </div>
              </section>
            ) : (
              <section className="release-panel">
                <h2>尚无启用的规则</h2>
                <p>编辑左侧各页规则后保存并启用，这里会显示当前生效的 Profile 摘要。</p>
              </section>
            )}

            <section className="release-panel">
              <h2>历史版本</h2>
              <div className="event-list">
                {history.length === 0 && <p>暂无历史版本。</p>}
                {history.map((profile) => (
                  <article className="event" key={profile.profileId}>
                    <Badge label={profile.active ? "active" : "saved"} tone={profile.active ? "ok" : undefined} />
                    <div>
                      <strong>{profile.name}</strong>
                      <span>{profile.profileId}</span>
                      <small>{profile.hash}</small>
                    </div>
                    <button disabled={profile.active || activateMutation.isPending} onClick={() => activateMutation.mutate(profile.profileId)}>
                      <ShieldCheck size={14} />
                      启用
                    </button>
                  </article>
                ))}
              </div>
            </section>
          </section>
        )}

        {config && tab === "advanced" && (
          <section className="legislation-workbench">
            <PageTypeSection config={config} onChange={setConfig} />
            <section className="release-panel">
              <div className="detail-head">
                <div>
                  <h2>规则 JSON 预览 / 导入</h2>
                  <p>仅用于开发排查、跨环境复制或批量迁移。策划日常维护建议使用前面的可视化表单。</p>
                </div>
              </div>
              <textarea className="code-editor small" value={jsonText} onChange={(event) => setJsonText(event.target.value)} spellCheck={false} />
              <button className="secondary-action" type="button" onClick={applyJson}>从 JSON 覆盖当前表单</button>
            </section>
          </section>
        )}
      </div>
    </Page>
  );
}

function AnnotationExampleSection({
  examples,
  saving,
  reviewing,
  onToggle,
  onReviewExample,
  onNavigateReview,
  onNavigateAsset,
  onNavigateBuild,
}: {
  examples: AnnotationExample[];
  saving: boolean;
  reviewing: boolean;
  onToggle: (example: AnnotationExample) => void;
  onReviewExample: (example: AnnotationExample) => void;
  onNavigateReview: (taskId: string) => void;
  onNavigateAsset: (packageId: string, componentId: string) => void;
  onNavigateBuild: (runId: string) => void;
}) {
  const active = examples.filter((example) => example.active);
  const overrides = examples.filter((example) => example.active && example.applyMode === "override");
  const injected = examples.filter((example) => example.injectedBuildCount > 0);
  const reviewed = examples.filter((example) => example.lifecycle.lastReviewedAt);
  return (
    <section className="legislation-workbench">
      <section className="release-panel">
        <div className="detail-head">
          <div>
            <h2>标注样例池</h2>
            <p>人工标注沉淀为构建 prompt 样例；override 样例会作为确定性覆盖规则参与后续构建。</p>
          </div>
          <Badge label={`${active.length}/${examples.length} active`} tone={active.length ? "ok" : undefined} />
        </div>
        <div className="metrics compact">
          <Metric label="启用样例" value={active.length} hint="后续构建可注入" tone={active.length ? "ok" : undefined} />
          <Metric label="确定覆盖" value={overrides.length} hint="override active" tone={overrides.length ? "warn" : undefined} />
          <Metric label="已被注入" value={injected.length} hint="至少进入过一次 build" tone={injected.length ? "ok" : undefined} />
          <Metric label="已复盘" value={reviewed.length} hint="人工处理过复发信号" tone={reviewed.length ? "ok" : undefined} />
          <Metric label="停用样例" value={examples.length - active.length} hint="保留审计，不再注入" />
        </div>
      </section>

      <section className="release-panel">
        <div className="annotation-example-list">
          {examples.length === 0 && <p className="subtle">还没有人工标注样例。</p>}
          {examples.map((example) => (
            <article className={example.active ? "annotation-example-card" : "annotation-example-card inactive"} key={example.exampleId}>
              <div className="annotation-example-main">
                <div className="annotation-example-title">
                  <Badge label={example.applyMode} tone={example.applyMode === "override" ? "warn" : undefined} />
                  <Badge label={example.active ? "active" : "inactive"} tone={example.active ? "ok" : undefined} />
                  <strong>{example.ruleId || "annotation"}</strong>
                </div>
                <div className="annotation-example-meta">
                  <span>{example.pageType || "unknown page"}</span>
                  <span>{example.createdBy || "unknown"} · {formatTime(example.createdAt)}</span>
                  {example.contextHash && <code>{example.contextHash}</code>}
                </div>
                <div className="annotation-example-targets">
                  <button type="button" onClick={() => onNavigateAsset(example.packageId, example.componentId)}>{example.componentId}</button>
                  {example.taskId && <button type="button" onClick={() => onNavigateReview(example.taskId)}>{example.taskId}</button>}
                  {example.lastInjectedRunId && <button type="button" onClick={() => onNavigateBuild(example.lastInjectedRunId)}>最近注入 {example.lastInjectedRunId}</button>}
                </div>
                <div className="annotation-example-values">
                  <div>
                    <b>正确值</b>
                    <code>{compactJson(example.correctValue)}</code>
                  </div>
                  <div>
                    <b>上下文</b>
                    <code>{annotationContextLabel(example.contextSnapshot)}</code>
                  </div>
                </div>
                <div className="annotation-effect">
                  <div className="annotation-effect-head">
                    <strong>效果评估</strong>
                    <Badge label={annotationEffectLabel(example.effect.status)} tone={annotationEffectTone(example.effect.status)} />
                  </div>
                  <div className="annotation-effect-grid">
                    <span><b>创建前同类</b><strong>{example.effect.tasksBefore}</strong></span>
                    <span><b>创建后复发</b><strong>{example.effect.tasksAfter}</strong></span>
                    <span><b>仍待处理</b><strong>{example.effect.openTasksAfter}</strong></span>
                    <span><b>Agent 负反馈</b><strong>{example.effect.agentNegativeAfter}</strong></span>
                  </div>
                  <small>{example.effect.summary}</small>
                  {example.effect.status === "needs_review" && (
                    <div className="annotation-effect-actions">
                      {example.effect.openTaskIds[0] ? (
                        <button className="secondary-action" type="button" onClick={() => onNavigateReview(example.effect.openTaskIds[0])}>
                          处理待处理任务
                        </button>
                      ) : example.effect.reviewTaskId ? (
                        <button className="secondary-action" type="button" onClick={() => onNavigateReview(example.effect.reviewTaskId)}>
                          查看复盘任务
                        </button>
                      ) : (
                        <button className="secondary-action" type="button" disabled={reviewing} onClick={() => onReviewExample(example)}>
                          {reviewing ? "生成中..." : "生成复盘任务"}
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <div className="annotation-lifecycle">
                  <div className="annotation-lifecycle-head">
                    <strong>生命周期</strong>
                    <Badge
                      label={example.lifecycle.lastReviewedAt ? annotationReviewActionLabel(example.lifecycle.lastReviewAction) : "未复盘"}
                      tone={example.lifecycle.writebackRequested ? "warn" : example.lifecycle.lastReviewedAt ? "ok" : undefined}
                    />
                  </div>
                  <div className="annotation-lifecycle-grid">
                    <span>
                      <b>最近复盘</b>
                      <strong>{example.lifecycle.lastReviewedAt ? formatTime(example.lifecycle.lastReviewedAt) : "尚无"}</strong>
                    </span>
                    <span>
                      <b>处理人</b>
                      <strong>{example.lifecycle.lastReviewedBy || "unknown"}</strong>
                    </span>
                    <span>
                      <b>回写</b>
                      <strong>{example.lifecycle.writebackRequested ? "已请求" : "无"}</strong>
                    </span>
                  </div>
                  <small>{example.lifecycle.summary}</small>
                  <div className="annotation-effect-actions">
                    {example.lifecycle.reviewTaskId && (
                      <button className="secondary-action" type="button" onClick={() => onNavigateReview(example.lifecycle.reviewTaskId)}>
                        查看复盘记录
                      </button>
                    )}
                    {example.lifecycle.writebackTaskId && example.lifecycle.writebackTaskId !== example.lifecycle.reviewTaskId && (
                      <button className="secondary-action" type="button" onClick={() => onNavigateReview(example.lifecycle.writebackTaskId)}>
                        查看回写任务
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <div className="annotation-example-side">
                <strong>{example.injectedBuildCount}</strong>
                <span>build 注入</span>
                {example.lastInjectedAt && <small>{formatTime(example.lastInjectedAt)}</small>}
                <button className="secondary-action" type="button" disabled={saving} onClick={() => onToggle(example)}>
                  {example.active ? "停用" : "启用"}
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </section>
  );
}

function GovernanceRuleSection({ config, onChange, trustPolicy }: EditorSectionProps & { trustPolicy: TrustPolicy | null }) {
  const rules = config.governanceRules;
  const evidencePageTypes = Object.values(config.pageTypes).filter((page) => page.evidenceRequired !== false).length;
  const publishablePageTypes = Object.values(config.pageTypes).filter((page) => page.publishable !== false).length;
  return (
    <section className="legislation-workbench">
      <section className="release-panel rule-section">
        <div className="detail-head">
          <div>
            <h2>知识治理总则</h2>
            <p>把 Schema、证据、可信度、健康检查和 Agent 消费口径统一写入规则 Profile，后续发布会记录对应 hash。</p>
          </div>
          <div className="trust-policy-badges">
            <Badge label={rules.trust.policyVersion} tone="ok" />
            <Badge label={rules.lint.failPublishOnBlocking ? "Lint 阻断发布" : "Lint 先预警"} tone={rules.lint.failPublishOnBlocking ? "hot" : "warn"} />
          </div>
        </div>
        <div className="metrics compact governance-metrics">
          <Metric label="可发布页面" value={publishablePageTypes} hint={`${Object.keys(config.pageTypes).length} 类页面`} />
          <Metric label="强证据页面" value={evidencePageTypes} hint="pageTypes evidenceRequired" tone="ok" />
          <Metric label="Lint 域" value={rules.lint.enabledDomains.length} hint={`${rules.lint.blockingDomains.length} 类可阻断`} />
          <Metric label="低可信预警" value={formatPercent(rules.trust.warnBelowScore)} hint={`阻断线 ${formatPercent(rules.trust.blockBelowScore)}`} tone="warn" />
        </div>
      </section>

      <section className="release-panel rule-section">
        <SectionHead title="OKF Schema 契约" caption="定义发布给 Agent 的 Markdown 页面最低结构要求。" />
        <div className="governance-grid">
          <SwitchField label="必须有 frontmatter" checked={rules.schema.requireFrontmatter} onChange={(checked) => onChange(updateGovernanceRule(config, "schema", { requireFrontmatter: checked }))} />
          <SwitchField label="必须有 OKF type" checked={rules.schema.requireOkfType} onChange={(checked) => onChange(updateGovernanceRule(config, "schema", { requireOkfType: checked }))} />
          <SwitchField label="必须有 description" checked={rules.schema.requireDescription} onChange={(checked) => onChange(updateGovernanceRule(config, "schema", { requireDescription: checked }))} />
          <SwitchField label="必须有 tags" checked={rules.schema.requireTags} onChange={(checked) => onChange(updateGovernanceRule(config, "schema", { requireTags: checked }))} />
          <SwitchField label="允许 Obsidian 链接" checked={rules.schema.allowObsidianLinks} onChange={(checked) => onChange(updateGovernanceRule(config, "schema", { allowObsidianLinks: checked }))} />
          <label className="field-label">
            链接规范
            <input value={rules.schema.linkMode} disabled />
          </label>
        </div>
      </section>

      <section className="release-panel rule-section">
        <SectionHead title="证据与引用规则" caption="定义哪些知识必须能追溯，缺证据时进入什么等级。" />
        <div className="rule-grid two">
          <TagField label="必须有证据的组件 kind" value={rules.evidence.requiredComponentKinds} onChange={(value) => onChange(updateGovernanceTags(config, "evidence", "requiredComponentKinds", value))} />
          <TagField label="必须有 Citations 的 OKF type" value={rules.evidence.citationRequiredOkfTypes} onChange={(value) => onChange(updateGovernanceTags(config, "evidence", "citationRequiredOkfTypes", value))} />
          <label className="field-label">
            缺证据等级
            <select value={rules.evidence.missingEvidenceSeverity} onChange={(event) => onChange(updateGovernanceRule(config, "evidence", { missingEvidenceSeverity: event.target.value as typeof rules.evidence.missingEvidenceSeverity }))}>
              <option value="blocking">阻断发布</option>
              <option value="warning">需要关注</option>
              <option value="info">仅记录</option>
            </select>
          </label>
          <SwitchField label="发布时自动补基础证据" checked={rules.evidence.autoBackfillOnPublish} onChange={(checked) => onChange(updateGovernanceRule(config, "evidence", { autoBackfillOnPublish: checked }))} />
        </div>
      </section>

      <section className="release-panel rule-section">
        <SectionHead title="可信度消费口径" caption="当前计算公式仍由系统实现；这里记录策划立法层面的阈值和发布口径。" />
        <div className="governance-score-grid">
          <NumberField label="可信阈值" value={rules.trust.trustedMinScore} onChange={(value) => onChange(updateGovernanceRule(config, "trust", { trustedMinScore: value }))} />
          <NumberField label="可用阈值" value={rules.trust.usableMinScore} onChange={(value) => onChange(updateGovernanceRule(config, "trust", { usableMinScore: value }))} />
          <NumberField label="复核阈值" value={rules.trust.reviewMinScore} onChange={(value) => onChange(updateGovernanceRule(config, "trust", { reviewMinScore: value }))} />
          <NumberField label="阻断线" value={rules.trust.blockBelowScore} onChange={(value) => onChange(updateGovernanceRule(config, "trust", { blockBelowScore: value }))} />
          <NumberField label="预警线" value={rules.trust.warnBelowScore} onChange={(value) => onChange(updateGovernanceRule(config, "trust", { warnBelowScore: value }))} />
          <SwitchField label="低可信直接阻断发布" checked={rules.trust.blockOnLowTrust} onChange={(checked) => onChange(updateGovernanceRule(config, "trust", { blockOnLowTrust: checked }))} />
        </div>
        {trustPolicy && (
          <div className="rule-hint">
            <strong>当前算法</strong>
            <span>{trustPolicy.dimensions.map((item) => `${item.label} ${formatPercent(item.weight)}`).join(" / ")}</span>
          </div>
        )}
      </section>

      <section className="release-panel rule-section">
        <SectionHead title="Knowledge Lint 与 Agent 反馈" caption="定义健康检查覆盖哪些域，以及 Agent 消费知识时必须带回哪些质量信息。" />
        <div className="rule-grid two">
          <TagField label="启用的 Lint 域" value={rules.lint.enabledDomains} onChange={(value) => onChange(updateGovernanceTags(config, "lint", "enabledDomains", value))} />
          <TagField label="可升级阻断的 Lint 域" value={rules.lint.blockingDomains} onChange={(value) => onChange(updateGovernanceTags(config, "lint", "blockingDomains", value))} />
          <SwitchField label="Lint blocking 阻断发布" checked={rules.lint.failPublishOnBlocking} onChange={(checked) => onChange(updateGovernanceRule(config, "lint", { failPublishOnBlocking: checked }))} />
          <SwitchField label="MCP 返回可信度" checked={rules.agent.includeTrustInMcp} onChange={(checked) => onChange(updateGovernanceRule(config, "agent", { includeTrustInMcp: checked }))} />
          <SwitchField label="MCP 返回证据链" checked={rules.agent.includeEvidenceInMcp} onChange={(checked) => onChange(updateGovernanceRule(config, "agent", { includeEvidenceInMcp: checked }))} />
          <SwitchField label="记录未解析查询" checked={rules.agent.recordUnresolvedQueries} onChange={(checked) => onChange(updateGovernanceRule(config, "agent", { recordUnresolvedQueries: checked }))} />
          <NumberField label="重复 miss 阻断阈值" value={rules.agent.repeatedMissBlockingThreshold} min={1} max={20} step={1} onChange={(value) => onChange(updateGovernanceRule(config, "agent", { repeatedMissBlockingThreshold: value }))} />
        </div>
      </section>
    </section>
  );
}

function TrustPolicySection({ policy }: { policy: TrustPolicy }) {
  return (
    <section className="legislation-workbench">
      <section className="release-panel rule-section">
        <div className="detail-head">
          <div>
            <h2>知识可信度规则</h2>
            <p>{policy.position}</p>
          </div>
          <div className="trust-policy-badges">
            <Badge label={policy.version} tone="ok" />
            <Badge label={policy.editable ? "可编辑" : "只读审议"} tone={policy.editable ? "warn" : undefined} />
          </div>
        </div>
        <div className="metrics compact">
          <Metric label="维度" value={policy.dimensions.length} hint="参与加权" />
          <Metric label="证据权重" value={formatPercent(policy.dimensions.find((item) => item.key === "evidence")?.weight ?? 0)} hint="追溯优先" tone="ok" />
          <Metric label="可信阈值" value={formatPercent(policy.statusBands.find((item) => item.status === "trusted")?.minScore ?? 0.85)} hint="trusted" />
          <Metric label="封顶规则" value={policy.caps.length} hint="硬性风险" tone={policy.caps.length ? "warn" : "ok"} />
        </div>
        <div className="rule-hint">
          <strong>治理口径</strong>
          <span>这套规则属于“发布知识能否被 Agent 放心消费”的立法内容。当前先随系统版本固定，避免策划误改权重导致可信度不可比；后续可以把权重和封顶提升为受控 Profile。</span>
        </div>
      </section>

      <section className="release-panel rule-section">
        <SectionHead title="分数计算" caption="最终分数 = 四个维度加权求和，再按硬性风险封顶。" />
        <div className="trust-policy-grid">
          {policy.dimensions.map((dimension) => (
            <article className="trust-policy-card" key={dimension.key}>
              <div>
                <strong>{dimension.label}</strong>
                <Badge label={formatPercent(dimension.weight)} tone={dimension.weight >= 0.3 ? "ok" : undefined} />
              </div>
              <p>{dimension.intent}</p>
              <dl>
                <dt>数据来源</dt>
                <dd>{dimension.source}</dd>
                <dt>计算方式</dt>
                <dd>{dimension.formula}</dd>
              </dl>
            </article>
          ))}
        </div>
      </section>

      <section className="release-panel rule-section">
        <SectionHead title="状态分段" caption="Agent 端会随命中知识输出 Trust Score 与状态，调用方可据此决定是否直接引用。" />
        <div className="rule-table trust-status-table">
          <div className="rule-table-row head">
            <span>状态</span>
            <span>最低分</span>
            <span>消费口径</span>
          </div>
          {policy.statusBands.map((band) => (
            <div className="rule-table-row" key={band.status}>
              <strong>{band.label}</strong>
              <span>{formatPercent(band.minScore)}</span>
              <span>{band.description}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="release-panel rule-section">
        <SectionHead title="封顶规则" caption="封顶比加权分更硬；只要触发，就算其它维度很高也不能超过对应上限。" />
        <div className="rule-table trust-cap-table">
          <div className="rule-table-row head">
            <span>规则</span>
            <span>上限</span>
            <span>触发条件</span>
          </div>
          {policy.caps.map((cap) => (
            <div className="rule-table-row" key={cap.id}>
              <strong>{cap.label}</strong>
              <span>{formatPercent(cap.maxScore)}</span>
              <span>{cap.trigger}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="release-panel rule-section">
        <SectionHead title="审计时效" caption="时效性来自飞轮审计结果，不是新导入资料天然更可信。" />
        <div className="rule-table trust-audit-table">
          <div className="rule-table-row head">
            <span>知识类型</span>
            <span>半衰期</span>
            <span>匹配规则</span>
          </div>
          {policy.auditHalfLifeDays.map((entry) => (
            <div className="rule-table-row" key={`${entry.matcher}-${entry.days}`}>
              <strong>{entry.label}</strong>
              <span>{entry.days} 天</span>
              <code>{entry.matcher}</code>
            </div>
          ))}
        </div>
      </section>
    </section>
  );
}

function compactJson(value: Record<string, unknown>): string {
  const text = JSON.stringify(value);
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function annotationContextLabel(value: Record<string, unknown>): string {
  const sourceFile = stringValue(value.sourceFile);
  const componentRef = stringValue(value.componentRef) || stringValue(value.artifactLegacyPath);
  const task = typeof value.task === "object" && value.task && !Array.isArray(value.task) ? value.task as Record<string, unknown> : {};
  const title = stringValue(task.title);
  return [sourceFile, componentRef, title].filter(Boolean).join(" · ") || compactJson(value);
}

function annotationEffectLabel(status: AnnotationExample["effect"]["status"]): string {
  if (status === "converging") return "收敛";
  if (status === "needs_review") return "需复盘";
  return "观察";
}

function annotationEffectTone(status: AnnotationExample["effect"]["status"]): "ok" | "warn" | "hot" | undefined {
  if (status === "converging") return "ok";
  if (status === "needs_review") return "hot";
  return "warn";
}

function annotationReviewActionLabel(action: string): string {
  if (action === "promote_annotation_override" || action === "revise_annotation_example") return "转 override";
  if (action === "disable_annotation_example") return "已停用";
  if (action === "keep_annotation_hint") return "保留观察";
  return action || "已复盘";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function PageTypeSection({ config, onChange }: EditorSectionProps) {
  const entries = Object.entries(config.pageTypes);
  return (
    <section className="release-panel rule-section">
      <SectionHead
        title="页面类型与 Wiki 标准"
        caption="定义哪些页面能进入正式 Wiki，以及每类页面必须写清楚什么。"
        actionLabel="新增页面类型"
        onAction={() => onChange(addPageType(config))}
      />
      <div className="rule-card-list">
        {entries.map(([id, spec]) => (
          <article className="rule-card" key={id}>
            <div className="rule-card-head">
              <strong>{spec.label || id}</strong>
              <button className="icon-button danger" type="button" onClick={() => onChange(removePageType(config, id))} aria-label="删除页面类型">
                <Trash2 size={15} />
              </button>
            </div>
            <div className="rule-grid">
              <TextField label="类型标识" value={spec.id} onChange={(value) => onChange(updatePageType(config, id, { id: value }))} />
              <TextField label="策划名称" value={spec.label} onChange={(value) => onChange(updatePageType(config, id, { label: value }))} />
              <TextField label="目录" value={spec.dir} onChange={(value) => onChange(updatePageType(config, id, { dir: value }))} />
              <TextField label="模板文件" value={spec.template} onChange={(value) => onChange(updatePageType(config, id, { template: value }))} />
              <TagField label="必填章节" value={spec.requiredSections} onChange={(value) => onChange(setPageTypeTags(config, id, "requiredSections", value))} />
              <TagField label="必填事实" value={spec.requiredFacts} onChange={(value) => onChange(setPageTypeTags(config, id, "requiredFacts", value))} />
            </div>
            <div className="rule-switches">
              <SwitchField label="必须有证据" checked={spec.evidenceRequired !== false} onChange={(checked) => onChange(updatePageType(config, id, { evidenceRequired: checked }))} />
              <SwitchField label="允许发布" checked={spec.publishable !== false} onChange={(checked) => onChange(updatePageType(config, id, { publishable: checked }))} />
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function DocumentTypeSection({ config, onChange }: EditorSectionProps) {
  const entries = Object.entries(config.documentTypes);
  return (
    <section className="release-panel rule-section">
      <SectionHead
        title="文档类型与 Wiki 模板"
        caption="先定义资料属于哪类文档，再定义这类文档进入 Wiki 时必须写清楚什么。技术目录和模板文件会在高级规则中自动承接。"
        actionLabel="新增文档类型"
        onAction={() => onChange(addDocumentType(config))}
      />
      <div className="rule-hint">
        <strong>配置方法</strong>
        <span>策划只需要维护名称、用途、必填章节、必填事实和证据要求。系统会把这些内容编译成构建 Pipeline 可消费的 Wiki Spec。</span>
      </div>
      <div className="rule-card-list">
        {entries.map(([id, spec]) => (
          <article className="rule-card document-rule-card" key={id}>
            <div className="rule-card-head">
              <div>
                <strong>{spec.label || id}</strong>
                <span>{spec.description || "说明这类资料进入知识库后应该如何成文。"}</span>
              </div>
              <button className="icon-button danger" type="button" onClick={() => onChange(removeDocumentType(config, id))} aria-label="删除文档类型">
                <Trash2 size={15} />
              </button>
            </div>
            <div className="rule-grid">
              <TextField label="文档类型名称" value={spec.label} onChange={(value) => onChange(updateDocumentType(config, id, { label: value }))} />
              <label className="field-label">
                生成哪类 Wiki
                <select value={spec.defaultPageTypeId} onChange={(event) => onChange(updateDocumentType(config, id, { defaultPageTypeId: event.target.value }))}>
                  {Object.values(config.pageTypes).map((pageType) => (
                    <option key={pageType.id} value={pageType.id}>{pageType.label}</option>
                  ))}
                  {!config.pageTypes[spec.defaultPageTypeId] && <option value={spec.defaultPageTypeId}>{spec.defaultPageTypeId}</option>}
                </select>
              </label>
              <TextAreaField label="用途说明" value={spec.description} onChange={(value) => onChange(updateDocumentType(config, id, { description: value }))} />
              <TextAreaField
                label="模板说明"
                value={spec.wikiSpecTemplate.guidance}
                onChange={(value) => onChange(updateDocumentType(config, id, { wikiSpecTemplate: { ...spec.wikiSpecTemplate, guidance: value } }))}
              />
              <TagField label="必填章节" value={spec.wikiSpecTemplate.requiredSections} onChange={(value) => onChange(setDocumentTypeTags(config, id, "requiredSections", value))} />
              <TagField label="必填事实" value={spec.wikiSpecTemplate.requiredFacts} onChange={(value) => onChange(setDocumentTypeTags(config, id, "requiredFacts", value))} />
            </div>
            <div className="rule-switches">
              <SwitchField
                label="关键结论必须有证据"
                checked={spec.wikiSpecTemplate.evidenceRequired}
                onChange={(checked) => onChange(updateDocumentType(config, id, { wikiSpecTemplate: { ...spec.wikiSpecTemplate, evidenceRequired: checked } }))}
              />
              <SwitchField label="允许进入正式发布" checked={spec.publishable !== false} onChange={(checked) => onChange(updateDocumentType(config, id, { publishable: checked }))} />
            </div>
            <details className="advanced-json">
              <summary>高级标识</summary>
              <div className="rule-grid two">
                <TextField label="文档类型 ID" value={spec.id} onChange={(value) => onChange(updateDocumentType(config, id, { id: value }))} />
                <TextField label="Wiki 类型 ID" value={spec.defaultPageTypeId} onChange={(value) => onChange(updateDocumentType(config, id, { defaultPageTypeId: value }))} />
              </div>
            </details>
          </article>
        ))}
      </div>
    </section>
  );
}

function EntityTypeSection({ config, onChange }: EditorSectionProps) {
  return (
    <section className="release-panel rule-section">
      <SectionHead
        title="业务对象"
        caption="定义知识图谱里允许出现的对象。对象越清楚，Agent 越不容易把所有内容都归成“概念”。"
        actionLabel="新增业务对象"
        onAction={() => onChange(addEntityType(config))}
      />
      <div className="rule-hint">
        <strong>配置方法</strong>
        <span>只把团队真正会查询、会关联、会审核的对象放进来，例如系统、活动、配置表、字段、道具、状态、数值项。</span>
      </div>
      <div className="rule-table">
        <div className="rule-table-row head">
          <span>对象 ID</span>
          <span>业务名称</span>
          <span>允许发布</span>
          <span />
        </div>
        {config.entityTypes.map((entity, index) => (
          <div className="rule-table-row" key={`${entity.id}-${index}`}>
            <input value={entity.id} onChange={(event) => onChange(updateEntityType(config, index, { id: event.target.value }))} />
            <input value={entity.label} onChange={(event) => onChange(updateEntityType(config, index, { label: event.target.value }))} />
            <SwitchField label="可发布" checked={entity.publishable !== false} onChange={(checked) => onChange(updateEntityType(config, index, { publishable: checked }))} compact />
            <button className="icon-button danger" type="button" onClick={() => onChange(removeEntityType(config, index))} aria-label="删除实体类型">
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function RelationTypeSection({ config, onChange }: EditorSectionProps) {
  return (
    <section className="release-panel rule-section">
      <SectionHead
        title="业务关系"
        caption="定义对象之间允许建立什么关系，以及哪些关系可以由系统自动采信。方向不清楚的关系会进入候选审核。"
        actionLabel="新增业务关系"
        onAction={() => onChange(addRelationType(config))}
      />
      <div className="rule-hint">
        <strong>配置方法</strong>
        <span>关系要写成策划能判断的业务口径，例如“活动产出道具”“系统依赖配置表”“字段引用资源”。不确定方向时不要自动采信。</span>
      </div>
      <div className="rule-table relation-table">
        <div className="rule-table-row head">
          <span>关系 ID</span>
          <span>业务名称</span>
          <span>方向</span>
          <span>系统采信</span>
          <span>允许发布</span>
          <span />
        </div>
        {config.relationTypes.map((relation, index) => (
          <div className="rule-table-row" key={`${relation.id}-${index}`}>
            <input value={relation.id} onChange={(event) => onChange(updateRelationType(config, index, { id: event.target.value }))} />
            <input value={relation.label} onChange={(event) => onChange(updateRelationType(config, index, { label: event.target.value }))} />
            <select value={relation.direction} onChange={(event) => onChange(updateRelationType(config, index, { direction: event.target.value as RelationTypeSpec["direction"] }))}>
              <option value="source_to_target">A 指向 B</option>
              <option value="bidirectional">A 与 B 双向</option>
            </select>
            <SwitchField label="自动采信" checked={relation.autoGenerated} onChange={(checked) => onChange(updateRelationType(config, index, { autoGenerated: checked }))} compact />
            <SwitchField label="可发布" checked={relation.publishable !== false} onChange={(checked) => onChange(updateRelationType(config, index, { publishable: checked }))} compact />
            <button className="icon-button danger" type="button" onClick={() => onChange(removeRelationType(config, index))} aria-label="删除关系类型">
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function TableRuleSection({ config, onChange }: EditorSectionProps) {
  return (
    <section className="release-panel rule-section">
      <SectionHead title="表字段推断策略" caption="用字段名后缀区分自动采信和必须人工确认的表关系。" />
      <div className="rule-hint">
        <strong>配置方法</strong>
        <span>例如普通的 Id / Ids 可以自动作为引用关系；RewardId、ItemId、ConditionId 这类业务含义较重的字段，建议先进入候选审核。</span>
      </div>
      <div className="rule-grid two">
        <TagField
          label="可自动采信的字段后缀"
          value={config.tableRules.autoConfirmFieldIdSuffixes}
          onChange={(value) => onChange(updateTableRuleTags(config, "autoConfirmFieldIdSuffixes", value))}
        />
        <TagField
          label="必须人工确认的字段后缀"
          value={config.tableRules.candidateFieldIdSuffixes}
          onChange={(value) => onChange(updateTableRuleTags(config, "candidateFieldIdSuffixes", value))}
        />
      </div>
    </section>
  );
}

function QualityRuleSection({ config, onChange }: EditorSectionProps) {
  const entries = Object.entries(config.qualityRules);
  return (
    <section className="release-panel rule-section">
      <SectionHead
        title="质量红线"
        caption="定义哪些问题必须阻断发布，哪些需要关注，哪些只记录。构建和发布都会读取这些红线。"
        actionLabel="新增红线"
        onAction={() => onChange(addQualityRule(config))}
      />
      <div className="rule-hint">
        <strong>配置方法</strong>
        <span>红线不是越多越好。只把会导致 Agent 答错、无法追溯、关系污染或发布风险的问题设为“阻断发布”。</span>
      </div>
      {entries.length === 0 ? (
        <p className="muted">当前没有额外质量红线，系统仍会执行内置结构检查。</p>
      ) : (
        <div className="rule-table quality-table">
          <div className="rule-table-row head">
            <span>规则 ID</span>
            <span>等级</span>
            <span>说明</span>
            <span>启用</span>
            <span />
          </div>
          {entries.map(([ruleId, rule]) => (
            <div className="rule-table-row" key={ruleId}>
              <input value={ruleId} onChange={(event) => onChange(renameQualityRule(config, ruleId, event.target.value))} />
              <select value={String(rule.severity ?? "warning")} onChange={(event) => onChange(updateQualityRule(config, ruleId, { severity: event.target.value }))}>
                <option value="blocking">阻断发布</option>
                <option value="warning">需要关注</option>
                <option value="info">仅记录</option>
              </select>
              <input value={String(rule.description ?? "")} onChange={(event) => onChange(updateQualityRule(config, ruleId, { description: event.target.value }))} />
              <SwitchField label="启用" checked={rule.enabled !== false} onChange={(checked) => onChange(updateQualityRule(config, ruleId, { enabled: checked }))} compact />
              <button className="icon-button danger" type="button" onClick={() => onChange(removeQualityRule(config, ruleId))} aria-label="删除质量红线">
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function renameQualityRule(config: KnowledgeRuleConfig, previousId: string, nextId: string): KnowledgeRuleConfig {
  const id = nextId.trim().replace(/\s+/g, "_");
  if (!id || id === previousId) return config;
  const next = createRuleDraft(config);
  const value = next.qualityRules[previousId];
  delete next.qualityRules[previousId];
  next.qualityRules[id] = value ?? { severity: "warning", enabled: true };
  return next;
}

function SectionHead({ title, caption, actionLabel, onAction }: { title: string; caption: string; actionLabel?: string; onAction?: () => void }) {
  return (
    <div className="detail-head">
      <div>
        <h2>{title}</h2>
        <p>{caption}</p>
      </div>
      {actionLabel && onAction && (
        <button className="secondary-action" type="button" onClick={onAction}>
          <Plus size={15} />
          {actionLabel}
        </button>
      )}
    </div>
  );
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="field-label">
      {label}
      <input value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function TextAreaField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="field-label">
      {label}
      <textarea value={value} onChange={(event) => onChange(event.target.value)} rows={3} />
    </label>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.01,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <label className="field-label">
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
      />
    </label>
  );
}

function TagField({ label, value, onChange }: { label: string; value: string[]; onChange: (value: string) => void }) {
  return (
    <label className="field-label tag-field">
      {label}
      <input value={value.join("、")} onChange={(event) => onChange(event.target.value)} />
      <span>用顿号、逗号或换行分隔</span>
    </label>
  );
}

function SwitchField({ label, checked, onChange, compact = false }: { label: string; checked: boolean; onChange: (checked: boolean) => void; compact?: boolean }) {
  return (
    <label className={compact ? "switch-field compact" : "switch-field"}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

interface EditorSectionProps {
  config: KnowledgeRuleConfig;
  onChange: (config: KnowledgeRuleConfig) => void;
}
