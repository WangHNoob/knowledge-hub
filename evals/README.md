# StarTrail 黄金测评集（Golden Evaluation Set）v3 扩充版

用于评测 AI Agent 对《星轨猎手》(StarTrail) 模拟知识库（`gamedocs/` 49 篇策划文档 + `gamedata/` 204 张 CSV 配表，v0.2 扩充）的检索、推理与防幻觉能力。

> ⚠️ 本测评集与知识库 **v0.2** 绑定：若 ID 注册表、公式（01-1/02-1）、配表行发生变更，必须同步更新 `golden_evals.json`（尤其 `meta.idRegistry` 与各 case 的 `keyFacts`/`numPairs`），并重跑审计。

## 文件结构

| 文件 | 说明 |
|------|------|
| `golden_evals.json` | **78 道黄金用例**（7 分组，难度 1–4）：v0.1 回归 30 题（EV-001~030）+ v0.2 新增 48 题（EV-031~078），含题目/参考答案/keyFacts/numPairs/来源文件/评分说明 |
| `run_eval.py` | 自动打分脚本 v3（严格匹配：纯数字精确、≈ 前缀才容差、字段=值解析、未注册 ID 幻觉检测；**ID 注册表已扩展至 v0.2 全量 90+ 族**） |
| `audit_evals.py` | **数值审计脚本**：从知识库 CSV 程序化重算 47 个用例的关键数值并断言，机器证明「评测集数值零错误」 |
| `answers.example.json` | 满分示例回答（严格格式），可直接试跑验证管线 |
| `run_query_mode_eval.py` | 查询模式作答器：登录后逐题调 Agent 查询生成 answers（输出 `answers.query_mode.json` + traces） |
| `retrieval-gold.json` | **发布门禁基线**（与 golden_evals 不同用途）：78 题 × 每题 kb_search top-3 命中文档标题。自动发布前/后跑 `npm run eval:retrieval`，hit@k < 0.85 挡发布或触发自动回滚。**基线随发布内容变化重生成**（`npx tsx scripts/eval-retrieval.ts` 依赖它） |

## 数值质量保证（v3 核心改进）

1. **机器审计而非人工声明**：`audit_evals.py` 读取知识库配表，程序化重算 47 个可验证用例（v0.1 23 个 + v0.2 新增 24 个：卡池概率/保底、掉落权重合计、技能 L10 倍率、战力公式、强化成功率、体力价格、突破消耗、命座槽位、公会点产出等），与黄金集逐项比对；当前结论 **47/47 一致**。
2. **数值精确匹配**：keyFacts 纯数字默认精确匹配（不做容差）；仅文档明确标注「约」的值用 `≈` 前缀 + 5% 容差。
3. **字段=值校验**：数值题须以英文字段名（与配表表头一致）作答，如 `cdSec=6`、`recommendPower=15000`、`probability=0.006`；无字段名标注的裸数字不予采信。
4. **ID 幻觉检测覆盖 v0.2 全量**：`run_eval.py` 的 ID 注册表与 `knowledge_gen/validate.mjs` 的 ID_FAMILIES 对齐（H/SK/BF/WP/EQ/DG/DR/SH/MAT/S/M/B/EM/IT/QS/AC/CN/TN/SN/TI/NC/GP/TF/AF/TB/EX/EV/WB/SM/RG/NP/FU/AR/RM/GB/PT/WC/ED/CD/MS/AI/RC/ML/CX/WY/LS/TH/LT/WH/RB/TC/PZ/HQ/WK/DK/TM/MG/FP/GEX/GD/WSK/WBS/ADR/DIA/BM/TR/GV/GBL/SC/CAT/PS/SB/TRL/EMO/AFR/CB/BS/PM/MILE/DGR/CC/SHL/DT/HF/ER/WT/R/EXC/CH/GQ）；回答中出现注册表外 ID 记入幻觉记录，`anti_hallucination` 题直接 FAIL（题目自带 `fakeId` 除外）。

## 用例分组（78 题，v0.2 覆盖矩阵）

| 分组 | 数量 | 难度 | 考核点 |
|------|------|------|--------|
| basic_retrieval 基础检索 | 13 | 1 | 主键→行定位（含 v0.2 新表：GachaPool/Monster/Quest/Item/TeamBuff） |
| cross_table 跨表外键 | 14 | 2 | FK 导航（技能组/通用被动池/首领阶段/命座/远征/世界Boss排期/卡池UP/任务奖励） |
| formula_calc 数值计算 | 14 | 2–3 | 技能成长 L10=L1×1.8、战力公式 02-1、卡池概率 0.006、掉落权重=1000、强化成功率、体力价格、武器 L80 曲线 |
| economy_loop 经济闭环 | 11 | 3 | 抽卡副产物兑换、公会点闭环、远征→锻造→强化、活动代币过期、签到链、突破消耗、强化金币缺口 |
| consistency 一致性审计 | 11 | 2 | coop 队伍战力口径、通用被动不升级、空 passiveSkillId、DR↔DG 一一对应、命座槽位唯一、概率全库唯一、元素抗性 |
| anti_hallucination 防幻觉 | 9 | 1–2 | 拒绝越界 ID（H017/SK073/DG041/BF031/GP009/IT201）、拒绝错误概率（6% vs 0.6%） |
| evidence_chain 证据链 | 6 | 3–4 | 链 A/B（v0.1）+ 链 C 卡池→角色→伤害、链 D 爬塔→词缀→阵容、链 E 远征→锻造→强化→关卡、链 F 公会→捐赠→商店→命座 |

## 使用方法

```bash
# 1. 让 Agent 逐题作答，保存为 JSON（{ "EV-001": "class=dps，rarity=5", ... }）
#    数值题要求带字段名，格式见 answers.example.json
# 2. 严格打分：
python run_eval.py --answers your_answers.json                 # 打印报告
python run_eval.py --answers your_answers.json --report out.md # 写 Markdown 报告
# 3. 数值审计（知识库变更后必跑）：
python audit_evals.py --kb-dir <知识库根目录>                    # 从 KB 重算比对
# 4. 查询模式作答（需服务运行 + 登录）：
python run_query_mode_eval.py                                   # 输出 answers.query_mode.json
# 5. 验收：脚本退出码均为 0 = 无 FAIL、无幻觉、数值全一致
```

## 评分规则（v3，见 golden_evals.json meta.scoring）

| 要素 | 匹配方式 |
|------|----------|
| keyFacts 普通 token | 精确子串（大小写敏感）：`BF004`、`maxStack=3`、`weight=700` |
| keyFacts 纯数字 | 精确数字：回答数字集合中必须存在该数（**不做容差**） |
| keyFacts `≈N` 前缀 | 数字容差匹配（默认 5%），仅限文档「约」值 |
| numPairs `[字段, 值]` | 回答须含「字段=值/字段:值/字段 值」，值精确匹配 |
| 未注册 ID | 任何题出现注册表外 ID 记入幻觉记录；`anti_hallucination` 题直接 FAIL（题目自带 `fakeId` 除外） |

综合得分 = (PASS×1 + PARTIAL×0.5) / 总题数 × 100；退出码 0 = 无 FAIL 且无幻觉。

## v3 验证状态（2026-08-09）

- `audit_evals.py`：**47/47 数值审计一致**（含 v0.2 新增 24 项）
- 黄金答案自测：**78/78 PASS（100 分）**——证明评测集与打分规则自洽（用 expectedAnswer 作答应满分）
- 知识库侧 `knowledge_gen/validate.mjs`：204 表 0 ERROR，文档 ID 全部可溯源

## 扩展指南

新增用例三要素：① 数值必须与配表实际行一致（先读 CSV 核对）；② 数值题 expectedAnswer 须含「字段=值」格式（打分器按此解析）；③ 在 `audit_evals.py` 加对应重算方法并注册进 `AUDITS`。知识库任何 ID/公式/行变更后，重跑 `audit_evals.py` + `run_eval.py` 回归。
