import { Plus, Save, ShieldCheck, Trash2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { activateLegislationProfile, createLegislationProfile, getLegislationProfile } from "../api";
import type { KnowledgeRuleConfig, RelationTypeSpec } from "../api/types";
import { Badge, ErrorState, Loading, Metric, Page } from "../components/Atoms";
import {
  addEntityType,
  addPageType,
  addQualityRule,
  addRelationType,
  createRuleDraft,
  removeEntityType,
  removePageType,
  removeQualityRule,
  removeRelationType,
  setPageTypeTags,
  updateEntityType,
  updatePageType,
  updateQualityRule,
  updateRelationType,
  updateTableRuleTags
} from "./legislationEditor";

export function Legislation() {
  const queryClient = useQueryClient();
  const profiles = useQuery({ queryKey: ["legislation-profile"], queryFn: getLegislationProfile });
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

  return (
    <Page title="策划立法" subtitle="用业务语言维护页面类型、实体关系、Wiki 标准、表字段策略和质量红线；系统负责把规则编译进构建 Pipeline。">
      {active && (
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
      )}

      {config && (
        <section className="legislation-workbench">
          <div className="release-panel legislation-save-panel">
            <div className="detail-head">
              <div>
                <h2>规则版本</h2>
                <p>保存会生成新版本；启用后，新的知识构建会使用这套规则。</p>
              </div>
              <Badge label={activate ? "保存并启用" : "保存草稿"} tone={activate ? "ok" : undefined} />
            </div>
            <div className="model-grid">
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
            {error && <p className="error">{error}</p>}
            <button className="primary-action" disabled={save.isPending} onClick={() => save.mutate()}>
              <Save size={16} />
              {save.isPending ? "保存中..." : "保存规则 Profile"}
            </button>
          </div>

          <PageTypeSection config={config} onChange={setConfig} />
          <EntityTypeSection config={config} onChange={setConfig} />
          <RelationTypeSection config={config} onChange={setConfig} />
          <TableRuleSection config={config} onChange={setConfig} />
          <QualityRuleSection config={config} onChange={setConfig} />

          <section className="release-panel">
            <details className="advanced-json">
              <summary>高级：规则 JSON 预览 / 导入</summary>
              <p>这个区域用于开发排查或跨环境复制，不作为策划日常维护入口。</p>
              <textarea className="code-editor small" value={jsonText} onChange={(event) => setJsonText(event.target.value)} spellCheck={false} />
              <button className="secondary-action" type="button" onClick={applyJson}>从 JSON 覆盖当前表单</button>
            </details>
          </section>
        </section>
      )}

      <section className="release-panel">
        <h2>历史版本</h2>
        <div className="event-list">
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
    </Page>
  );
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

function EntityTypeSection({ config, onChange }: EditorSectionProps) {
  return (
    <section className="release-panel rule-section">
      <SectionHead
        title="实体类型"
        caption="定义图谱里允许出现的业务对象，避免模型把一切都归成 concept。"
        actionLabel="新增实体"
        onAction={() => onChange(addEntityType(config))}
      />
      <div className="rule-table">
        <div className="rule-table-row head">
          <span>标识</span>
          <span>策划名称</span>
          <span>可发布</span>
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
        title="关系类型"
        caption="定义图谱边的业务含义、方向，以及哪些关系允许系统自动生成。"
        actionLabel="新增关系"
        onAction={() => onChange(addRelationType(config))}
      />
      <div className="rule-table relation-table">
        <div className="rule-table-row head">
          <span>标识</span>
          <span>策划名称</span>
          <span>方向</span>
          <span>自动生成</span>
          <span>可发布</span>
          <span />
        </div>
        {config.relationTypes.map((relation, index) => (
          <div className="rule-table-row" key={`${relation.id}-${index}`}>
            <input value={relation.id} onChange={(event) => onChange(updateRelationType(config, index, { id: event.target.value }))} />
            <input value={relation.label} onChange={(event) => onChange(updateRelationType(config, index, { label: event.target.value }))} />
            <select value={relation.direction} onChange={(event) => onChange(updateRelationType(config, index, { direction: event.target.value as RelationTypeSpec["direction"] }))}>
              <option value="source_to_target">从左到右</option>
              <option value="bidirectional">双向</option>
            </select>
            <SwitchField label="自动" checked={relation.autoGenerated} onChange={(checked) => onChange(updateRelationType(config, index, { autoGenerated: checked }))} compact />
            <SwitchField label="发布" checked={relation.publishable !== false} onChange={(checked) => onChange(updateRelationType(config, index, { publishable: checked }))} compact />
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
        caption="定义 blocking / warning / info 规则；构建和发布会读取这些红线。"
        actionLabel="新增红线"
        onAction={() => onChange(addQualityRule(config))}
      />
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
                <option value="blocking">blocking</option>
                <option value="warning">warning</option>
                <option value="info">info</option>
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
