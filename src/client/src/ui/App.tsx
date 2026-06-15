import {
  Activity,
  Archive,
  BookOpen,
  Boxes,
  CheckCircle2,
  Database,
  GitBranch,
  KeyRound,
  LogOut,
  PackagePlus,
  Play,
  RefreshCw,
  SearchCheck
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { isTauri, selectFolder } from "../tauri";

import {
  getBundleVersion,
  getDashboard,
  getPackage,
  getQualityProfile,
  getToken,
  buildKnowledgePackage,
  importLegacy,
  importSourceBundle,
  listAgentEvents,
  listBuildRuns,
  listBundleVersions,
  listPackages,
  listReleases,
  listReviewTasks,
  login,
  scanLegacy,
  setToken,
  updateQualityProfile,
  type AssetPackage,
  type BuildModelConfig,
  type KnowledgeBuildRun,
  type SourceBundleVersion,
  type SourceFileChange
} from "../api";

type View = "dashboard" | "sources" | "builder" | "assets" | "review" | "release" | "agent" | "maintenance";

const NAV: Array<{ id: View; label: string; icon: typeof Activity }> = [
  { id: "dashboard", label: "首页", icon: Activity },
  { id: "sources", label: "资料库", icon: Database },
  { id: "builder", label: "知识构建", icon: PackagePlus },
  { id: "assets", label: "知识资产", icon: Boxes },
  { id: "review", label: "审核中心", icon: CheckCircle2 },
  { id: "release", label: "发布", icon: GitBranch },
  { id: "agent", label: "Agent 反馈", icon: SearchCheck },
  { id: "maintenance", label: "高级维护", icon: Archive }
];

export function App() {
  const [token, updateToken] = useState(getToken());
  const [view, setView] = useState<View>("dashboard");
  const queryClient = useQueryClient();

  if (!token) {
    return <LoginScreen onLogin={(next) => {
      setToken(next);
      updateToken(next);
    }} />;
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">KH</div>
          <div>
            <strong>Knowledge Hub</strong>
            <span>资产飞轮管理台</span>
          </div>
        </div>
        <nav>
          {NAV.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={view === item.id ? "nav-item active" : "nav-item"}
                onClick={() => setView(item.id)}
              >
                <Icon size={18} />
                {item.label}
              </button>
            );
          })}
        </nav>
        <button
          className="logout"
          onClick={() => {
            setToken(null);
            updateToken(null);
            queryClient.clear();
          }}
        >
          <LogOut size={16} />
          退出
        </button>
      </aside>
      <main className="main">
        {view === "dashboard" && <Dashboard />}
        {view === "sources" && <Sources />}
        {view === "builder" && <KnowledgeBuilder />}
        {view === "assets" && <Assets />}
        {view === "review" && <Review />}
        {view === "release" && <Release />}
        {view === "agent" && <AgentFeedback />}
        {view === "maintenance" && <Maintenance />}
      </main>
      <a className="deerflow" href="https://deerflow.tech" target="_blank" rel="noreferrer">
        Created By Deerflow
      </a>
    </div>
  );
}

function LoginScreen({ onLogin }: { onLogin: (token: string) => void }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("adminpw");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  return (
    <div className="login-screen">
      <section className="login-panel">
        <div className="brand-mark large">KH</div>
        <h1>Knowledge Hub</h1>
        <p>面向管理员、主开发者和维护者的知识资产协作台。</p>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setLoading(true);
            setError("");
            try {
              const response = await login(username, password);
              onLogin(response.token);
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setLoading(false);
            }
          }}
        >
          <label>
            用户名
            <input value={username} onChange={(event) => setUsername(event.target.value)} />
          </label>
          <label>
            密码
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          {error && <div className="error">{error}</div>}
          <button disabled={loading}>{loading ? "登录中..." : "进入知识库"}</button>
        </form>
      </section>
    </div>
  );
}

function Dashboard() {
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

const BUILD_STAGES = ["convert", "extract", "tables", "graph", "viz"];
const MODEL_PREFS_KEY = "kh_builder_model_prefs";

function KnowledgeBuilder() {
  const queryClient = useQueryClient();
  const bundleId = "default";
  const prefs = useMemo(loadModelPrefs, []);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [stages, setStages] = useState<string[]>(BUILD_STAGES);
  const [provider, setProvider] = useState<"deterministic" | "openai-compatible">(prefs.provider);
  const [baseUrl, setBaseUrl] = useState(prefs.baseUrl);
  const [model, setModel] = useState(prefs.model);
  const [apiKey, setApiKey] = useState(prefs.apiKey);
  const [rememberApiKey, setRememberApiKey] = useState(Boolean(prefs.apiKey));
  const [force, setForce] = useState(false);
  const [only, setOnly] = useState("");
  const [error, setError] = useState("");

  const versions = useQuery({
    queryKey: ["bundle-versions", bundleId],
    queryFn: () => listBundleVersions(bundleId)
  });
  const runs = useQuery({
    queryKey: ["build-runs"],
    queryFn: listBuildRuns,
    refetchInterval: 3000
  });

  useEffect(() => {
    if (!selectedVersion && versions.data?.[0]) setSelectedVersion(versions.data[0].versionId);
  }, [selectedVersion, versions.data]);

  useEffect(() => {
    const next = {
      provider,
      baseUrl,
      model,
      apiKey: rememberApiKey ? apiKey : ""
    };
    localStorage.setItem(MODEL_PREFS_KEY, JSON.stringify(next));
  }, [apiKey, baseUrl, model, provider, rememberApiKey]);

  const buildMutation = useMutation({
    mutationFn: async () => {
      if (!selectedVersion) throw new Error("请选择资料版本。");
      if (stages.length === 0) throw new Error("至少选择一个 pipeline 阶段。");
      const modelConfig = createModelConfig(provider, baseUrl, model, apiKey);
      return buildKnowledgePackage(bundleId, selectedVersion, {
        stages,
        model: modelConfig.model,
        modelConfig,
        force,
        only: only.trim() || null,
        qualityProfileId: "default"
      });
    },
    onSuccess: async (result) => {
      setError("");
      queryClient.setQueryData<KnowledgeBuildRun[]>(["build-runs"], (current = []) => [
        result.run,
        ...current.filter((run) => run.runId !== result.run.runId)
      ]);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["build-runs"] }),
        queryClient.invalidateQueries({ queryKey: ["packages"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] })
      ]);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "启动构建失败。");
    }
  });

  const activeRuns = (runs.data ?? []).filter((run) => run.status === "running");
  const selectedRuns = (runs.data ?? []).filter((run) => !selectedVersion || run.sourceVersionId === selectedVersion);
  const canStart = Boolean(selectedVersion) && !buildMutation.isPending && stages.length > 0 && (
    provider === "deterministic" || Boolean(baseUrl.trim() && model.trim() && apiKey.trim())
  );

  return (
    <Page
      title="知识构建"
      subtitle="把资料版本消费为一个知识资产包，并用可恢复的 pipeline run 追踪生成过程。"
    >
      <section className="builder-layout">
        <div className="builder-main">
          <section className="builder-panel">
            <div className="detail-head">
              <div>
                <h2>构建输入</h2>
                <p>选择一个已导入的资料版本，pipeline 会从该版本的 gamedocs/ 与 gamedata/ 生成资产包。</p>
              </div>
              <Badge label={activeRuns.length ? `${activeRuns.length} 个运行中` : "空闲"} tone={activeRuns.length ? "warn" : "ok"} />
            </div>
            <label className="field-label">
              资料版本
              <select value={selectedVersion ?? ""} onChange={(event) => setSelectedVersion(event.target.value || null)}>
                {(versions.data ?? []).map((version) => (
                  <option key={version.versionId} value={version.versionId}>
                    {version.label} · {version.fileCount} files
                  </option>
                ))}
              </select>
            </label>
            <div className="stage-toggle-grid">
              {BUILD_STAGES.map((stage) => (
                <label key={stage} className={stages.includes(stage) ? "stage-toggle selected" : "stage-toggle"}>
                  <input
                    type="checkbox"
                    checked={stages.includes(stage)}
                    onChange={(event) => {
                      setStages((current) => event.target.checked
                        ? [...current, stage].filter((value, index, array) => array.indexOf(value) === index)
                        : current.filter((item) => item !== stage));
                    }}
                  />
                  <span>{stage}</span>
                </label>
              ))}
            </div>
            <div className="inline-controls">
              <label>
                <input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} />
                强制重建
              </label>
              <input
                value={only}
                onChange={(event) => setOnly(event.target.value)}
                placeholder="只处理某个路径，可留空"
              />
            </div>
          </section>

          <section className="builder-panel">
            <div className="detail-head">
              <div>
                <h2>大模型配置</h2>
                <p>用于 extract 阶段理解策划文档；API Key 只写入本机前端偏好，不进入 build run 数据库。</p>
              </div>
              <KeyRound size={20} />
            </div>
            <div className="segmented">
              <button className={provider === "deterministic" ? "active" : ""} onClick={() => setProvider("deterministic")}>
                确定性
              </button>
              <button className={provider === "openai-compatible" ? "active" : ""} onClick={() => setProvider("openai-compatible")}>
                OpenAI-compatible
              </button>
            </div>
            {provider === "openai-compatible" ? (
              <div className="model-grid">
                <label className="field-label">
                  Base URL
                  <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" />
                </label>
                <label className="field-label">
                  Model
                  <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="gpt-4.1-mini" />
                </label>
                <label className="field-label model-secret">
                  API Key
                  <input value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" placeholder="sk-..." />
                </label>
                <label className="remember-secret">
                  <input type="checkbox" checked={rememberApiKey} onChange={(event) => setRememberApiKey(event.target.checked)} />
                  在本机记住 API Key
                </label>
              </div>
            ) : (
              <p className="notice">确定性模式不会调用大模型，适合验证 pipeline、表结构和质量门禁链路。</p>
            )}
            <button
              className="primary-action"
              disabled={!canStart}
              onClick={() => buildMutation.mutate()}
            >
              <Play size={16} />
              {buildMutation.isPending ? "启动中..." : "启动知识资产构建"}
            </button>
            {error && <p className="error">{error}</p>}
            {buildMutation.data && <p className="notice">已启动 run：{buildMutation.data.run.runId}</p>}
          </section>
        </div>

        <aside className="builder-runs">
          <div className="detail-head">
            <div>
              <h2>运行记录</h2>
              <p>状态来自后端 build-runs，切换页面后仍会恢复。</p>
            </div>
            <button className="icon-button" onClick={() => runs.refetch()} title="刷新运行记录">
              <RefreshCw size={16} />
            </button>
          </div>
          <div className="run-list">
            {selectedRuns.length === 0 && <p>暂无构建记录。</p>}
            {selectedRuns.map((run) => <BuildRunCard key={run.runId} run={run} />)}
          </div>
        </aside>
      </section>
    </Page>
  );
}

function BuildRunCard({ run }: { run: KnowledgeBuildRun }) {
  return (
    <article className={`run-card ${run.status}`}>
      <div className="detail-head">
        <div>
          <strong>{run.model}</strong>
          <span>{run.runId}</span>
        </div>
        <Badge label={runStatusLabel(run.status)} tone={run.status === "failed" ? "hot" : run.status === "running" ? "warn" : "ok"} />
      </div>
      <div className="stage-row">
        {run.stages.map((stage) => <span key={stage}>{stage}</span>)}
      </div>
      <p>
        资料版本：<code>{run.sourceVersionId}</code>
      </p>
      {run.packageId && <p>资产包：<code>{run.packageId}</code></p>}
      {run.error && <p className="error">{run.error}</p>}
      <small>{run.startedAt}{run.finishedAt ? ` → ${run.finishedAt}` : ""}</small>
    </article>
  );
}

function loadModelPrefs(): { provider: "deterministic" | "openai-compatible"; baseUrl: string; model: string; apiKey: string } {
  try {
    const parsed = JSON.parse(localStorage.getItem(MODEL_PREFS_KEY) ?? "{}") as Partial<{
      provider: "deterministic" | "openai-compatible";
      baseUrl: string;
      model: string;
      apiKey: string;
    }>;
    return {
      provider: parsed.provider === "openai-compatible" ? "openai-compatible" : "deterministic",
      baseUrl: parsed.baseUrl ?? "https://api.openai.com/v1",
      model: parsed.model ?? "gpt-4.1-mini",
      apiKey: parsed.apiKey ?? ""
    };
  } catch {
    return { provider: "deterministic", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini", apiKey: "" };
  }
}

function createModelConfig(
  provider: "deterministic" | "openai-compatible",
  baseUrl: string,
  model: string,
  apiKey: string
): BuildModelConfig {
  if (provider === "deterministic") return { provider: "deterministic", model: "deterministic" };
  return {
    provider: "openai-compatible",
    baseUrl: baseUrl.trim(),
    model: model.trim(),
    apiKey: apiKey.trim()
  };
}

function runStatusLabel(status: string): string {
  if (status === "running") return "运行中";
  if (status === "completed") return "已完成";
  if (status === "failed") return "失败";
  return status;
}

function Sources() {
  const queryClient = useQueryClient();
  const bundleId = "default";
  const [rootPath, setRootPath] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);

  const versions = useQuery({
    queryKey: ["bundle-versions", bundleId],
    queryFn: () => listBundleVersions(bundleId)
  });
  const detail = useQuery({
    queryKey: ["bundle-version", bundleId, selectedVersion],
    queryFn: () => getBundleVersion(bundleId, selectedVersion!),
    enabled: Boolean(selectedVersion)
  });
  return (
    <Page
      title="资料库"
      subtitle="批量导入 gamedata/ 与 gamedocs/，按内容哈希去重并按时间生成版本。"
    >
      <section className="upload-box">
        <div>
          <h2>批量导入新版本</h2>
          <p>
            指向服务器上一个包含 <code>gamedata/</code> 与 <code>gamedocs/</code> 的目录；
            未变化的文件会自动复用已有 blob，仅记录清单引用。
          </p>
        </div>
        <div className="upload-form">
          <input
            value={rootPath}
            onChange={(event) => setRootPath(event.target.value)}
            placeholder="例：D:/raw/2026-06-10"
            style={{ minWidth: 320 }}
            readOnly={isTauri}
          />
          {isTauri && (
            <button
              type="button"
              onClick={async () => {
                const picked = await selectFolder("选择资料根目录");
                if (picked) setRootPath(picked);
              }}
            >
              选择目录
            </button>
          )}
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="备注（可选）"
          />
          <button
            disabled={!rootPath.trim() || busy}
            onClick={async () => {
              setBusy(true);
              setMessage("");
              setError("");
              try {
                const result = await importSourceBundle(bundleId, rootPath.trim(), note.trim() || undefined);
                setMessage(
                  `已生成版本 ${result.version.label}：新增 ${result.version.addedCount}，修改 ${result.version.modifiedCount}，删除 ${result.version.removedCount}，未变 ${result.version.unchangedCount}（新增 blob ${result.newBlobCount}）。`
                );
                setSelectedVersion(result.version.versionId);
                setNote("");
                await queryClient.invalidateQueries({ queryKey: ["bundle-versions", bundleId] });
                await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
              } catch (err) {
                setError(err instanceof Error ? err.message : "导入失败。");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "导入中..." : "导入新版本"}
          </button>
        </div>
        {message && <p className="notice">{message}</p>}
        {error && <p className="error">{error}</p>}
      </section>

      <div className="package-grid">
        <section className="package-list">
          <h3 style={{ margin: "0 0 8px" }}>历史版本</h3>
          {(versions.data ?? []).length === 0 && <p>尚未导入任何版本。</p>}
          {(versions.data ?? []).map((version: SourceBundleVersion) => (
            <button
              key={version.versionId}
              className={selectedVersion === version.versionId ? "package-row selected" : "package-row"}
              onClick={() => setSelectedVersion(version.versionId)}
            >
              <strong>{version.label}</strong>
              <span>
                文件 {version.fileCount}　+{version.addedCount}　~{version.modifiedCount}　-{version.removedCount}
              </span>
              <small>{version.versionId}</small>
            </button>
          ))}
        </section>
        <section className="package-detail">
          {detail.data ? (
            <>
              <div className="detail-head">
                <div>
                  <h2>{detail.data.version.label}</h2>
                  <p>
                    {detail.data.version.note || "无备注"}
                    　·　创建于 {detail.data.version.createdAt}
                    　·　共 {detail.data.version.fileCount} 个文件，{(detail.data.version.totalBytes / 1024).toFixed(1)} KiB
                  </p>
                </div>
                <Badge label={detail.data.version.parentVersionId ? "增量版本" : "首版"} />
              </div>
              <div className="evidence-panel">
                <Metric label="新增" value={detail.data.version.addedCount} hint="本版相对上一版" />
                <Metric label="修改" value={detail.data.version.modifiedCount} hint="内容哈希变化" />
                <Metric label="删除" value={detail.data.version.removedCount} hint="本版不再包含" />
                <Metric label="未变" value={detail.data.version.unchangedCount} hint="复用 blob" />
              </div>
              <section className="build-panel">
                <div className="detail-head">
                  <div>
                    <h3>知识构建</h3>
                    <p>当前资料版本可在独立的知识构建模块中生成知识资产包，并查看可恢复的 pipeline 运行状态。</p>
                  </div>
                  <Badge label="独立模块" tone="ok" />
                </div>
              </section>
              <h3>变更明细</h3>
              {detail.data.changes.length === 0 ? (
                <p>与上一版相比无变更。</p>
              ) : (
                <div className="source-list">
                  {detail.data.changes.map((change: SourceFileChange) => (
                    <article className="source-row" key={`${change.kind}:${change.logicalPath}`}>
                      <div>
                        <strong>{kindLabel(change.kind)} · {change.logicalPath}</strong>
                        <span>{change.category}</span>
                      </div>
                      <code>{"contentHash" in change ? change.contentHash.slice(7, 19) : change.previousHash.slice(7, 19)}</code>
                    </article>
                  ))}
                </div>
              )}
            </>
          ) : selectedVersion ? (
            <Loading title="读取版本详情" />
          ) : (
            <p>选择左侧版本查看变更详情。</p>
          )}
        </section>
      </div>
    </Page>
  );
}

function kindLabel(kind: SourceFileChange["kind"]): string {
  if (kind === "added") return "新增";
  if (kind === "modified") return "修改";
  return "删除";
}

function Assets() {
  const [selected, setSelected] = useState<string>("");
  const packages = useQuery({ queryKey: ["packages"], queryFn: listPackages });
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

function Review() {
  const { data, isLoading, error } = useQuery({ queryKey: ["review", "blocking"], queryFn: () => listReviewTasks("blocking") });
  if (isLoading) return <Loading title="正在整理审核任务" />;
  if (error) return <ErrorState error={error} />;
  return (
    <Page title="审核中心" subtitle="把质量门禁结果翻译成可处理的维护任务。">
      <div className="task-list">
        {(data ?? []).map((task) => (
          <article className="task" key={task.taskId}>
            <Badge label={task.severity} tone="hot" />
            <div>
              <h3>{task.title}</h3>
              <p>{task.description}</p>
              <strong>{task.suggestedAction}</strong>
            </div>
          </article>
        ))}
      </div>
    </Page>
  );
}

function Release() {
  const { data, isLoading, error } = useQuery({ queryKey: ["releases"], queryFn: listReleases });
  if (isLoading) return <Loading title="正在读取发布版本" />;
  if (error) return <ErrorState error={error} />;
  return (
    <Page title="发布" subtitle="发布版本是 Agent 正式消费的不可变知识视图。">
      <div className="table">
        {(data ?? []).map((release) => (
          <div className="table-row" key={release.releaseId}>
            <strong>{release.version}</strong>
            <span>{release.releaseId}</span>
            <Badge label={release.status} />
            <span>{release.packageIds.length} 个资产包</span>
          </div>
        ))}
      </div>
    </Page>
  );
}

function AgentFeedback() {
  const { data, isLoading, error } = useQuery({ queryKey: ["agent-events"], queryFn: listAgentEvents });
  if (isLoading) return <Loading title="正在读取 Agent 反馈" />;
  if (error) return <ErrorState error={error} />;
  return (
    <Page title="Agent 反馈" subtitle="未命中和低质量命中会回流成知识库维护优先级。">
      <div className="event-list">
        {(data ?? []).map((event) => (
          <article className="event" key={event.eventId}>
            <Badge label={event.status} tone={event.status === "miss" ? "hot" : "ok"} />
            <div>
              <strong>{event.query}</strong>
              <span>{event.hitComponentIds.length ? `命中 ${event.hitComponentIds.join(", ")}` : "未命中任何资产"}</span>
            </div>
            <small>{event.createdAt}</small>
          </article>
        ))}
      </div>
    </Page>
  );
}

function Maintenance() {
  const [path, setPath] = useState("D:/projects/knowledge/data");
  const [summary, setSummary] = useState<Awaited<ReturnType<typeof scanLegacy>> | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const queryClient = useQueryClient();

  return (
    <Page title="高级维护" subtitle="给管理员和主开发者查看底层 ID、迁移、审计和调试入口。">
      <QualityGateAdmin />
      <section className="upload-box">
        <div>
          <h2>旧知识库扫描预览</h2>
          <p>先扫描旧 kb-builder data 目录，只生成摘要，不导入、不改动文件。</p>
        </div>
        <div className="upload-form legacy">
          <input value={path} onChange={(event) => setPath(event.target.value)} readOnly={isTauri} />
          {isTauri && (
            <button
              type="button"
              onClick={async () => {
                const picked = await selectFolder("选择旧知识库目录");
                if (picked) setPath(picked);
              }}
            >
              选择目录
            </button>
          )}
          <button
            onClick={async () => {
              setLoading(true);
              setError("");
              setMessage("");
              try {
                setSummary(await scanLegacy(path));
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              } finally {
                setLoading(false);
              }
            }}
          >
            {loading ? "扫描中..." : "扫描目录"}
          </button>
        </div>
        {error && <p className="error">{error}</p>}
        {message && <p className="notice">{message}</p>}
      </section>
      {summary && (
        <section className="legacy-summary">
          <div className="detail-head">
            <div>
              <h2>{summary.recommendedPackageId}</h2>
              <p>{summary.root}</p>
            </div>
            <div className="detail-actions">
              <Badge label={`${summary.warnings.length} warnings`} tone={summary.warnings.length ? "warn" : "ok"} />
              <button
                className="primary-action"
                disabled={importing}
                onClick={async () => {
                  setImporting(true);
                  setError("");
                  setMessage("");
                  try {
                    const result = await importLegacy(summary.root);
                    setMessage(
                      result.created
                        ? `已生成草稿资产包：${result.package.name}，包含 ${result.createdComponents} 个资产组件、${result.importedSources} 份资料。`
                        : `草稿资产包已存在：${result.package.name}`
                    );
                    await Promise.all([
                      queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
                      queryClient.invalidateQueries({ queryKey: ["packages"] }),
                      queryClient.invalidateQueries({ queryKey: ["sources"] })
                    ]);
                  } catch (err) {
                    setError(err instanceof Error ? err.message : String(err));
                  } finally {
                    setImporting(false);
                  }
                }}
              >
                <PackagePlus size={16} />
                {importing ? "生成中..." : "生成草稿资产包"}
              </button>
            </div>
          </div>
          <div className="metrics compact">
            <Metric label="资料" value={summary.sources.total} hint="gamedocs / gamedata" />
            <Metric label="Wiki" value={summary.wiki.pages} hint="wiki/**/*.md" />
            <Metric label="Index" value={summary.index.files} hint="wiki/_meta" />
            <Metric label="Graph" value={summary.graph.files} hint="graph snapshots" />
            <Metric label="Table" value={summary.tables.files} hint="schemas / table docs" />
          </div>
          {summary.warnings.length > 0 && (
            <div className="warning-list">
              {summary.warnings.map((warning) => <p key={warning}>{warning}</p>)}
            </div>
          )}
        </section>
      )}
    </Page>
  );
}

function QualityGateAdmin() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["quality-profile"], queryFn: getQualityProfile });
  const [draft, setDraft] = useState("");
  const mutation = useMutation({
    mutationFn: () => updateQualityProfile(JSON.parse(draft)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["quality-profile"] });
    }
  });

  useEffect(() => {
    if (data) setDraft(JSON.stringify(data.config, null, 2));
  }, [data]);

  if (isLoading) return <Loading title="读取质量门禁" />;
  if (error) return <ErrorState error={error} />;

  return (
    <section className="quality-gate-panel">
      <div className="detail-head">
        <div>
          <h2>知识质量门禁</h2>
          <p>{data?.name}　·　更新于 {data?.updatedAt}</p>
        </div>
        <Badge label={data?.active ? "active" : "inactive"} tone={data?.active ? "ok" : "warn"} />
      </div>
      <textarea
        className="code-editor"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        spellCheck={false}
      />
      <div className="detail-actions">
        <button
          className="primary-action"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? "保存中..." : "保存门禁配置"}
        </button>
      </div>
      {mutation.error && <p className="error">{mutation.error instanceof Error ? mutation.error.message : String(mutation.error)}</p>}
    </section>
  );
}

function Page({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="page">
      <header className="page-head">
        <BookOpen size={22} />
        <div>
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
      </header>
      {children}
    </div>
  );
}

function Metric({ label, value, hint, tone }: { label: string; value: string | number; hint: string; tone?: "hot" | "warn" | "ok" }) {
  return (
    <div className={`metric ${tone ?? ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{hint}</small>
    </div>
  );
}

function Badge({ label, tone }: { label: string; tone?: "hot" | "warn" | "ok" }) {
  return <span className={`badge ${tone ?? ""}`}>{label}</span>;
}

function Loading({ title }: { title: string }) {
  return <div className="state">{title}...</div>;
}

function ErrorState({ error }: { error: unknown }) {
  return <div className="state error">{error instanceof Error ? error.message : String(error)}</div>;
}

function EmptyWork({ title, body }: { title: string; body: string }) {
  return (
    <section className="empty">
      <h2>{title}</h2>
      <p>{body}</p>
    </section>
  );
}

function formatCounts(counts: Record<string, number>): string {
  return Object.entries(counts).map(([key, value]) => `${key} ${value}`).join(" / ") || "暂无";
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {
  return items.reduce<Record<string, T[]>>((acc, item) => {
    const value = key(item);
    acc[value] = acc[value] ?? [];
    acc[value].push(item);
    return acc;
  }, {});
}

function groupLabel(group: string): string {
  return ({
    wiki: "Wiki 页面",
    index: "目录索引",
    graph: "知识图谱",
    table: "表结构",
    evidence: "证据资产",
    quality: "质量资产"
  } as Record<string, string>)[group] ?? group;
}
