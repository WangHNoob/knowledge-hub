import { useState } from "react";

import { Tabs, type TabItem } from "../components/Atoms";
import { Legislation } from "./Legislation";
import { GovernanceProfile } from "./GovernanceProfile";
import { TableAliases } from "./TableAliases";

type RulesTab = "legislation" | "governance" | "aliases";

const TABS: TabItem<RulesTab>[] = [
  { id: "legislation", label: "策划立法" },
  { id: "governance", label: "治理规则" },
  { id: "aliases", label: "翻译表" }
];

export function Rules() {
  const [tab, setTab] = useState<RulesTab>("legislation");
  return (
    <>
      <Tabs items={TABS} active={tab} onChange={setTab} />
      <div className="tab-panel" key={tab}>
        {tab === "legislation" && <Legislation />}
        {tab === "governance" && <GovernanceProfile />}
        {tab === "aliases" && <TableAliases />}
      </div>
    </>
  );
}
