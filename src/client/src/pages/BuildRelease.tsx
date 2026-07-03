import { useState } from "react";

import { Page, Tabs, type TabItem } from "../components/Atoms";
import { KnowledgeBuilder } from "./KnowledgeBuilder";
import { Release } from "./Release";

type BuildReleaseTab = "build" | "release";

const TABS: TabItem<BuildReleaseTab>[] = [
  { id: "build", label: "知识构建" },
  { id: "release", label: "发布管理" }
];

export function BuildRelease() {
  const [tab, setTab] = useState<BuildReleaseTab>("build");
  return (
    <Page title="构建发布" subtitle="从资料构建知识资产，经质量门禁后发布给 Agent 消费。">
      <Tabs items={TABS} active={tab} onChange={setTab} />
      <div className="tab-panel" key={tab}>
        {tab === "build" && <KnowledgeBuilder onShowPackage={() => {}} />}
        {tab === "release" && <Release />}
      </div>
    </Page>
  );
}
