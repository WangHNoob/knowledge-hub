# 查询模式评测报告（修复后 agent + 更新后 KB）

- 日期: 2026-08-10 00:40
- 知识库: 更新后 release `rel_20260809142245_mSJBqC`（flywheel 自进化 / okf 目录化等 22:34-22:36 提交入库）
- Agent: design-agent 修复版（bb7162e：轮次化压缩 / sanitizeToolSequence / 重复调用守卫 / 工具结果截断），dist 16:58 构建、20:18 启动
- 评测集: v3 黄金集（78 题 = EV-001~030 回归 + EV-031~078 新增）
- 运行说明: 首轮跑至 44 题后 eval 进程网络栈异常（10061），已确证为进程自身问题（同节奏新进程 14 轮 create + 112 次轮询零失败）；改用 127.0.0.1 重跑全量完成

## 总成绩

| 指标 | 本轮 | 上轮（v0.2 首轮） | 变化 |
|------|------|------|------|
| PASS / PARTIAL / FAIL | 54 / 4 / 20 | 58 / 2 / 18 | -4 / +2 / +2 |
| 综合得分 | **71.8 / 100** | **75.6 / 100** | **-3.8** |

## 分组表现

| 分组 | PASS | PARTIAL | FAIL |
|------|------|---------|------|
| anti_hallucination | 7 | 0 | 2 |
| basic_retrieval | 7 | 0 | 6 |
| consistency | 10 | 1 | 0 |
| cross_table | 12 | 0 | 2 |
| economy_loop | 4 | 1 | 6 |
| evidence_chain | 2 | 2 | 2 |
| formula_calc | 12 | 0 | 2 |

## 与上轮对比

### ✅ 修复生效（上轮 FAIL → 本轮 PASS/PARTIAL，共 6 题）
| 题 | 上轮原因 | 本轮 |
|----|----------|------|
| EV-003 | 表格格式不认 | PASS |
| EV-043 | 表格格式不认 | PASS |
| EV-047 | 首匹配歧义 | PASS |
| EV-060 | token 风暴 | PARTIAL |
| EV-065 | token 风暴 | PASS |
| EV-071 | token 风暴 | PASS |

→ 重复调用守卫 + 工具结果截断把 6 个 token 风暴题救回 5 个（EV-060 降级 PARTIAL）。

### ⚠️ 新增 FAIL / 降级（上轮 PASS → 本轮 FAIL/PARTIAL，共 10 题）
| 题 | 归因 | 责任方 |
|----|------|--------|
| EV-001/031/038/046 | **格式漂移**：数据全对（rarity=5、heroCount=3、gold=60000 都在），但本轮输出表格 `\| rarity \| **5** \|`，打分器只认内联 `rarity=5`；上轮恰好内联 → PASS。LLM 输出格式不稳定 | agent 端（提示词/打分器） |
| EV-004 | **内容档位偏差**：skillRate 本轮答 3.06（L10=1.7×1.8），题目问基础倍率 1.7；上轮答对 | agent 端 |
| EV-017 | **token 预算临界超限**：13 次 LLM 调用 × 平均 42k input = 553k > 500k；上轮恰好未超。工具结果 6000 字符截断后单次 input 仍 ~42k | agent 端（预算/截断） |
| EV-034 | 执行超时（360s 无输出，timeout_wait） | 待查 |
| EV-070 | **keyFact 缺失**：SK073 拒绝正确，但引用旧文档口径 "SK001–SK032"（术语表 §4.2 旧段），未含已注册锚点 SK072 → 0/1；上轮引用 "SK001–SK072" → PASS | KB 文档口径不一致 |
| EV-064/076 | PASS → PARTIAL（各缺 1 个关键点） | — |

### ❌ 两轮均 FAIL（12 题）
| 题 | 归因 | 责任方 |
|----|------|--------|
| EV-010/035/050/055/056/061 | 表格格式不认（上轮 B 类格式问题残留 5 题） | agent 端 |
| EV-021/058 | **新错误 `reasoning_content` 400**（thinking 模型要求原样回传思考内容）——详见下文 P0 | **agent 端（本次新暴露 bug）** |
| EV-027 | **golden 过时**：KB 已扩展 SK033–SK072（Skill.csv 有 SK033 霆御斩 skillRate=0.88），模型答出正确数据（0.88 与 CSV 一致）反被 golden 期望"SK033 不存在"判 FAIL | **KB 侧（golden 需更新）** |
| EV-059 | day=14 got 1.0（首匹配歧义，上轮已识别） | 打分器 |
| EV-077 | token 预算超限（559,942 > 500,000） | agent 端 |
| EV-078 | rewardGuildPoint=25 单点缺失 | agent 端 |

## 🔴 新发现 agent 端 P0 bug：`reasoning_content` 丢失（EV-021/058）

**现象**：`400 invalid_request_error: The reasoning_content in the thinking mode must be passed back to the API`（Console Go thinking 模型）。

**根因**（代码实证）：
- `LangGraphMessageMapper.fromLangGraph` 把 `additional_kwargs`（含 `reasoning_content`）存进 `ChatMessage.metadata` ✅
- `LangGraphMessageMapper.toLangGraph` 重建 `AIMessage` 时**只传 `content/tool_calls/name`，不回填 `metadata` → `additional_kwargs`** ❌（src/adapter/langgraph/LangGraphMessageMapper.ts:34）
- 于是带思考内容的 assistant 消息经 `state → maybeCompress → mapper 往返` 后 `reasoning_content` 被丢弃
- Console Go 类 thinking 模型硬性要求：历史中带 `reasoning_content` 的 assistant 消息必须原样回传，缺失即 400

**为何上轮未暴露**：上轮 EV-021/058 分别被 token 风暴（500k 预算中止）和 tool 序列 400 提前挡住；本轮修复（sanitizeToolSequence + 重复调用守卫）把它们放行到了更深一层校验，暴露此 bug。EV-070/059 等非 thinking 校验路径不受影响。

**修复方向**：`toLangGraph` 在重建 AIMessage/ToolMessage 时把 `msg.metadata` 合并回 `additional_kwargs`（至少保留 `reasoning_content`）；sanitizeToolSequence 已有 pendingCallIds 追踪，不重建 AIMessage，无影响。

## 🟡 KB 侧问题（建议转 knowledge-hub 优化 agent）

1. **golden EV-027 过时**：`00_项目总览与术语表.md` 第 128 行已声明扩展段 SK033–SK072（Skill.csv 实测 SK033=霆御斩/0.88 存在），但 golden 仍期望"SK033 不在注册表"→ 模型答对反被 FAIL。需把该题改为"SK033 是霆御斩（0.88）"正向断言。
2. **术语表口径冲突**：§4.2 第 72 行写 `SK001–SK032`（旧段），第 128 行写 `SK033–SK072`（扩展段）。模型检索时只命中旧段 → EV-070 引用旧口径丢失 keyFact。应同步两处口径（72 行补扩展说明）。

## 结论

- **本轮得分 71.8 低于上轮 75.6，但非简单回退**：6 个 token 风暴题被修复救回；下降主要来自 **LLM 输出格式漂移**（约 4 题内容全对、表格格式不认）与 **2 个新暴露的 `reasoning_content` 400**（agent 端 mapper bug，上轮被前置错误掩盖）。
- agent 端优先级：① 修 mapper `reasoning_content` 回填（P0，影响 thinking 模型稳定性）；② 输出格式稳定性（提示词强化"字段=值 内联输出"或打分器放宽表格解析）；③ token 预算临界问题（500k 对 thinking 模型偏紧，13 次调用即爆）。
- KB 侧：golden EV-027 更新 + 术语表口径同步，转 knowledge-hub agent。
