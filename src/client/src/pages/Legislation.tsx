import { Save, ShieldCheck } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { activateLegislationProfile, createLegislationProfile, getLegislationProfile } from "../api";
import { Badge, ErrorState, Loading, Metric, Page } from "../components/Atoms";

export function Legislation() {
  const queryClient = useQueryClient();
  const profiles = useQuery({ queryKey: ["legislation-profile"], queryFn: getLegislationProfile });
  const [name, setName] = useState("策划立法规则");
  const [activate, setActivate] = useState(true);
  const [configText, setConfigText] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (profiles.data?.profile) {
      setName(`${profiles.data.profile.name} copy`);
      setConfigText(JSON.stringify(profiles.data.profile.config, null, 2));
    }
  }, [profiles.data?.profile]);

  const save = useMutation({
    mutationFn: async () => createLegislationProfile({
      name,
      activate,
      config: JSON.parse(configText)
    }),
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

  if (profiles.isLoading) return <Loading title="正在读取策划立法规则" />;
  if (profiles.error) return <ErrorState error={profiles.error} />;

  const active = profiles.data?.profile;
  const history = profiles.data?.profiles ?? [];

  return (
    <Page title="策划立法" subtitle="维护页面类型、实体关系、Wiki 标准、表字段规则和质量红线；构建 Pipeline 会按当前启用规则执行。">
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
            <Metric label="页面类型" value={Object.keys(active.config.pageTypes).length} hint="page_types" />
            <Metric label="实体类型" value={active.config.entityTypes.length} hint="entity_types" />
            <Metric label="关系类型" value={active.config.relationTypes.length} hint="relation_types" />
            <Metric label="Hash" value={active.hash.slice(0, 12)} hint={active.hash} />
          </div>
        </section>
      )}

      <section className="release-panel">
        <div className="detail-head">
          <div>
            <h2>规则版本</h2>
            <p>保存会生成新版本；启用后，新的知识构建会使用这套规则。</p>
          </div>
          <Badge label={activate ? "save + activate" : "draft"} tone={activate ? "ok" : undefined} />
        </div>
        <div className="model-grid">
          <label className="field-label">
            名称
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="field-label">
            保存后启用
            <select value={activate ? "yes" : "no"} onChange={(event) => setActivate(event.target.value === "yes")}>
              <option value="yes">启用</option>
              <option value="no">只保存版本</option>
            </select>
          </label>
        </div>
        <textarea className="code-editor" value={configText} onChange={(event) => setConfigText(event.target.value)} spellCheck={false} />
        {error && <p className="error">{error}</p>}
        <button className="primary-action" disabled={save.isPending} onClick={() => save.mutate()}>
          <Save size={16} />
          {save.isPending ? "保存中..." : "保存规则 Profile"}
        </button>
      </section>

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
