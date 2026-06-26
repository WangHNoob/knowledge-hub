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

## 5. 下一阶段建议

下一步优先做“标注样例进入构建 prompt”：

1. 为 `annotation_examples` 增加按 `page_type + rule_id` 查询的 service 方法。
2. 在 `extractStage` 构造 prompt 时，注入最近且匹配的 examples。
3. 在 quality gate 读取 `rule_dismissals`，跳过已豁免规则。
4. 在构建完成后统计“本次新增标注任务数 / 复发任务数 / 被样例命中的任务数”，让前端能看到飞轮是否正在收敛。

