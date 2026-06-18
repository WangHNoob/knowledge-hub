import {
  Activity,
  Archive,
  Boxes,
  Bug,
  CheckCircle2,
  Database,
  GitBranch,
  HardDrive,
  LogOut,
  PackagePlus,
  ScrollText,
  Search,
  SearchCheck
} from "lucide-react";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { getToken, searchAll, setToken } from "../api";
import type { SearchHit } from "../api";
import { AgentFeedback } from "../pages/AgentFeedback";
import { Assets } from "../pages/Assets";
import { Dashboard } from "../pages/Dashboard";
import { Diagnostics } from "../pages/Diagnostics";
import { KnowledgeBuilder } from "../pages/KnowledgeBuilder";
import { Legislation } from "../pages/Legislation";
import { LoginScreen } from "../pages/Login";
import { Maintenance } from "../pages/Maintenance";
import { Release } from "../pages/Release";
import { Review } from "../pages/Review";
import { Sources } from "../pages/Sources";
import { Storage } from "../pages/Storage";
import { NavProvider, useNav, type NavParams, type View } from "./navigation";

const NAV: Array<{ id: View; label: string; icon: typeof Activity }> = [
  { id: "dashboard", label: "首页", icon: Activity },
  { id: "sources", label: "资料库", icon: Database },
  { id: "legislation", label: "策划立法", icon: ScrollText },
  { id: "builder", label: "知识构建", icon: PackagePlus },
  { id: "assets", label: "知识资产", icon: Boxes },
  { id: "review", label: "审核中心", icon: CheckCircle2 },
  { id: "release", label: "发布", icon: GitBranch },
  { id: "agent", label: "Agent 反馈", icon: SearchCheck },
  { id: "storage", label: "存储治理", icon: HardDrive },
  { id: "diagnostics", label: "运行诊断", icon: Bug },
  { id: "maintenance", label: "高级维护", icon: Archive }
];

export function App() {
  const [token, updateToken] = useState(getToken());
  const [view, setView] = useState<View>("dashboard");
  const [navParams, setNavParams] = useState<NavParams>({});
  const queryClient = useQueryClient();

  const navigate = (next: View, params: NavParams = {}) => {
    setNavParams(params);
    setView(next);
  };

  if (!token) {
    return <LoginScreen onLogin={(next) => {
      setToken(next);
      updateToken(next);
    }} />;
  }

  return (
    <NavProvider value={{ navigate, params: navParams }}>
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
          {view === "dashboard" && <Dashboard />}
          {view === "sources" && <Sources />}
          {view === "builder" && <KnowledgeBuilder onShowPackage={(packageId) => navigate("assets", { packageId })} />}
          {view === "legislation" && <Legislation />}
          {view === "assets" && <Assets />}
          {view === "review" && <Review />}
          {view === "release" && <Release />}
          {view === "agent" && <AgentFeedback />}
          {view === "storage" && <Storage />}
          {view === "diagnostics" && <Diagnostics />}
          {view === "maintenance" && <Maintenance />}
        </main>
        <a className="deerflow" href="https://deerflow.tech" target="_blank" rel="noreferrer" title="Created By Deerflow">
          DF
        </a>
      </div>
    </NavProvider>
  );
}

function GlobalSearch() {
  const { navigate } = useNav();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const trimmed = q.trim();
  const search = useQuery({
    queryKey: ["search", trimmed],
    queryFn: () => searchAll(trimmed),
    enabled: trimmed.length > 0
  });

  const go = (hit: SearchHit) => {
    setOpen(false);
    setQ("");
    if (hit.kind === "package") navigate("assets", { packageId: hit.id });
    else if (hit.kind === "component") navigate("assets", { packageId: hit.packageId, componentId: hit.id });
    else if (hit.kind === "source_version") navigate("sources", { versionId: hit.id });
    else if (hit.kind === "release") navigate("release", { releaseId: hit.id });
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
