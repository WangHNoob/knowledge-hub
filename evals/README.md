# StarTrail 黄金测评集（Golden Evaluation Set）v2 严格版

用于评测 AI Agent 对《星轨猎手》(StarTrail) 模拟知识库（`gamedocs/` 13 篇策划文档 + `gamedata/` 12 张 CSV 配表）的检索、推理与防幻觉能力。

> ⚠️ 本测评集与知识库 **v0.1** 绑定：若 ID 注册表、公式（01-1/02-1）、配表行发生变更，必须同步更新 `golden_evals.json`（尤其 `meta.idRegistry` 与各 case 的 `keyFacts`/`numPairs`），并重跑审计。

## 文件结构

| 文件 | 说明 |
|------|------|
| `golden_evals.json` | 30 道黄金用例（7 分组，难度 1–4），含题目/参考答案/keyFacts/numPairs/来源文件/评分说明 |
| `run_eval.py` | 自动打分脚本 v2（严格匹配：纯数字精确、≈ 前缀才容差、字段=值解析、未注册 ID 幻觉检测） |
| `audit_evals.py` | **数值审计脚本**：从知识库 CSV/文档程序化重算 23 个用例的关键数值并断言，机器证明「评测集数值零错误」 |
| `answers.example.json` | 满分示例回答（严格格式），可直接试跑验证管线 |

## 数值质量保证（v2 核心改进）

1. **机器审计而非人工声明**：`audit_evals.py` 读取知识库配表，程序化重算 23 个可验证用例（如 EV-012 战力公式重算=4871、EV-017 满配重算≈17766、EV-018 突破聚合=490000/34/26、EV-022 保底清单、EV-023 4★ 清单），与黄金集逐项比对；当前结论 **23/23 一致**。
2. **数值精确匹配**：keyFacts 纯数字默认精确匹配（不做容差）；仅文档明确标注「约」的值用 `≈` 前缀 + 5% 容差（如 `≈4900`、`≈17800`）。
3. **去除宽泛数字**：v1 中 `5`、`1` 这类可被任意回答误命中的裸数字已全部移除，替换为带字段名的精确 token（`rarity=5`、`maxStack=1`）或纳入 `numPairs`。
4. **字段=值校验**：数值题须以英文字段名（与配表表头一致）作答，如 `cdSec=6`、`recommendPower=15000`；无字段名标注的裸数字不予采信。

## 用例分组（30 题）

| 分组 | 数量 | 难度 | 考核点 |
|------|------|------|--------|
| basic_retrieval 基础检索 | 5 | 1 | 主键→行定位、字段语义 |
| cross_table 跨表外键 | 6 | 2 | FK 导航（Skill.heroId / Weapon.passiveSkillId / Dungeon.dropId / ShopItem.itemType 等） |
| formula_calc 数值计算 | 6 | 2–3 | 伤害公式 01-1、战力公式 02-1 复现 |
| economy_loop 经济闭环 | 4 | 3 | 突破消耗、体力分配、强化周期、防通胀缺口 |
| consistency 一致性审计 | 4 | 2 | 枚举唯一性、pity 语义、rarity 联动、克制方向 |
| anti_hallucination 防幻觉 | 3 | 2 | 拒绝未注册 ID（H009/SK033）、拒绝同义术语（「燃烧」→BF001 灼烧） |
| evidence_chain 证据链 | 2 | 4 | 链 A（4 跳：DG009→DR009→EQ005→H003）、链 B（5 跳：DG006→…→H002→DG004） |

## 使用方法

```bash
# 1. 让 Agent 逐题作答，保存为 JSON（{ "EV-001": "class=dps，rarity=5", ... }）
#    数值题要求带字段名，格式见 answers.example.json
# 2. 严格打分：
python run_eval.py --answers your_answers.json                 # 打印报告
python run_eval.py --answers your_answers.json --report out.md # 写 Markdown 报告
# 3. 数值审计（知识库变更后必跑）：
python audit_evals.py --kb-dir G:\projects\test-data            # 从 KB 重算比对
# 4. 验收：两个脚本退出码均为 0 = 无 FAIL、无幻觉、数值全一致
```

## 评分规则（v2，见 golden_evals.json meta.scoring）

| 要素 | 匹配方式 |
|------|----------|
| keyFacts 普通 token | 精确子串（大小写敏感）：`BF004`、`maxStack=3`、`weight=700` |
| keyFacts 纯数字 | 精确数字：回答数字集合中必须存在该数（**不做容差**） |
| keyFacts `≈N` 前缀 | 数字容差匹配（默认 5%），仅限文档「约」值 |
| numPairs `[字段, 值]` | 回答须含「字段=值/字段:值/字段 值」，值精确匹配 |
| 未注册 ID | 任何题出现注册表外 ID（H009/SK033/WP009…）记入幻觉记录；`anti_hallucination` 题直接 FAIL（题目自带 `fakeId` 除外） |

综合得分 = (PASS×1 + PARTIAL×0.5) / 总题数 × 100；退出码 0 = 无 FAIL 且无幻觉。

## 扩展指南

- 新增用例：`id` 唯一（EV-031…）、`group` 取 `meta.groupLabels` 已有值、`keyFacts` 用稳定 token（ID 优先），数值一律放入 `numPairs` 或带字段名。
- 新增可审计用例：在 `audit_evals.py` 的 `Auditor` 中加 `evXXX()` 方法（返回 `[(字段, 实际值, 期望值), …]`），并登记到 `AUDITS`。
- 知识库改表后：先跑 `audit_evals.py` 定位不一致，再同步 golden_evals.json。

## 已知限制

- `numPairs` 依赖字段名出现，回答未按约定格式（纯自然语言）会被判字段缺失——这是**有意为之**的严格性，README 已声明约定。
- 数值比对按集合成员判断，无法自动区分正负语义（如 `-30%` 与 `30` 可能误命中），`-30%` 类负值请通过 keyFacts 上下文（如 `BF004`）间接约束，必要时人工复核。
- 语义幻觉（把 BF003 冻结说成灼烧）需配合 `expectedAnswer` 人工比对，脚本只拦截 ID 级幻觉。
