import {
  Activity,
  Boxes,
  CheckCircle2,
  Database,
  HardDrive,
  LogOut,
  PackagePlus,
  ScrollText,
  Search,
  SearchCheck
} from "lucide-react";
import { lazy, startTransition, Suspense, useCallback, useDeferredValue, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { createProject, getToken, listProjects, searchAll, selectProject, setToken } from "../api";
import type { SearchHit } from "../api";
import { LoginScreen } from "../pages/Login";
import { useDebouncedValue } from "../utils/react";
import { NavProvider, useNav, type NavParams, type View } from "./navigation";
import { ProjectProvider, useProject } from "./projectContext";

const loadDashboard = () => import("../pages/Dashboard").then((module) => ({ default: module.Dashboard }));
const loadSources = () => import("../pages/Sources").then((module) => ({ default: module.Sources }));
const loadRules = () => import("../pages/Rules").then((module) => ({ default: module.Rules }));
const loadBuildRelease = () => import("../pages/BuildRelease").then((module) => ({ default: module.BuildRelease }));
const loadAssets = () => import("../pages/Assets").then((module) => ({ default: module.Assets }));
const loadReview = () => import("../pages/Review").then((module) => ({ default: module.Review }));
const loadAgentFeedback = () => import("../pages/AgentFeedback").then((module) => ({ default: module.AgentFeedback }));
const loadSystem = () => import("../pages/System").then((module) => ({ default: module.System }));

const Dashboard = lazy(loadDashboard);
const Sources = lazy(loadSources);
const Rules = lazy(loadRules);
const BuildRelease = lazy(loadBuildRelease);
const Assets = lazy(loadAssets);
const Review = lazy(loadReview);
const AgentFeedback = lazy(loadAgentFeedback);
const System = lazy(loadSystem);

const PAGE_PRELOADERS: Record<View, () => Promise<unknown>> = {
  dashboard: loadDashboard,
  sources: loadSources,
  rules: loadRules,
  buildrelease: loadBuildRelease,
  assets: loadAssets,
  review: loadReview,
  agent: loadAgentFeedback,
  system: loadSystem
};

const NAV: Array<{ id: View; label: string; icon: typeof Activity }> = [
  { id: "dashboard", label: "飞轮工作台", icon: Activity },
  { id: "sources", label: "资料库", icon: Database },
  { id: "rules", label: "规则治理", icon: ScrollText },
  { id: "buildrelease", label: "构建发布", icon: PackagePlus },
  { id: "assets", label: "知识资产", icon: Boxes },
  { id: "review", label: "审核中心", icon: CheckCircle2 },
  { id: "agent", label: "Agent 反馈", icon: SearchCheck },
  { id: "system", label: "系统", icon: HardDrive },
];

export function App() {
  const [token, updateToken] = useState(getToken());
  const [view, setView] = useState<View>("dashboard");
  const [navParams, setNavParams] = useState<NavParams>({});
  const queryClient = useQueryClient();
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: listProjects,
    enabled: Boolean(token)
  });
  const switchProjectMutation = useMutation({
    mutationFn: selectProject,
    onSuccess: async () => {
      await queryClient.invalidateQueries();
    }
  });
  const createProjectMutation = useMutation({
    mutationFn: createProject,
    onSuccess: async (result) => {
      await selectProject(result.project.projectId);
      await queryClient.invalidateQueries();
    }
  });

  const navigate = useCallback((next: View, params: NavParams = {}) => {
    startTransition(() => {
      setNavParams(params);
      setView(next);
    });
  }, []);
  const navValue = useMemo(() => ({ navigate, params: navParams }), [navigate, navParams]);

  if (!token) {
    return <LoginScreen onLogin={(next) => {
      setToken(next);
      updateToken(next);
    }} />;
  }

  const currentProjectId = projects.data?.currentProjectId ?? "default_project";
  const projectValue = {
    projects: projects.data?.projects ?? [],
    currentProjectId,
    loading: projects.isLoading,
    switching: switchProjectMutation.isPending || createProjectMutation.isPending,
    switchProject: async (projectId: string) => {
      await switchProjectMutation.mutateAsync(projectId);
    },
    createProject: async (input: { name: string; description?: string }) => {
      await createProjectMutation.mutateAsync(input);
    }
  };

  return (
    <ProjectProvider value={projectValue}>
    <NavProvider value={navValue}>
      <div className="shell">
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-mark">KH</div>
            <div>
              <strong>Knowledge Hub</strong>
              <span>资产飞轮管理台</span>
            </div>
          </div>
          <ProjectSwitcher />
          <nav>
            {NAV.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  className={view === item.id ? "nav-item active" : "nav-item"}
                  onFocus={() => { void PAGE_PRELOADERS[item.id](); }}
                  onMouseEnter={() => { void PAGE_PRELOADERS[item.id](); }}
                  onClick={() => navigate(item.id)}
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
          <div className="topbar">
            <GlobalSearch />
          </div>
          <Suspense fallback={<div className="state">正在加载页面...</div>}>
            {view === "dashboard" && <Dashboard />}
            {view === "sources" && <Sources />}
            {view === "rules" && <Rules />}
            {view === "buildrelease" && <BuildRelease />}
            {view === "assets" && <Assets />}
            {view === "review" && <Review />}
            {view === "agent" && <AgentFeedback />}
            {view === "system" && <System />}
          </Suspense>
        </main>
        <a className="deerflow" href="https://deerflow.tech" target="_blank" rel="noreferrer" title="Created By Deerflow">
          DF
        </a>
      </div>
    </NavProvider>
    </ProjectProvider>
  );
}

function ProjectSwitcher() {
  const { projects, currentProjectId, currentProject, loading, switching, switchProject, createProject } = useProject();
  return (
    <div className="project-switcher">
      <label>游戏项目</label>
      <div className="project-select-row">
        <select
          value={currentProjectId}
          disabled={loading || switching}
          onChange={(event) => { void switchProject(event.target.value); }}
        >
          {projects.map((project) => (
            <option key={project.projectId} value={project.projectId}>{project.name}</option>
          ))}
        </select>
        <button
          type="button"
          disabled={switching}
          title="新建项目"
          onClick={() => {
            const name = window.prompt("新游戏项目名称");
            if (!name?.trim()) return;
            void createProject({ name: name.trim() });
          }}
        >
          +
        </button>
      </div>
      <small>{currentProject?.projectId ?? "default_project"}</small>
    </div>
  );
}

function GlobalSearch() {
  const { navigate } = useNav();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const trimmed = q.trim();
  const deferredQuery = useDeferredValue(trimmed);
  const debouncedQuery = useDebouncedValue(deferredQuery, 250);
  const search = useQuery({
    queryKey: ["search", debouncedQuery],
    queryFn: () => searchAll(debouncedQuery),
    enabled: debouncedQuery.length > 0,
    placeholderData: (previous) => previous
  });

  const go = (hit: SearchHit) => {
    setOpen(false);
    setQ("");
    if (hit.kind === "package") navigate("assets", { packageId: hit.id });
    else if (hit.kind === "component") navigate("assets", { packageId: hit.packageId, componentId: hit.id });
    else if (hit.kind === "source_version") navigate("sources", { versionId: hit.id });
    else if (hit.kind === "release") navigate("buildrelease", { releaseId: hit.id });
  };

  const hits = search.data?.hits ?? [];
  return (
    <div className="global-search">
      <div className="global-search-input">
        <Search size={16} />
        <input
          value={q}
          placeholder="全局搜索：资产包 / 组件 / 资料版本 / 发布"
          onChange={(event) => { setQ(event.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        />
      </div>
      {open && trimmed.length > 0 && (
        <div className="global-search-results">
          {search.isLoading && <p className="subtle">搜索中…</p>}
          {!search.isLoading && hits.length === 0 && <p className="subtle">无匹配结果</p>}
          {hits.map((hit) => (
            <button key={`${hit.kind}-${hit.id}`} className="search-hit" onMouseDown={() => go(hit)}>
              <strong>{hit.title}</strong>
              <span>{hit.subtitle}</span>
              <code>{hit.id}</code>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
