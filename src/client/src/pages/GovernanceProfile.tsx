import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { currentRole, getGovernanceProfile, resetGovernanceProfile, updateGovernanceProfile } from "../api";
import type { KnowledgeGovernanceProfile } from "../api/types";
import { Badge, ErrorState, Loading } from "../components/Atoms";
import { useProject } from "../ui/projectContext";

/**
 * 阶段7：项目级治理规则集中化。
 * 管理员在此调整 trust / lint 自动治理 / 发布策略 / 反馈聚合；普通用户只读结果。
 * 未设置项目级覆盖时展示「环境默认」，保存后变为「项目级覆盖」。
 */
export function GovernanceProfile() {
  const { currentProjectId } = useProject();
  const queryClient = useQueryClient();
  const role = currentRole();
  const isAdmin = role === "admin";

  const query = useQuery({
    queryKey: ["governance-profile", currentProjectId],
    queryFn: () => getGovernanceProfile(currentProjectId),
  });

  const [draft, setDraft] = useState<KnowledgeGovernanceProfile | null>(null);
  useEffect(() => {
    if (query.data) setDraft(query.data);
  }, [query.data]);

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["governance-profile", currentProjectId] });
    // 治理规则会影响飞轮例外与反馈聚合阈值，一并刷新。
    await queryClient.invalidateQueries({ queryKey: ["flywheel-status", currentProjectId] });
    await queryClient.invalidateQueries({ queryKey: ["agent-feedback-clusters", currentProjectId] });
  };

  const saveMutation = useMutation({
    mutationFn: (profile: KnowledgeGovernanceProfile) =>
      updateGovernanceProfile(
        { trust: profile.trust, lint: profile.lint, release: profile.release, feedback: profile.feedback },
        currentProjectId,
      ),
    onSuccess: async (profile) => {
      setDraft(profile);
      await invalidate();
    },
  });

  const resetMutation = useMutation({
    mutationFn: () => resetGovernanceProfile(currentProjectId),
    onSuccess: async (profile) => {
      setDraft(profile);
      await invalidate();
    },
  });

  if (query.isLoading || !draft) return <Loading title="正在加载治理规则..." />;
  if (query.isError) return <ErrorState error={query.error} />;

  const dirty = JSON.stringify(draft) !== JSON.stringify(query.data);
  const busy = saveMutation.isPending || resetMutation.isPending;

  const patch = (next: Partial<KnowledgeGovernanceProfile>) => setDraft((prev) => (prev ? { ...prev, ...next } : prev));

  return (
    <div className="governance-profile">
      <header className="governance-head">
        <div>
          <h3>项目治理规则</h3>
          <p className="subtle">
            集中管理可信门槛、Lint 自动治理、发布策略与反馈聚合。项目级规则优先于环境变量默认值。
          </p>
        </div>
        <Badge
          label={draft.source === "project" ? "项目级覆盖" : "环境默认"}
          tone={draft.source === "project" ? "ok" : undefined}
        />
      </header>

      {!isAdmin && <p className="governance-note subtle">当前角色为只读，仅管理员可调整治理规则。</p>}

      <div className="governance-grid">
        <GovernanceSection title="可信门槛" desc="控制自动发布对 Trust Score 与证据的最低要求。">
          <NumberField
            label="自动发布最低分"
            hint="低于该 Trust Score 的知识不会自动发布（0–1）。"
            value={draft.trust.minAutoPublishScore}
            min={0}
            max={1}
            step={0.05}
            disabled={!isAdmin}
            onChange={(v) => patch({ trust: { ...draft.trust, minAutoPublishScore: v } })}
          />
          <ToggleField
            label="发布前要求证据"
            hint="要求组件补齐证据后才允许发布。"
            checked={draft.trust.requireEvidence}
            disabled={!isAdmin}
            onChange={(v) => patch({ trust: { ...draft.trust, requireEvidence: v } })}
          />
        </GovernanceSection>

        <GovernanceSection title="Lint 自动治理" desc="控制 Knowledge Lint 发现的问题是否自动进入治理链路。">
          <ToggleField
            label="启用自动治理"
            hint="关闭后所有 Lint 发现都转人工处理。"
            checked={draft.lint.autoGovernanceEnabled}
            disabled={!isAdmin}
            onChange={(v) => patch({ lint: { ...draft.lint, autoGovernanceEnabled: v } })}
          />
          <NumberField
            label="自动治理置信阈值"
            hint="LLM 置信度达到该值才允许自动修复（0–1）。"
            value={draft.lint.autoEligibleThreshold}
            min={0}
            max={1}
            step={0.05}
            disabled={!isAdmin}
            onChange={(v) => patch({ lint: { ...draft.lint, autoEligibleThreshold: v } })}
          />
        </GovernanceSection>

        <GovernanceSection title="发布策略" desc="控制自动发布在何种变更下必须转人工确认。">
          <ToggleField
            label="自动发布修订版本"
            hint="构建完成后自动把修订发布给 Agent。"
            checked={draft.release.autoPublishRevisions}
            disabled={!isAdmin}
            onChange={(v) => patch({ release: { ...draft.release, autoPublishRevisions: v } })}
          />
          <ToggleField
            label="删除时阻断自动发布"
            hint="资产被删除的发布需人工确认。"
            checked={draft.release.blockOnDeletes}
            disabled={!isAdmin}
            onChange={(v) => patch({ release: { ...draft.release, blockOnDeletes: v } })}
          />
          <ToggleField
            label="可信下降时阻断"
            hint="Trust Score 相比上一版下降时需人工确认。"
            checked={draft.release.blockOnTrustDecline}
            disabled={!isAdmin}
            onChange={(v) => patch({ release: { ...draft.release, blockOnTrustDecline: v } })}
          />
          <ToggleField
            label="有待确认修正时阻断"
            hint="存在未确认的来源修正时需人工确认。"
            checked={draft.release.blockOnPendingCorrections}
            disabled={!isAdmin}
            onChange={(v) => patch({ release: { ...draft.release, blockOnPendingCorrections: v } })}
          />
        </GovernanceSection>

        <GovernanceSection title="反馈聚合" desc="控制 Agent 负反馈聚合成例外的方式。">
          <ToggleField
            label="启用反馈聚合"
            hint="关闭后不在反馈页展示问题簇。"
            checked={draft.feedback.autoClusterEnabled}
            disabled={!isAdmin}
            onChange={(v) => patch({ feedback: { ...draft.feedback, autoClusterEnabled: v } })}
          />
          <NumberField
            label="高频阈值（次）"
            hint="同一查询命中低质页面达到该次数才算高频例外。"
            value={draft.feedback.highFrequencyThreshold}
            min={1}
            max={100}
            step={1}
            disabled={!isAdmin}
            onChange={(v) => patch({ feedback: { ...draft.feedback, highFrequencyThreshold: Math.round(v) } })}
          />
        </GovernanceSection>
      </div>

      {isAdmin && (
        <div className="governance-actions">
          <button
            className="primary-action"
            disabled={!dirty || busy}
            onClick={() => draft && saveMutation.mutate(draft)}
          >
            {saveMutation.isPending ? "保存中..." : "保存治理规则"}
          </button>
          <button
            className="secondary-action"
            disabled={busy || draft.source === "default"}
            onClick={() => resetMutation.mutate()}
          >
            {resetMutation.isPending ? "恢复中..." : "恢复环境默认"}
          </button>
          {draft.updatedAt && draft.source === "project" && (
            <span className="subtle governance-updated">最近由 {draft.updatedBy || "未知"} 更新</span>
          )}
          {(saveMutation.isError || resetMutation.isError) && (
            <span className="governance-error">
              {errorMessage(saveMutation.error ?? resetMutation.error)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function GovernanceSection({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <section className="governance-section">
      <h4>{title}</h4>
      <p className="subtle">{desc}</p>
      <div className="governance-fields">{children}</div>
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "保存失败。";
}

function NumberField(props: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className="governance-field">
      <span className="governance-field-label">{props.label}</span>
      <input
        type="number"
        value={props.value}
        min={props.min}
        max={props.max}
        step={props.step}
        disabled={props.disabled}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) props.onChange(Math.min(props.max, Math.max(props.min, next)));
        }}
      />
      <span className="governance-field-hint subtle">{props.hint}</span>
    </label>
  );
}

function ToggleField(props: {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="governance-field governance-toggle">
      <span className="governance-field-main">
        <input
          type="checkbox"
          checked={props.checked}
          disabled={props.disabled}
          onChange={(event) => props.onChange(event.target.checked)}
        />
        <span className="governance-field-label">{props.label}</span>
      </span>
      <span className="governance-field-hint subtle">{props.hint}</span>
    </label>
  );
}
