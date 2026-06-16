import {
  Activity,
  Archive,
  Boxes,
  Bug,
  CheckCircle2,
  Database,
  GitBranch,
  LogOut,
  PackagePlus,
  ScrollText,
  SearchCheck
} from "lucide-react";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { getToken, setToken } from "../api";
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

type View = "dashboard" | "sources" | "builder" | "legislation" | "assets" | "review" | "release" | "agent" | "diagnostics" | "maintenance";

const NAV: Array<{ id: View; label: string; icon: typeof Activity }> = [
  { id: "dashboard", label: "首页", icon: Activity },
  { id: "sources", label: "资料库", icon: Database },
  { id: "builder", label: "知识构建", icon: PackagePlus },
  { id: "legislation", label: "策划立法", icon: ScrollText },
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
  const [highlightedPackage, setHighlightedPackage] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const navigate = (next: View, packageId?: string) => {
    if (packageId) setHighlightedPackage(packageId);
    setView(next);
  };

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
        {view === "builder" && <KnowledgeBuilder onShowPackage={(packageId) => navigate("assets", packageId)} />}
        {view === "legislation" && <Legislation />}
        {view === "assets" && <Assets highlightedPackage={highlightedPackage} onConsumeHighlight={() => setHighlightedPackage(null)} />}
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
