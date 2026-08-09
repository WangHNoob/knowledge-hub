# StarTrail 检索初测报告（基于黄金测评集）

- 发布库: `http://localhost:4174` / project=`default_project` / topK=5
- 用例数: 30
- 检索命中率 hit@k: **30/30 = 100.0%**
- keyFacts 在命中片段中的平均覆盖率: **53.7%**

> 判定：topK 结果的 title/sourceRefs/snippet 命中 `sourceFiles` 派生针，或 keyFacts 覆盖 ≥50%。
> 这是**检索初测**，不是完整 Agent 作答打分（完整作答请用 `run_eval.py`）。

## 分组表现

| 分组 | HIT | MISS | hit@k | avg factCoverage |
|------|-----|------|-------|------------------|
| 基础检索（单表） (basic_retrieval) | 5 | 0 | 100% | 36% |
| 跨表外键（1-2 跳） (cross_table) | 6 | 0 | 100% | 68% |
| 数值计算（公式复现） (formula_calc) | 6 | 0 | 100% | 47% |
| 经济闭环（跨文档联动） (economy_loop) | 4 | 0 | 100% | 45% |
| 一致性审计（枚举/口径） (consistency) | 4 | 0 | 100% | 40% |
| 防幻觉（拒绝编造） (anti_hallucination) | 3 | 0 | 100% | 92% |
| 证据链（多跳推理） (evidence_chain) | 2 | 0 | 100% | 62% |

## 明细

| ID | 分组 | 结果 | factCoverage | topTitles |
|----|------|------|--------------|-----------|
| EV-001 | basic_retrieval | HIT | 40% | 05-角色与职业体系.md / 00-项目总览与术语表.md / 08-掉落与经济闭环.md |
| EV-002 | basic_retrieval | HIT | 25% | 04-buff与状态机.md / 03-技能系统设计.md / 09-商店与兑换规则.md |
| EV-003 | basic_retrieval | HIT | 50% | 07-副本与关卡节奏.md / 02-属性体系与战力评估.md / 10-配表规范与外键约定.md |
| EV-004 | basic_retrieval | HIT | 40% | 04-buff与状态机.md / 03-技能系统设计.md / 00-项目总览与术语表.md |
| EV-005 | basic_retrieval | HIT | 25% | 00-项目总览与术语表.md / 05-角色与职业体系.md / 03-技能系统设计.md |
| EV-006 | cross_table | HIT | 100% | 00-项目总览与术语表.md / 08-掉落与经济闭环.md / 02-属性体系与战力评估.md |
| EV-007 | cross_table | HIT | 75% | 01-战斗框架与伤害公式.md / 05-角色与职业体系.md / 04-buff与状态机.md |
| EV-008 | cross_table | HIT | 33% | 05-角色与职业体系.md / 00-项目总览与术语表.md / 03-技能系统设计.md |
| EV-009 | cross_table | HIT | 50% | 08-掉落与经济闭环.md / 07-副本与关卡节奏.md / 02-属性体系与战力评估.md |
| EV-010 | cross_table | HIT | 75% | 09-商店与兑换规则.md / 08-掉落与经济闭环.md / ungrouped.md |
| EV-011 | cross_table | HIT | 75% | 06-武器与装备系统.md / 08-掉落与经济闭环.md / ungrouped.md |
| EV-012 | formula_calc | HIT | 50% | 06-武器与装备系统.md / 02-属性体系与战力评估.md / 12-版本变更记录-v0-1.md |
| EV-013 | formula_calc | HIT | 50% | 02-属性体系与战力评估.md / 12-版本变更记录-v0-1.md / 06-武器与装备系统.md |
| EV-014 | formula_calc | HIT | 100% | 00-项目总览与术语表.md / 05-角色与职业体系.md / 10-配表规范与外键约定.md |
| EV-015 | formula_calc | HIT | 0% | 01-战斗框架与伤害公式.md / 04-buff与状态机.md / 07-副本与关卡节奏.md |
| EV-016 | formula_calc | HIT | 50% | 12-版本变更记录-v0-1.md / 03-技能系统设计.md / 02-属性体系与战力评估.md |
| EV-017 | formula_calc | HIT | 33% | 02-属性体系与战力评估.md / 08-掉落与经济闭环.md / ungrouped.md |
| EV-018 | economy_loop | HIT | 60% | 05-角色与职业体系.md / 06-武器与装备系统.md / 10-配表规范与外键约定.md |
| EV-019 | economy_loop | HIT | 20% | 10-配表规范与外键约定.md / 00-项目总览与术语表.md / 07-副本与关卡节奏.md |
| EV-020 | economy_loop | HIT | 67% | 02-属性体系与战力评估.md / 08-掉落与经济闭环.md / 10-配表规范与外键约定.md |
| EV-021 | economy_loop | HIT | 33% | 09-商店与兑换规则.md / 10-配表规范与外键约定.md / 08-掉落与经济闭环.md |
| EV-022 | consistency | HIT | 60% | 11-边界异常与qa检查清单.md / 07-副本与关卡节奏.md / 08-掉落与经济闭环.md |
| EV-023 | consistency | HIT | 50% | 00-项目总览与术语表.md / 02-属性体系与战力评估.md / 08-掉落与经济闭环.md |
| EV-024 | consistency | HIT | 0% | 01-战斗框架与伤害公式.md / 10-配表规范与外键约定.md / 05-角色与职业体系.md |
| EV-025 | consistency | HIT | 50% | 08-掉落与经济闭环.md / 11-边界异常与qa检查清单.md / 03-技能系统设计.md |
| EV-026 | anti_hallucination | HIT | 100% | 00-项目总览与术语表.md / 09-商店与兑换规则.md / ungrouped.md |
| EV-027 | anti_hallucination | HIT | 100% | 05-角色与职业体系.md / 01-战斗框架与伤害公式.md / 03-技能系统设计.md |
| EV-028 | anti_hallucination | HIT | 75% | 04-buff与状态机.md / 00-项目总览与术语表.md / 03-技能系统设计.md |
| EV-029 | evidence_chain | HIT | 40% | 00-项目总览与术语表.md / 09-商店与兑换规则.md / 08-掉落与经济闭环.md |
| EV-030 | evidence_chain | HIT | 83% | 08-掉落与经济闭环.md / 09-商店与兑换规则.md / 07-副本与关卡节奏.md |
