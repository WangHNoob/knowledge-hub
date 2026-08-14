# 任务提示词：修复黄金评测集过时项与知识库文档口径冲突

> 本文件是交给**另一个 agent** 的任务提示词。你的职责范围仅限 `knowledge-hub` 工程（`C:\Users\aaaab\Desktop\个人项目\knowledge-hub`），**禁止修改 design-agent-ts 与 agent-observe 的任何代码**。

---

## 一、背景

2026-08-10 在更新后的知识库（release `rel_20260809142245_mSJBqC`，含 22:34-22:36 提交的 flywheel 规则化自进化 / okf 目录化 / kb_get_index 等）上重跑了 78 题黄金评测。整体 71.8 分（PASS 54 / PARTIAL 4 / FAIL 20），Agent 端（design-agent-ts）归因已由主会话处理（含 `reasoning_content` 回传 P0 bug）。**本轮评测暴露了 knowledge-hub 侧两个明确的、需要你修复的问题**，均与"知识库数据/文档/评测集三方口径不一致"有关——即**不是 agent 的行为问题，而是知识库内容本身与新数据不同步**。

完整评测报告：`evals/eval_report_2026-08-09_query-mode-v03-fixed-agent.md`。

## 二、已证实的证据

### 1. golden 评测集 EV-027 过时（golden 与 KB 数据冲突）

- 题目：`SK033 星陨之坠的冷却和倍率？`
- golden 期望（`evals/golden_evals.json`）：`拒绝回答：SK033 不在注册表（SK001-SK032），不存在该技能`，keyFacts `["SK001","SK032"]`
- **但 KB 数据源 `Skill.csv` 中 SK033 已注册**（`run_20260809213610677_yrtOic/data/gamedata/Skill.csv` 实测）：
  `SK033,霆御斩,H009,normal,0,0,thunder,0.88,,雷光斩击两段，命中回复10能量`
- 文档 `gamedocs/00_项目总览与术语表.md` 第 128 行已声明扩展段：`技能扩展（SK033–SK072，定义见 Skill.csv；SK065–SK072 为通用被动池…）`
- 结果：模型本轮如实答出 `SK033=霆御斩 skillRate=0.88`（与 CSV 一致）反被 golden 判 FAIL（keyFacts 0/2）——**golden 期望与数据源矛盾**。
- 注意：早期评测轮（v0.1 库）SK033 可能确实未注册，但 KB 扩展后该题必须同步更新。**golden 集是"黄金标准"，必须与当前发布版数据严格一致**。

### 2. 术语表文档口径冲突（同一文档两处写死不同注册段）

- `gamedocs/00_项目总览与术语表.md` 第 72 行：`### 4.2 技能 SkillID（SK001–SK032，归属见《03_技能系统设计》表 03-1）`
- 同文件第 128 行：`技能扩展（SK033–SK072，定义见 Skill.csv；…）`
- 影响：EV-070（anti_hallucination，SK073 未注册应拒绝）中，Agent 检索命中第 72 行旧口径后输出 `SK073 不属于英雄技能段（SK001–SK032）`，未包含已注册锚点 SK072（keyFact）→ 判 FAIL；上轮引用 "SK001–SK072" 口径则 PASS。**同一文档两处口径不一致会直接造成模型回答漂移**。

## 三、任务范围（P0，仅两项）

### 任务 1：更新 golden 评测集 EV-027
- 把 `evals/golden_evals.json` 中 EV-027 的 `expectedAnswer` / `keyFacts` / `notes` 改为**正向断言**：SK033 存在，为「霆御斩」、thunder、normal、cdSec=0、energyCost=0、skillRate=0.88、归属 H009。
- 参考相邻题（EV-004 等 basic_retrieval / anti_hallucination 正向题）的写法，保持 keyFacts / numPairs 结构一致（如 keyFacts 含 `霆御斩`，numPairs 含 `['skillRate', 0.88]`、`['cdSec', 0]`）。
- **禁止**为了让它"看起来好过"而把期望改弱（例如删除 keyFacts）——必须是严格且可程序化审计的断言。
- 改完跑 `python evals/audit_evals.py --kb-dir knowledge --evals evals/golden_evals.json`，确认审计仍通过（该题改动后应纳入审计范围，如脚本支持需更新审计锚点；若 audit 脚本硬编码了该题旧断言，同步更新脚本）。

### 任务 2：统一术语表技能注册段口径
- 修改 `gamedocs/00_项目总览与术语表.md` 第 72 行（§4.2），把旧口径 `SK001–SK032` 改为完整口径，例如：`技能 SkillID（SK001–SK032 基础段 + SK033–SK072 扩展段，定义见 Skill.csv；归属见《03_技能系统设计》表 03-1）`，并在 §4.2 内补充一行指向扩展段的说明（与第 128 行一致）。
- 同步检查 `wiki/concepts/03-技能系统设计.md` 是否有同样的旧口径表述（本轮模型回答曾引用它），有则一并修正。
- 若数据源（204 张 CSV）中存在"文档声称某 ID 段但 CSV 实际没有"或反之的情况，列出清单报告即可，不要求你扩充/删除数据（数据一致性治理如超范围，说明原因）。

## 四、硬性约束

- **只改 knowledge-hub**：不修改 design-agent-ts（Agent 端 `reasoning_content` 回传、格式漂移、token 预算由主会话负责）与 agent-observe。
- **不改评测打分规则**：`run_eval.py` 的严格匹配逻辑（keyFacts 子串 / numPairs `字段=值`）是契约，不得放宽；只改 golden 数据与文档。
- **回归门槛**：
  1. `npm run build` + `npm test` 通过（若本次改动不涉及 TS 代码，说明即可）；
  2. `python evals/audit_evals.py` 通过（或列出该脚本如何覆盖 EV-027 新断言）；
  3. 用 `design-agent-ts/scripts/probe-kb-v02.mjs` 或直接读 CSV 验证 SK033 行与文档扩展段描述一致；
  4. 对 EV-027 的新 golden 期望，用 `python evals/run_eval.py --answers`（构造一个含 `霆御斩`、`skillRate=0.88` 的样例答案）自测打分通过。
- 改完**不启动评测**（评测由主会话统一跑）。

## 五、输出要求

1. 变更清单（文件级）：golden JSON 的具体 diff、文档的具体 diff；
2. audit 脚本对该题的覆盖方式（若审计需同步更新，给出新断言）；
3. 样例答案自测结果（EV-027 新期望下 PASS）；
4. 若发现其他 golden 题与当前 KB 数据冲突（如 SK033 类似的扩展段 ID 题），一并列出（不要求全改，先报告）。
