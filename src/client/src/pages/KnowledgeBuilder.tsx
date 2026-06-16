import { ArrowRight, Bug, CheckCircle2, ChevronDown, ChevronRight, KeyRound, Play, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  buildKnowledgePackage,
  deleteBuildRun,
  listBuildRuns,
  listBundleVersions,
  stopBuildRun,
  testModelConnectivity,
  type BuildModelConfig,
  type KnowledgeBuildRun
} from "../api";
import { Badge, Page } from "../components/Atoms";
import { BuildRunCard } from "../components/BuildRunCard";

const BUILD_STAGES = ["convert", "extract", "tables", "graph", "viz"];
const MODEL_PREFS_KEY = "kh_builder_model_prefs";
type ModelProvider = "deterministic" | "openai-compatible" | "anthropic";

export function KnowledgeBuilder({ onShowPackage }: { onShowPackage: (packageId: string) => void }) {
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
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState("");
  const [modelTestMessage, setModelTestMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [completion, setCompletion] = useState<{ runId: string; packageId: string | null; status: "completed" | "failed"; error: string } | null>(null);
  const lastSeenStatus = useRef<Record<string, string>>({});

  const versions = useQuery({
    queryKey: ["bundle-versions", bundleId],
    queryFn: () => listBundleVersions(bundleId)
  });
  const runs = useQuery({
    queryKey: ["build-runs"],
    queryFn: listBuildRuns,
    refetchInterval: 2000
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

  useEffect(() => {
    if (!runs.data) return;
    for (const run of runs.data) {
      const previous = lastSeenStatus.current[run.runId];
      lastSeenStatus.current[run.runId] = run.status;
      if (!previous || previous === run.status) continue;
      if (previous === "running" && (run.status === "completed" || run.status === "failed")) {
        if (run.runId === activeRunId || !completion) {
          setCompletion({
            runId: run.runId,
            packageId: run.packageId,
            status: run.status as "completed" | "failed",
            error: run.error,
          });
          void queryClient.invalidateQueries({ queryKey: ["packages"] });
          void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
        }
      }
    }
  }, [activeRunId, completion, queryClient, runs.data]);

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
      setActiveRunId(result.run.runId);
      setCompletion(null);
      lastSeenStatus.current[result.run.runId] = result.run.status;
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
      subtitle="选一份资料版本，点一下，就生成一份知识资产包。"
    >
      {completion && (
        <div className={`completion-banner ${completion.status}`}>
          {completion.status === "completed" ? (
            <>
              <CheckCircle2 size={20} />
              <div>
                <strong>知识资产已生成</strong>
                <span>{completion.packageId ?? completion.runId}</span>
              </div>
              {completion.packageId && (
                <button className="primary-action" onClick={() => onShowPackage(completion.packageId!)}>
                  前往知识资产
                  <ArrowRight size={16} />
                </button>
              )}
              <button className="icon-button" onClick={() => setCompletion(null)} title="关闭">
                ×
              </button>
            </>
          ) : (
            <>
              <Bug size={20} />
              <div>
                <strong>构建失败</strong>
                <span>{completion.error || completion.runId}</span>
              </div>
              <button className="icon-button" onClick={() => setCompletion(null)} title="关闭">
                ×
              </button>
            </>
          )}
        </div>
      )}
      <section className="builder-layout">
        <div className="builder-main">
          <section className="builder-panel">
            <div className="detail-head">
              <div>
                <h2>构建输入</h2>
                <p>从已导入的资料版本生成一份知识资产包，过程会在右侧实时显示。</p>
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
            <button
              className="primary-action"
              disabled={!canStart}
              onClick={() => buildMutation.mutate()}
            >
              <Play size={16} />
              {buildMutation.isPending ? "启动中..." : "启动知识资产构建"}
            </button>
            {provider === "deterministic" && (
              <p className="notice subtle">
                当前使用确定性模式（仅做 pipeline 验证）。要生成高质量知识，请在"高级选项"切换并配置 LLM。
              </p>
            )}
            {error && <p className="error">{error}</p>}
            <button type="button" className="advanced-toggle" onClick={() => setShowAdvanced((flag) => !flag)}>
              {showAdvanced ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              高级选项（pipeline 阶段、LLM 设置、强制重建）
            </button>
            {showAdvanced && (
              <div className="advanced-panel">
                <div className="advanced-section">
                  <h3>Pipeline 阶段</h3>
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
                </div>
                <div className="advanced-section">
                  <h3>大模型设置</h3>
                  <label className="field-label model-provider">
                    LLM Provider
                    <select value={provider} onChange={(event) => selectProvider(event.target.value as ModelProvider)}>
                      <option value="deterministic">确定性（仅验证 pipeline）</option>
                      <option value="openai-compatible">OpenAI-compatible</option>
                      <option value="anthropic">Anthropic</option>
                    </select>
                  </label>
                  {provider !== "deterministic" && (
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
                  </div>
                  {modelTestMessage && (
                    <p className={modelTestMessage.ok ? "notice" : "error"}>{modelTestMessage.text}</p>
                  )}
                </div>
              </div>
            )}
          </section>
        </div>

        <aside className="builder-runs">
          <div className="detail-head">
            <div>
              <h2>构建进度</h2>
              <p>每 2 秒自动刷新；可随时切到其他页面，回来仍可见。</p>
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
                onShowPackage={onShowPackage}
                busy={stopRunMutation.isPending || deleteRunMutation.isPending}
              />
            ))}
          </div>
        </aside>
      </section>
    </Page>
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
