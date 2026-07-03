import { useState } from "react";

import { Tabs, type TabItem } from "../components/Atoms";
import { Legislation } from "./Legislation";
import { TableAliases } from "./TableAliases";

type RulesTab = "legislation" | "aliases";

const TABS: TabItem<RulesTab>[] = [
  { id: "legislation", label: "策划立法" },
  { id: "aliases", label: "翻译表" }
];

export function Rules() {
  const [tab, setTab] = useState<RulesTab>("legislation");
  return (
    <>
      <Tabs items={TABS} active={tab} onChange={setTab} />
      <div className="tab-panel" key={tab}>
        {tab === "legislation" && <Legislation />}
        {tab === "aliases" && <TableAliases />}
      </div>
    </>
  );
}
