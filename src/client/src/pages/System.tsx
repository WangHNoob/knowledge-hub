import { useState } from "react";

import { Page, Tabs, type TabItem } from "../components/Atoms";
import { Storage } from "./Storage";
import { Diagnostics } from "./Diagnostics";
import { Maintenance } from "./Maintenance";

type SystemTab = "storage" | "diagnostics" | "maintenance";

const TABS: TabItem<SystemTab>[] = [
  { id: "storage", label: "存储治理" },
  { id: "diagnostics", label: "运行诊断" },
  { id: "maintenance", label: "高级维护" }
];

export function System() {
  const [tab, setTab] = useState<SystemTab>("storage");
  return (
    <Page title="系统" subtitle="存储治理、运行诊断与高级维护的统一入口。">
      <Tabs items={TABS} active={tab} onChange={setTab} />
      <div className="tab-panel" key={tab}>
        {tab === "storage" && <Storage />}
        {tab === "diagnostics" && <Diagnostics />}
        {tab === "maintenance" && <Maintenance />}
      </div>
    </Page>
  );
}
