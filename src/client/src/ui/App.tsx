import {
  Activity,
  Archive,
  BookOpen,
  Boxes,
  Bug,
  CheckCircle2,
  Database,
  File,
  GitBranch,
  KeyRound,
  LogOut,
  PackagePlus,
  Play,
  RefreshCw,
  RotateCcw,
  SearchCheck,
  Square,
  Trash2,
  Upload
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  getBundleVersion,
  getCurrentRelease,
  getDashboard,
  getDiagnosticSummary,
  getDiagnosticTrace,
  getPackage,
  getQualityProfile,
  getToken,
  buildKnowledgePackage,
  browseLocalFiles,
  createRelease,
  deleteBuildRun,
  importLegacy,
  importSourceBundle,
  listAgentEvents,
  listBuildRuns,
  listBundleVersions,
  listDiagnosticLogs,
  listMcpAudit,
  listPackages,
  listReleases,
  listReviewTasks,
  login,
  publishRelease,
  rollbackRelease,
  scanLegacy,
  setToken,
  simulateMcpQuery,
  stopBuildRun,
  testModelConnectivity,
  updateQualityProfile,
  uploadSourceBundle,
  type AssetPackage,
  type BuildModelConfig,
  type DiagnosticLogRecord,
  type KnowledgeEnvelope,
  type KnowledgeBuildRun,
  type LocalBrowseResult,
  type ReleaseRecord,
  type SourceBundleVersion,
  type SourceFileChange
} from "../api";

type View = "dashboard" | "sources" | "builder" | "assets" | "review" | "release" | "agent" | "diagnostics" | "maintenance";

const NAV: Array<{ id: View; label: string; icon: typeof Activity }> = [
  { id: "dashboard", label: "首页", icon: Activity },
  { id: "sources", label: "资料库", icon: Database },
  { id: "builder", label: "知识构建", icon: PackagePlus },
  { id: "assets", label: "知识资产", icon: Boxes },
  { id: "review", label: "审核中心", icon: CheckCircle2 },
  { id: "release", label: "发布", icon: GitBranch },
  { id: "agent", label: "Agent 反馈", icon: SearchCheck },
  { id: "diagnostics", label: "运行诊断", icon: Bug },
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
        {view === "diagnostics" && <Diagnostics />}
        {view === "maintenance" && <Maintenance />}
      </main>
      <a className="deerflow" href="https://deerflow.tech" target="_blank" rel="noreferrer" title="Created By Deerflow">
        DF
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
type ModelProvider = "deterministic" | "openai-compatible" | "anthropic";

function KnowledgeBuilder() {
  const queryClient = useQueryClient();
  const bundleId = "default";
  const prefs = useMemo(loadModelPrefs, []);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [stages, setStages] = useState<string[]>(BUILD_STAGES);
  const [provider, setProvider] = useState<ModelProvider>(prefs.provider);
  const [baseUrl, setBaseUrl] = useState(prefs.baseUrl);
  const [model, setModel] = useState(prefs.model);
  const [apiKey, setApiKey] = useState(prefs.apiKey);
  const [rememberApiKey, setRememberApiKey] = useState(Boolean(prefs.apiKey));
  const [force, setForce] = useState(false);
  const [only, setOnly] = useState("");
  const [error, setError] = useState("");
  const [modelTestMessage, setModelTestMessage] = useState<{ ok: boolean; text: string } | null>(null);

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
  const modelTestMutation = useMutation({
    mutationFn: async () => testModelConnectivity(createModelConfig(provider, baseUrl, model, apiKey)),
    onSuccess: (result) => {
      setModelTestMessage({ ok: result.ok, text: result.message });
    },
    onError: (err) => {
      setModelTestMessage({ ok: false, text: err instanceof Error ? err.message : "模型连接测试失败。" });
    }
  });
  const stopRunMutation = useMutation({
    mutationFn: stopBuildRun,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["build-runs"] });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "停止运行失败。");
    }
  });
  const deleteRunMutation = useMutation({
    mutationFn: deleteBuildRun,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["build-runs"] });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "删除运行记录失败。");
    }
  });

  const activeRuns = (runs.data ?? []).filter((run) => run.status === "running");
  const selectedRuns = (runs.data ?? []).filter((run) => !selectedVersion || run.sourceVersionId === selectedVersion);
  const canStart = Boolean(selectedVersion) && !buildMutation.isPending && stages.length > 0 && (
    provider === "deterministic" || Boolean(baseUrl.trim() && model.trim() && apiKey.trim())
  );
  const canTestModel = provider !== "deterministic" && Boolean(baseUrl.trim() && model.trim() && apiKey.trim()) && !modelTestMutation.isPending;
  const selectProvider = (nextProvider: ModelProvider) => {
    setProvider(nextProvider);
    if (nextProvider === "openai-compatible" && provider !== "openai-compatible") {
      setBaseUrl("https://api.openai.com/v1");
      setModel("gpt-4.1-mini");
    }
    if (nextProvider === "anthropic" && provider !== "anthropic") {
      setBaseUrl("https://api.anthropic.com/v1");
      setModel("claude-sonnet-4-5");
    }
  };

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
            <label className="field-label model-provider">
              LLM Provider
              <select value={provider} onChange={(event) => selectProvider(event.target.value as ModelProvider)}>
                <option value="deterministic">确定性（仅验证 pipeline）</option>
                <option value="openai-compatible">OpenAI-compatible</option>
                <option value="anthropic">Anthropic</option>
              </select>
            </label>
            {provider === "deterministic" ? (
              <p className="notice">确定性模式只适合验证 pipeline。要生成高质量知识资产，请切换到 OpenAI-compatible 或 Anthropic 并完成连接测试。</p>
            ) : (
              <div className="model-grid">
                <label className="field-label">
                  Base URL
                  <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={provider === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1"} />
                  {provider === "anthropic" && <small>支持填写服务根地址、/v1，或完整 /messages endpoint。</small>}
                </label>
                <label className="field-label">
                  Model
                  <input value={model} onChange={(event) => setModel(event.target.value)} placeholder={provider === "anthropic" ? "claude-sonnet-4-5" : "gpt-4.1-mini"} />
                </label>
                <label className="field-label model-secret">
                  <span className="secret-label-row">
                    API Key
                    <label className="remember-secret inline">
                      <input type="checkbox" checked={rememberApiKey} onChange={(event) => setRememberApiKey(event.target.checked)} />
                      在本机记住
                    </label>
                  </span>
                  <input value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" placeholder={provider === "anthropic" ? "sk-ant-..." : "sk-..."} />
                </label>
              </div>
            )}
            <div className="model-actions">
              <button
                type="button"
                disabled={!canTestModel}
                onClick={() => modelTestMutation.mutate()}
              >
                <KeyRound size={16} />
                {modelTestMutation.isPending ? "测试中..." : "测试模型连接"}
              </button>
              {provider === "deterministic" && <span>请选择 OpenAI-compatible 或 Anthropic 设置后测试。</span>}
            </div>
            {modelTestMessage && (
              <p className={modelTestMessage.ok ? "notice" : "error"}>{modelTestMessage.text}</p>
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
            {selectedRuns.map((run) => (
              <BuildRunCard
                key={run.runId}
                run={run}
                onStop={() => stopRunMutation.mutate(run.runId)}
                onDelete={() => deleteRunMutation.mutate(run.runId)}
                busy={stopRunMutation.isPending || deleteRunMutation.isPending}
              />
            ))}
          </div>
        </aside>
      </section>
    </Page>
  );
}

function BuildRunCard({
  run,
  onStop,
  onDelete,
  busy
}: {
  run: KnowledgeBuildRun;
  onStop: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const traceId = typeof run.config.traceId === "string" ? run.config.traceId : "";
  return (
    <article className={`run-card ${run.status}`}>
      <div className="detail-head">
        <div>
          <strong>{run.model}</strong>
          <span>{run.runId}</span>
        </div>
        <div className="run-actions">
          <Badge label={runStatusLabel(run.status)} tone={run.status === "failed" ? "hot" : run.status === "running" ? "warn" : "ok"} />
          {run.status === "running" && (
            <button className="icon-button" disabled={busy} onClick={onStop} title="停止运行">
              <Square size={15} />
            </button>
          )}
          {run.status !== "running" && (
            <button className="icon-button danger" disabled={busy} onClick={onDelete} title="删除运行记录">
              <Trash2 size={15} />
            </button>
          )}
        </div>
      </div>
      <div className="stage-row">
        {run.stages.map((stage) => <span key={stage}>{stage}</span>)}
      </div>
      <p>
        资料版本：<code>{run.sourceVersionId}</code>
      </p>
      {traceId && <p>Trace：<code>{traceId}</code></p>}
      {run.packageId && <p>资产包：<code>{run.packageId}</code></p>}
      {run.error && <p className="error">{run.error}</p>}
      <small>{run.startedAt}{run.finishedAt ? ` → ${run.finishedAt}` : ""}</small>
    </article>
  );
}

function loadModelPrefs(): { provider: ModelProvider; baseUrl: string; model: string; apiKey: string } {
  try {
    const parsed = JSON.parse(localStorage.getItem(MODEL_PREFS_KEY) ?? "{}") as Partial<{
      provider: ModelProvider | "anthropic-compatible";
      baseUrl: string;
      model: string;
      apiKey: string;
    }>;
    const provider: ModelProvider = parsed.provider === "openai-compatible" || parsed.provider === "anthropic"
      ? parsed.provider
      : parsed.provider === "anthropic-compatible"
        ? "anthropic"
      : "deterministic";
    return {
      provider,
      baseUrl: parsed.baseUrl ?? (provider === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1"),
      model: parsed.model ?? (provider === "anthropic" ? "claude-sonnet-4-5" : "gpt-4.1-mini"),
      apiKey: parsed.apiKey ?? ""
    };
  } catch {
    return { provider: "deterministic", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini", apiKey: "" };
  }
}

function createModelConfig(
  provider: ModelProvider,
  baseUrl: string,
  model: string,
  apiKey: string
): BuildModelConfig {
  if (provider === "deterministic") return { provider: "deterministic", model: "deterministic" };
  if (provider === "anthropic") {
    return {
      provider: "anthropic",
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      apiKey: apiKey.trim()
    };
  }
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

function releaseVersion(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, ".") + ".001";
}

function qualityScore(summary: Record<string, unknown>): string {
  const value = summary.overallScore ?? summary.score ?? summary.confidence;
  if (typeof value === "number") return `${Math.round(value * 100)}%`;
  if (typeof value === "string" && value.trim()) return value;
  return "n/a";
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function summarizeSelectedFiles(files: File[]): string[] {
  const roots = new Set(files.map((file) => webkitRelativePath(file).split("/")[0]).filter(Boolean));
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const samples = files.slice(0, 3).map((file) => webkitRelativePath(file) || file.name);
  return [
    roots.size ? `目录：${[...roots].slice(0, 3).join(", ")}` : "散装文件选择",
    `文件：${files.length} 个，${formatBytes(totalBytes)}`,
    ...samples
  ];
}

function webkitRelativePath(file: File): string {
  return typeof (file as File & { webkitRelativePath?: string }).webkitRelativePath === "string"
    ? (file as File & { webkitRelativePath: string }).webkitRelativePath
    : "";
}

function LocalFileBrowser({
  data,
  onOpen,
  onUse
}: {
  data: LocalBrowseResult;
  onOpen: (path: string) => void;
  onUse: (path: string) => void;
}) {
  return (
    <div className="local-browser">
      <div className="local-browser-head">
        <div>
          <strong>{data.path}</strong>
          <span>{data.entries.length} 个条目</span>
        </div>
        <div className="detail-actions">
          {data.parentPath && <button type="button" onClick={() => onOpen(data.parentPath!)}>上级</button>}
          <button type="button" onClick={() => onUse(data.path)}>使用当前目录</button>
        </div>
      </div>
      <div className="local-browser-list">
        {data.entries.map((entry) => (
          <button
            type="button"
            key={entry.path}
            className="local-browser-row"
            onClick={() => entry.kind === "directory" ? onOpen(entry.path) : undefined}
            disabled={entry.kind !== "directory"}
          >
            {entry.kind === "directory" ? <Database size={15} /> : <File size={15} />}
            <span>{entry.name}</span>
            <small>{entry.kind === "directory" ? "目录" : formatBytes(entry.size ?? 0)}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

function Sources() {
  const queryClient = useQueryClient();
  const bundleId = "default";
  const [rootPath, setRootPath] = useState("");
  const [note, setNote] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [browsePath, setBrowsePath] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const directoryInputRef = useRef<HTMLInputElement | null>(null);

  const versions = useQuery({
    queryKey: ["bundle-versions", bundleId],
    queryFn: () => listBundleVersions(bundleId)
  });
  const detail = useQuery({
    queryKey: ["bundle-version", bundleId, selectedVersion],
    queryFn: () => getBundleVersion(bundleId, selectedVersion!),
    enabled: Boolean(selectedVersion)
  });
  const browser = useQuery({
    queryKey: ["local-files", browsePath],
    queryFn: () => browseLocalFiles(browsePath.trim() || undefined),
    enabled: Boolean(browsePath)
  });
  const importUploadedFiles = async () => {
    if (selectedFiles.length === 0) throw new Error("请选择文件或目录。");
    return uploadSourceBundle(bundleId, selectedFiles, note.trim() || undefined);
  };
  const handleImportResult = async (result: Awaited<ReturnType<typeof importSourceBundle>>) => {
    setMessage(
      `已生成版本 ${result.version.label}：新增 ${result.version.addedCount}，修改 ${result.version.modifiedCount}，删除 ${result.version.removedCount}，未变 ${result.version.unchangedCount}（新增 blob ${result.newBlobCount}）。`
    );
    setSelectedVersion(result.version.versionId);
    setNote("");
    setSelectedFiles([]);
    await queryClient.invalidateQueries({ queryKey: ["bundle-versions", bundleId] });
    await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };
  return (
    <Page
      title="资料库"
      subtitle="批量导入 gamedata/ 与 gamedocs/，按内容哈希去重并按时间生成版本。"
    >
      <section className="upload-box">
        <div>
          <h2>批量导入新版本</h2>
          <p>
            推荐根目录包含 <code>gamedata/</code> 和 <code>gamedocs/</code>。策划文档放在 gamedocs，
            游戏配表放在 gamedata，可继续按系统或模块分子目录。
          </p>
          <div className="folder-guide">
            <code>资料根目录/</code>
            <code>├─ gamedocs/战斗/技能设计.md</code>
            <code>└─ gamedata/Combat/Skill.xlsx</code>
          </div>
        </div>
        <div className="upload-stack">
          <div className="upload-mode">
            <div>
              <strong>Web 上传</strong>
              <span>{selectedFiles.length ? `${selectedFiles.length} 个文件已选择` : "适合本机浏览器直接导入"}</span>
            </div>
            <div className="detail-actions">
              <button type="button" onClick={() => fileInputRef.current?.click()}>
                <File size={15} />
                选择文件
              </button>
              <button type="button" onClick={() => directoryInputRef.current?.click()}>
                <Upload size={15} />
                选择目录
              </button>
            </div>
            <input
              ref={fileInputRef}
              className="hidden-input"
              type="file"
              multiple
              onChange={(event) => setSelectedFiles(Array.from(event.target.files ?? []))}
            />
            <input
              ref={directoryInputRef}
              className="hidden-input"
              type="file"
              multiple
              {...{ webkitdirectory: "", directory: "" }}
              onChange={(event) => setSelectedFiles(Array.from(event.target.files ?? []))}
            />
          </div>
          {selectedFiles.length > 0 && (
            <div className="selected-files">
              {summarizeSelectedFiles(selectedFiles).map((line) => <span key={line}>{line}</span>)}
            </div>
          )}
          <div className="upload-form web">
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="备注（可选）"
            />
            <button
              disabled={selectedFiles.length === 0 || busy}
              onClick={async () => {
                setBusy(true);
                setMessage("");
                setError("");
                try {
                  await handleImportResult(await importUploadedFiles());
                } catch (err) {
                  setError(err instanceof Error ? err.message : "上传导入失败。");
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "导入中..." : "上传并导入"}
            </button>
          </div>
        </div>
      </section>

      <section className="upload-box">
        <div>
          <h2>服务器路径导入</h2>
          <p>当资料已经在运行 Knowledge Hub 的机器上时，输入或浏览服务器本地目录；浏览器不会打开具体文件内容。</p>
        </div>
        <div className="upload-form">
          <input
            value={rootPath}
            onChange={(event) => setRootPath(event.target.value)}
            placeholder="例：D:/raw/2026-06-10"
            style={{ minWidth: 320 }}
          />
          <input
            value={browsePath}
            onChange={(event) => setBrowsePath(event.target.value)}
            placeholder="浏览路径（可选）"
          />
          <button type="button" onClick={() => browser.refetch()}>
            浏览
          </button>
          <button
            disabled={!rootPath.trim() || busy}
            onClick={async () => {
              setBusy(true);
              setMessage("");
              setError("");
              try {
                const result = await importSourceBundle(bundleId, rootPath.trim(), note.trim() || undefined);
                await handleImportResult(result);
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
        {browser.data && (
          <LocalFileBrowser
            data={browser.data}
            onOpen={(path) => {
              setBrowsePath(path);
            }}
            onUse={(path) => setRootPath(path)}
          />
        )}
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
  const queryClient = useQueryClient();
  const [selectedPackageIds, setSelectedPackageIds] = useState<string[]>([]);
  const [version, setVersion] = useState(() => releaseVersion());
  const packages = useQuery({ queryKey: ["packages"], queryFn: listPackages });
  const tasks = useQuery({ queryKey: ["review", "blocking"], queryFn: () => listReviewTasks("blocking") });
  const releases = useQuery({ queryKey: ["releases"], queryFn: listReleases });
  const current = useQuery({ queryKey: ["releases", "current"], queryFn: getCurrentRelease });
  const [draft, setDraft] = useState<ReleaseRecord | null>(null);

  const blockers = (tasks.data ?? []).filter((task) => task.status === "open" && task.severity === "blocking" && selectedPackageIds.includes(task.packageId));
  const selectedPackages = (packages.data ?? []).filter((pkg) => selectedPackageIds.includes(pkg.packageId));
  const selectedComponents = selectedPackages.reduce((sum, pkg) => sum + Number(pkg.qualitySummary.componentCount ?? 0), 0);
  const createMutation = useMutation({
    mutationFn: () => createRelease(version.trim(), selectedPackageIds),
    onSuccess: async (release) => {
      setDraft(release);
      await queryClient.invalidateQueries({ queryKey: ["releases"] });
    }
  });
  const publishMutation = useMutation({
    mutationFn: async () => publishRelease(draft?.releaseId ?? ""),
    onSuccess: async () => {
      setDraft(null);
      setVersion(releaseVersion());
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["releases"] }),
        queryClient.invalidateQueries({ queryKey: ["releases", "current"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] })
      ]);
    }
  });
  const rollbackMutation = useMutation({
    mutationFn: rollbackRelease,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["releases"] }),
        queryClient.invalidateQueries({ queryKey: ["releases", "current"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] })
      ]);
    }
  });

  if (packages.isLoading || releases.isLoading || current.isLoading || tasks.isLoading) return <Loading title="正在读取发布工作台" />;
  if (packages.error || releases.error || current.error || tasks.error) return <ErrorState error={packages.error ?? releases.error ?? current.error ?? tasks.error} />;

  return (
    <Page title="发布" subtitle="发布版本是 Agent 正式消费的不可变知识视图。">
      <div className="release-workbench">
        <section className="release-panel">
          <div className="detail-head">
            <div>
              <h2>选择资产包</h2>
              <p>draft/reviewing/approved 都可进入发布候选，但 open blocking 任务会阻断发布。</p>
            </div>
            <Badge label={`${selectedPackageIds.length} selected`} />
          </div>
          <div className="package-picker">
            {(packages.data ?? []).map((pkg) => {
              const selected = selectedPackageIds.includes(pkg.packageId);
              const pkgBlockers = (tasks.data ?? []).filter((task) => task.status === "open" && task.packageId === pkg.packageId && task.severity === "blocking");
              return (
                <button
                  key={pkg.packageId}
                  className={selected ? "package-row selected" : "package-row"}
                  onClick={() => setSelectedPackageIds((currentIds) => selected
                    ? currentIds.filter((id) => id !== pkg.packageId)
                    : [...currentIds, pkg.packageId])}
                >
                  <strong>{pkg.name}</strong>
                  <span>{pkg.status} · score {qualityScore(pkg.qualitySummary)}</span>
                  <small>{pkg.packageId}</small>
                  {pkgBlockers.length > 0 && <Badge label={`${pkgBlockers.length} blocking`} tone="hot" />}
                </button>
              );
            })}
          </div>
        </section>

        <section className="release-panel">
          <div className="detail-head">
            <div>
              <h2>发布预览</h2>
              <p>发布后会冻结 package/component/source 以及质量摘要，Agent 只读 current release。</p>
            </div>
            <Badge label={blockers.length ? "blocked" : "ready"} tone={blockers.length ? "hot" : "ok"} />
          </div>
          <label className="field-label">
            版本号
            <input value={version} onChange={(event) => setVersion(event.target.value)} />
          </label>
          <div className="metrics compact release-metrics">
            <Metric label="资产包" value={selectedPackages.length} hint="本次发布包含" />
            <Metric label="来源版本" value={new Set(selectedPackages.flatMap((pkg) => pkg.sourceVersionIds)).size} hint="冻结到 manifest" />
            <Metric label="组件估算" value={selectedComponents || "-"} hint="发布时实际冻结" />
          </div>
          {blockers.length > 0 ? (
            <div className="warning-list">
              {blockers.map((task) => <p key={task.taskId}>{task.packageId} · {task.title}</p>)}
            </div>
          ) : (
            <p className="notice">门禁通过：所选资产包没有 open blocking 任务。</p>
          )}
          {draft && (
            <div className="release-draft">
              <strong>草案：{draft.version}</strong>
              <code>{draft.releaseId}</code>
            </div>
          )}
          <div className="detail-actions">
            <button
              className="primary-action"
              disabled={selectedPackageIds.length === 0 || blockers.length > 0 || !version.trim() || createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              <GitBranch size={16} />
              {createMutation.isPending ? "创建中..." : "创建发布草案"}
            </button>
            <button
              className="primary-action"
              disabled={!draft || blockers.length > 0 || publishMutation.isPending}
              onClick={() => publishMutation.mutate()}
            >
              <CheckCircle2 size={16} />
              {publishMutation.isPending ? "发布中..." : "发布为 Agent 当前版本"}
            </button>
          </div>
          {(createMutation.error || publishMutation.error) && (
            <p className="error">{errorMessage(createMutation.error ?? publishMutation.error, "发布失败。")}</p>
          )}
        </section>

        <section className="release-panel">
          <div className="detail-head">
            <div>
              <h2>Agent 当前版本</h2>
              <p>{current.data ? current.data.releaseId : "还没有 published release。"}</p>
            </div>
            {current.data && <Badge label={current.data.version} tone="ok" />}
          </div>
          {current.data && (
            <div className="release-current">
              <strong>{current.data.manifestHash || "manifest pending"}</strong>
              <span>{current.data.publishedAt}</span>
              <span>{current.data.packageIds.length} 个资产包</span>
            </div>
          )}
          <h3>发布历史</h3>
          <div className="release-history">
            {(releases.data ?? []).map((release) => (
              <article className="history-row" key={release.releaseId}>
                <div>
                  <strong>{release.version}</strong>
                  <span>{release.releaseId}</span>
                  <small>{release.manifestHash}</small>
                </div>
                <div className="detail-actions">
                  <Badge label={release.status} tone={release.status === "published" ? "ok" : undefined} />
                  <button
                    className="icon-button"
                    title="回滚到此发布"
                    disabled={release.status !== "published" || current.data?.releaseId === release.releaseId || rollbackMutation.isPending}
                    onClick={() => rollbackMutation.mutate(release.releaseId)}
                  >
                    <RotateCcw size={16} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
    </Page>
  );
}

function AgentFeedback() {
  const queryClient = useQueryClient();
  const [toolName, setToolName] = useState("kb_search");
  const [payload, setPayload] = useState('{\n  "query": "Battle System"\n}');
  const [envelope, setEnvelope] = useState<KnowledgeEnvelope | null>(null);
  const events = useQuery({ queryKey: ["agent-events"], queryFn: listAgentEvents });
  const audit = useQuery({ queryKey: ["mcp-audit"], queryFn: listMcpAudit });
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
  if (events.isLoading || audit.isLoading) return <Loading title="正在读取 MCP 控制台" />;
  if (events.error || audit.error) return <ErrorState error={events.error ?? audit.error} />;
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
      </div>
    </Page>
  );
}

function Diagnostics() {
  const [filters, setFilters] = useState({
    level: "",
    category: "",
    status: "",
    traceId: "",
    runId: "",
    releaseId: "",
    entityId: "",
    q: ""
  });
  const [selectedTraceId, setSelectedTraceId] = useState("");
  const query = {
    ...filters,
    traceId: filters.traceId || undefined,
    level: filters.level || undefined,
    category: filters.category || undefined,
    status: filters.status || undefined,
    runId: filters.runId || undefined,
    releaseId: filters.releaseId || undefined,
    entityId: filters.entityId || undefined,
    q: filters.q || undefined,
    limit: 100
  };
  const summary = useQuery({ queryKey: ["diagnostics", "summary"], queryFn: getDiagnosticSummary, refetchInterval: 15000 });
  const logs = useQuery({ queryKey: ["diagnostics", "logs", query], queryFn: () => listDiagnosticLogs(query), refetchInterval: 10000 });
  const trace = useQuery({
    queryKey: ["diagnostics", "trace", selectedTraceId],
    queryFn: () => getDiagnosticTrace(selectedTraceId),
    enabled: Boolean(selectedTraceId)
  });
  const selectedLog = (logs.data ?? [])[0] ?? null;

  if (summary.isLoading && logs.isLoading) return <Loading title="正在读取运行诊断" />;
  if (summary.error || logs.error) return <ErrorState error={summary.error ?? logs.error} />;

  const applyTrace = (traceId: string) => {
    setSelectedTraceId(traceId);
    setFilters((current) => ({ ...current, traceId }));
  };

  return (
    <Page title="运行诊断" subtitle="按 trace、run、release 和组件实体追踪 HTTP、构建、LLM、发布与 MCP 的运行问题。">
      <div className="metrics compact diagnostics-metrics">
        <Metric label="24h 错误" value={summary.data?.errors24h ?? 0} hint="error / failed" tone={(summary.data?.errors24h ?? 0) > 0 ? "hot" : "ok"} />
        <Metric label="慢请求" value={summary.data?.slowRequests24h ?? 0} hint="HTTP >= 1000ms" tone={(summary.data?.slowRequests24h ?? 0) > 0 ? "warn" : "ok"} />
        <Metric label="失败构建" value={summary.data?.failedBuilds24h ?? 0} hint="kb_build failed" tone={(summary.data?.failedBuilds24h ?? 0) > 0 ? "hot" : "ok"} />
        <Metric label="MCP 错误" value={summary.data?.mcpErrors24h ?? 0} hint="Agent 查询异常" tone={(summary.data?.mcpErrors24h ?? 0) > 0 ? "warn" : "ok"} />
        <Metric label="LLM 错误" value={summary.data?.llmErrors24h ?? 0} hint="连接 / 生成阶段" tone={(summary.data?.llmErrors24h ?? 0) > 0 ? "warn" : "ok"} />
      </div>

      <div className="diagnostics-workbench">
        <section className="diagnostics-filter">
          <h2>筛选</h2>
          <label>
            级别
            <select value={filters.level} onChange={(event) => setFilters({ ...filters, level: event.target.value })}>
              <option value="">全部</option>
              {["debug", "info", "warn", "error"].map((item) => <option value={item} key={item}>{item}</option>)}
            </select>
          </label>
          <label>
            类别
            <select value={filters.category} onChange={(event) => setFilters({ ...filters, category: event.target.value })}>
              <option value="">全部</option>
              {["http", "source_import", "kb_build", "llm", "release", "mcp", "db", "system"].map((item) => <option value={item} key={item}>{item}</option>)}
            </select>
          </label>
          <label>
            状态
            <select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}>
              <option value="">全部</option>
              {["started", "completed", "failed", "event"].map((item) => <option value={item} key={item}>{item}</option>)}
            </select>
          </label>
          <label>
            Trace ID
            <input value={filters.traceId} onChange={(event) => setFilters({ ...filters, traceId: event.target.value })} placeholder="trc_..." />
          </label>
          <label>
            Run ID
            <input value={filters.runId} onChange={(event) => setFilters({ ...filters, runId: event.target.value })} placeholder="run_..." />
          </label>
          <label>
            Release ID
            <input value={filters.releaseId} onChange={(event) => setFilters({ ...filters, releaseId: event.target.value })} placeholder="rel_..." />
          </label>
          <label>
            Entity ID
            <input value={filters.entityId} onChange={(event) => setFilters({ ...filters, entityId: event.target.value })} placeholder="component / package / release" />
          </label>
          <label>
            关键词
            <input value={filters.q} onChange={(event) => setFilters({ ...filters, q: event.target.value })} placeholder="错误、阶段、路径" />
          </label>
          <button type="button" onClick={() => setFilters({ level: "", category: "", status: "", traceId: "", runId: "", releaseId: "", entityId: "", q: "" })}>
            清空筛选
          </button>
        </section>

        <section className="diagnostics-list">
          <div className="detail-head">
            <div>
              <h2>日志记录</h2>
              <p>{logs.data?.length ?? 0} 条，按时间倒序</p>
            </div>
            <button type="button" className="icon-button" title="刷新" onClick={() => logs.refetch()}>
              <RefreshCw size={16} />
            </button>
          </div>
          <div className="log-list">
            {(logs.data ?? []).map((log) => (
              <button
                type="button"
                className={selectedTraceId === log.traceId ? "log-row active" : "log-row"}
                key={log.logId}
                onClick={() => applyTrace(log.traceId)}
              >
                <span className="log-row-top">
                  <Badge label={log.level} tone={log.level === "error" ? "hot" : log.level === "warn" ? "warn" : "ok"} />
                  <Badge label={log.category} />
                  <strong>{log.message}</strong>
                  <small>{formatTime(log.createdAt)}</small>
                </span>
                <span className="log-row-meta">
                  <code>{log.traceId}</code>
                  {log.runId && <code>{log.runId}</code>}
                  {log.releaseId && <code>{log.releaseId}</code>}
                  {log.durationMs !== null && <span>{log.durationMs}ms</span>}
                </span>
                {log.errorMessage && <span className="log-error">{log.errorMessage}</span>}
              </button>
            ))}
            {(logs.data ?? []).length === 0 && <EmptyWork title="没有匹配日志" body="调整筛选条件或触发一次导入、构建、发布、MCP 查询。" />}
          </div>
        </section>

        <section className="diagnostics-trace">
          <div className="detail-head">
            <div>
              <h2>Trace 时间线</h2>
              <p>{selectedTraceId || "选择一条日志查看完整链路"}</p>
            </div>
            {selectedTraceId && <button type="button" onClick={() => navigator.clipboard?.writeText(selectedTraceId)}>复制 trace</button>}
          </div>
          <div className="trace-timeline">
            {(trace.data ?? []).map((log) => (
              <article className={`trace-step ${log.status}`} key={log.logId}>
                <div>
                  <Badge label={log.status} tone={log.status === "failed" ? "hot" : log.level === "warn" ? "warn" : "ok"} />
                  <strong>{log.message}</strong>
                  <span>{log.durationMs !== null ? `${log.durationMs}ms` : formatTime(log.createdAt)}</span>
                </div>
                <code>{log.spanId}</code>
                {(log.runId || log.releaseId || log.entityId) && (
                  <small>{[log.runId, log.releaseId, log.entityId].filter(Boolean).join(" / ")}</small>
                )}
                {log.errorStack && <pre>{log.errorStack}</pre>}
              </article>
            ))}
            {selectedTraceId && trace.isLoading && <Loading title="正在读取 trace" />}
            {!selectedTraceId && selectedLog && (
              <article className="trace-step event">
                <div>
                  <Badge label={selectedLog.status} />
                  <strong>{selectedLog.message}</strong>
                </div>
                <pre>{JSON.stringify({ context: selectedLog.context, requestPayload: selectedLog.requestPayload }, null, 2)}</pre>
              </article>
            )}
          </div>
        </section>
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
          <input value={path} onChange={(event) => setPath(event.target.value)} />
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

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
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
