# Knowledge Hub V2 架构演进路线图

> 目标：把“人等系统审批”的工单模型，翻转为“系统自动流转、只在不确定处等人标注”的流水线模型。

## 1. 评估结论

这个方向是对的，但不应该一次性重写。当前系统的资产、发布、MCP、反馈、审核基础都已经存在，最合理的路线是保留现有骨架，把关键节点从“状态审批”升级成“可学习的标注”和“可订阅的事件”。

优先级如下：

| 优先级 | 目标 | 原因 |
| --- | --- | --- |
| P0 | 审核改为标注 | 人的每次判断都能沉淀为 few-shot 样例，解决同类问题反复出现 |
| P1 | Agent 反馈自动回流 | 反馈不能只停留在 agent_events，需要自动生成待处理标注任务 |
| P2 | 增量构建/发布 | 只改一个组件时不应重跑全量，降低 LLM token 和等待成本 |
| P3 | Profile 半自动维护 | AI 发现规则缺口，人批准后进入策划立法规则 |

## 2. 本阶段落地范围

本阶段先完成 P0 的最小可用闭环，并给 P1 预留事件入口：

1. `review_tasks` 支持标注字段：`task_kind`、`rule_id`、`candidates`、`confidence`、`context_snapshot`、`annotation_value`、`annotated_by`、`annotated_at`。
2. 新增 `annotation_examples`，把人工选择/填写的正确答案沉淀为 example pool。
3. 新增 `rule_dismissals`，支持“此规则对此组件不适用”的永久豁免。
4. 新增 `knowledge_events` 和轻量 EventEmitter，先落库 `annotation.created`、`agent.feedback.received` 等事件。
5. Agent 反馈生成的 Review Task 默认进入 `annotation` 类型，并携带候选、置信度和上下文快照。
6. 审核中心增加标注面板：可以选择候选、填写正确答案、勾选规则豁免。

暂不在本阶段做的内容：

| 内容 | 暂缓原因 |
| --- | --- |
| extract prompt 注入 examples | 需要先稳定 example pool 的结构，再接入 LLM prompt |
| 单组件增量重建 | 依赖构建缓存和组件级依赖边界，需要单独拆阶段 |
| release revision / 增量 OKF | 涉及 OKF 文件 patch 和 manifest diff，适合作为 P2 |
| Trust Score 大幅简化 | 会影响现有发布质量面板和 MCP 输出，需要单独迁移 |
| MCP buildRunId 预览模式 | 与构建 workspace 读取路径相关，独立实现更稳 |

## 3. 标注闭环

标注任务的数据结构：

```json
{
  "taskKind": "annotation",
  "ruleId": "wiki.required_fact",
  "confidence": 0.72,
  "candidates": [
    {
      "id": "cand_activity",
      "label": "活动结构",
      "value": { "field": "activity_structure" },
      "confidence": 0.72,
      "rationale": "正文出现阶段、奖励、入口条件"
    }
  ],
  "contextSnapshot": {
    "pageType": "activity",
    "sourceFile": "gamedocs/pvp.md"
  }
}
```

人完成一次标注后：

1. `review_tasks.status` 变为 `resolved`。
2. `review_tasks.annotation_value` 记录正确答案。
3. `annotation_examples` 写入 `(context_snapshot, context_hash, correct_value)`。
4. 如勾选规则豁免，`rule_dismissals` upsert `(component_id, rule_id)`。
5. `knowledge_events` 写入 `annotation.created`。

后续阶段再让 `extractStage` 按 `page_type + rule_id` 读取 examples 注入 prompt，从而减少同类任务反复出现。

## 4. 事件骨架

事件系统保持轻量：进程内 EventEmitter 用于订阅，`knowledge_events` 表用于追溯。

当前事件类型：

| 事件 | 用途 |
| --- | --- |
| `annotation.created` | 人完成标注，后续可触发 example pool 分析或增量重建 |
| `agent.feedback.received` | Agent 反馈到达，后续可触发标注任务、负反馈计数 |
| `build.completed` | 构建完成，后续用于通知、审计、自动发布判断 |
| `build.quality_fail` | 质量门禁失败，后续通知 reviewer |
| `component.trust_changed` | 可信度变化，后续判断是否自动发布 |
| `release.published` | 发布完成，后续清理旧 OKF 或写审计摘要 |

## 5. 第二阶段落地

第二阶段完成“标注样例进入构建 prompt”和“规则豁免进入 quality gate”：

1. 从 `annotation_examples` 读取最近人工标注样例。
2. 在 `extractStage` 构造 prompt 时，注入这些 examples 作为 few-shot 参考。
3. 在 quality gate 读取 `rule_dismissals`，跳过已豁免规则。
4. 在构建完成后统计“本次新增标注任务数 / 复发任务数 / 被样例命中的任务数”，让前端能看到飞轮是否正在收敛。

当前实现说明：

| 能力 | 状态 |
| --- | --- |
| 标注样例进入 extract prompt | 已接入最近 12 条人工标注，并纳入 extract cache 指纹 |
| 规则豁免进入 quality gate | 已按 `rule_id + component_ref` 跳过 wiki/graph/table 质量规则 |
| 构建 findings 生成 annotation task | 已生成 `task_kind=annotation`、`rule_id`、`confidence`、`context_snapshot` |
| 收敛统计面板 | 未完成，建议作为下一阶段前端/报表能力 |

## 6. 下一阶段建议

第三阶段先完成了“飞轮收敛可视化”的最小闭环：

| 能力 | 状态 |
| --- | --- |
| 记录构建注入的标注样例数 | 已写入 build run `config.flywheel` |
| 记录 active / applied rule dismissals | 已写入 build run `config.flywheel` |
| 记录本次新增 annotation task 数 | 已写入 build run `config.flywheel` |
| 构建进度页展示飞轮摘要 | 已在运行卡片展示 |
| Agent 负反馈触发重建提案 | 已在同组件负反馈达到 2 次时生成 `agent_feedback.rebuild_candidate` 标注任务 |
| 重建提案一键执行 | 已可从审核中心启动基于 `sourceRefs` 的 scoped build |
| release revision 版本链基础 | 已为 release 增加 `parent_release_id`，新草案可基于当前发布生成 revision |
| release diff 写入 manifest | 已比较父版本与本次发布的 package/component/sourceVersion 差异，并写入 `manifest.revision` |
| OKF revision 元数据 | 已导出 `okf_bundle/meta/revision.json`，Agent 可从 OKF 包消费版本差异 |
| OKF bundle 文件复用 | 已复制父 bundle 作为基底，仅重写 added/changed Markdown，并清理 removed Markdown 与缺失全局资产 |
| 自动发布资格判断 | 已支持 `publish(autoMode=true)`：要求 revision、有变化组件、无 removed component、变化组件无 blocking、trust 未下降 |
| 构建完成触发 revision 草案 | 已监听 `build.completed`，对 scoped build 自动创建基于 current release 的 revision draft，并防重复 |
| Agent 反馈触发 scoped rebuild | 已监听 `agent.feedback.rebuild_proposed`，复用审核任务启动单组件 scoped rebuild，并通过 `rebuildTaskId` 防重复 |

后续继续做“Agent 反馈驱动增量重建执行”：

1. 进一步统计 examples 的精确命中来源，而不是只展示注入数量。
2. 审核中心展示“这个问题是否复发、上次人工标注是什么、这次是否被样例影响”。
3. 让 graph/table/search 等全局资产支持更细粒度 patch，而不是每次 revision 重建聚合资产。
4. 在事件订阅中增加可配置后台自动发布：仅当 revision draft 通过 `autoMode` 条件时自动 publish，否则保留人工确认。
