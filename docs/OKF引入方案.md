# OKF 引入方案：将知识资产包升级为可交换、可审计、Agent 友好的开放知识包

> 目标：在不推翻现有知识飞轮、策划立法、质量门禁和发布体系的前提下，引入 Google Open Knowledge Format（OKF）作为 Knowledge Hub 的标准化导出层，让知识资产包既能服务内部治理，又能以通用格式被 Agent、Git、审计工具和外部系统消费。

## 0. 结论

当前 `knowledge/` 已经非常接近 OKF 的基本形态：核心知识位于 `wiki/`，使用 Markdown + YAML frontmatter；同时存在 `index.md`、表结构、图谱和页面元数据。

但它还不是一个理想的 OKF bundle。主要问题不是“格式不对”，而是**关键语义分散在 Markdown 之外**：

- `wiki/*.md` 承载人类可读内容；
- `wiki/_meta/*.json` 承载实体、事实、关系和抽取过程；
- `wiki/graph.json` 承载图谱快照；
- `wiki/_tables/*.json` 承载表结构和外键推断；
- 证据来源主要以 `source` 字段和原始文件目录表达，没有统一 citations 层；
- Wiki 内部链接大量使用 `[[...]]`，不是 OKF 推荐的标准 Markdown bundle-relative link。

因此，OKF 不应该替代现有构建体系，而应该作为一个**发布导出协议**：

```text
source bundle / source version
  -> kbBuilder 内部构建
  -> Wiki / Meta / Graph / Tables / Quality
  -> Review / Release
  -> OKF Export Bundle
  -> Agent / Git / 审计 / 外部交换
```

一句话：**内部继续严治理，外部输出 OKF。**

## 1. OKF 对本项目的价值

OKF v0.1 是一个轻量知识包规范。它把知识包定义为一个 Markdown 目录树，每个概念文档由 YAML frontmatter 和 Markdown body 组成。它强调人可读、Agent 可解析、版本控制可 diff、跨工具可移植。参考：[Google OKF SPEC.md](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)。

对 Knowledge Hub 来说，OKF 的价值不是提供新的知识图谱引擎，而是提供一个**知识资产包的通用外壳**：

1. **可交换**：发布版本可以作为 OKF bundle 提供给其他 Agent、其他团队或未来工具链。
2. **可审计**：Markdown + frontmatter 适合 Git diff，便于追踪每次知识变化。
3. **可降级消费**：即使消费方不理解 Knowledge Hub 的内部 JSON，也能读取 `type/title/description/tags/links/citations`。
4. **可保留领域扩展**：OKF 允许 producer-defined frontmatter keys，因此可以保留 `kh`、`entities`、`facts`、`relationships` 等项目扩展。
5. **与策划立法互补**：OKF 不定义固定 taxonomy；页面类型、实体类型、关系类型仍由主策划 Profile 定义。

## 2. 引入原则

### 2.1 OKF 是导出协议，不是事实源

Knowledge Hub 的事实源仍然是：

- `sources`
- `asset_packages`
- `asset_components`
- `evidence_records`
- `review_tasks`
- `releases`
- 当前启用的 `knowledge_rule_profiles`

OKF bundle 是 release 的一种可读、可交换导出物。不能让 Agent 直接绕过发布系统读取 draft OKF 文件。

### 2.2 不降低现有质量要求

OKF 本身很宽松：未知 type、缺少 optional fields、broken links 都应被消费者容忍。但 Knowledge Hub 不能因此降低治理标准。

建议分两层：

| 层级 | 目标 | 规则 |
|---|---|---|
| OKF conformance | 能被通用 OKF 工具消费 | 只检查 frontmatter、type、index/log 基本结构 |
| KH publish quality | 能进入正式 Agent 发布 | 检查策划立法、证据、typed relations、候选关系、质量红线 |

也就是说，**OKF 兼容是底线，策划立法是发布线**。

### 2.3 先导出，后回填

不要第一步就改写 `knowledge/wiki/` 的生成方式。第一阶段应新增 `okf_bundle/` 导出目录，从现有产物派生：

```text
knowledge/wiki/
knowledge/wiki/_meta/
knowledge/wiki/graph.json
knowledge/wiki/_tables/
  -> okf exporter
  -> okf_bundle/
```

等导出稳定后，再逐步把 OKF 所需字段前移到主构建 pipeline。

## 3. 当前知识资产包与 OKF 的映射

### 3.1 当前目录职责

```text
knowledge/
  gamedocs/               原始策划文档 docx
  gamedata/               原始配置表 xlsx
  table_schemas/          单表 schema JSON
  processed/wiki_specs/   Wiki Spec、页面类型、实体类型、关系类型
  wiki/
    systems/              system_rule 页面
    activities/           activity_template 页面
    tables/               table_schema 页面
    ui_flows/             ui_flow 页面
    _meta/                每页抽取元数据
    _tables/              表扫描聚合结果
    graph.json            图谱快照
    index.md              总索引
```

### 3.2 OKF 目标目录

建议在 release artifact 中生成：

```text
okf_bundle/
  index.md
  log.md
  systems/
    index.md
    成就.md
  activities/
    index.md
    神秘商店.md
  tables/
    index.md
    Achievement.md
  ui_flows/
    index.md
    成就.md
  references/
    gamedocs/
      成就.md
    gamedata/
      Achievement.md
  _kh/
    manifest.json
    graph.json
    table_fk_registry.json
    quality_summary.json
```

说明：

- `systems/activities/tables/ui_flows` 是 OKF concept 文档目录。
- `references/` 把原始 docx/xlsx 的摘要、hash、路径、提取文本作为 first-class reference concept。
- `_kh/` 是 Knowledge Hub 扩展目录，放内部消费优化产物。通用 OKF 消费方可以忽略它。

### 3.3 frontmatter 映射

当前系统页面：

```yaml
---
type: system_rule
title: "成就系统"
source: "成就.docx"
---
```

建议 OKF 导出后：

```yaml
---
type: system_rule
title: 成就系统
description: 记录并奖励玩家达成目标的成就系统，本次升级包含界面交互与海图绘入口。
resource: kh://source/gamedocs/成就.docx
tags: [system, achievement, ui, config-driven]
timestamp: 2026-06-17T00:00:00+08:00
kh:
  okf_export_version: 1
  source_version_ids: [...]
  package_id: pkg_...
  component_id: comp_...
  legislation_profile_id: default
  legislation_profile_hash: sha256:...
  quality_status: passed
entities:
  - name: 成就系统
    type: system
  - name: SwitchCondition
    type: table
facts:
  system_name: 成就系统
  unlock_condition: 默认开放
relationships:
  - relation: configured_in
    target: /tables/SwitchCondition.md
    evidence: [1]
---
```

注意：`entities/facts/relationships/kh` 是 Knowledge Hub 扩展字段，不要求通用 OKF 工具理解，但必须保持 YAML 可解析。

## 4. Pipeline 改造方案

### 4.1 新增 `okf` 导出阶段

建议在 `kbBuilder` 或 release publish 中新增导出阶段：

```text
collect / persist
  -> quality gate
  -> review / release
  -> okf export
```

不建议在 extract 阶段直接生成 OKF，因为 extract 阶段还没有完整的质量结论、发布版本、profile hash 和审核状态。

OKF export 输入：

- 已发布 release
- release manifest
- asset components
- evidence records
- active or recorded legislation profile
- wiki markdown
- `_meta/*.json`
- `graph.json`
- `_tables/*.json`

OKF export 输出：

- `okf_bundle/`
- `okf_manifest.json`
- conformance report
- link report
- citation coverage report

### 4.2 OKF exporter 的职责

| 职责 | 说明 |
|---|---|
| 复制/重写 Markdown | 从现有 Wiki 页生成 OKF concept 文件 |
| 扩展 frontmatter | 补充 `description/resource/tags/timestamp/kh/entities/facts/relationships` |
| 链接标准化 | 将 `[[...]]` 转为标准 Markdown link |
| 生成目录索引 | 为 root 和一级目录生成 `index.md` |
| 生成变更日志 | 根据 release diff 生成 `log.md` |
| 生成 references | 将 docx/xlsx 源材料生成 reference concept |
| 生成 `_kh` 附件 | 保留 graph、quality、table registry 等内部优化产物 |
| 生成质量报告 | 输出 OKF conformance 和 KH publish quality 的差异 |

### 4.3 链接标准化策略

当前 Wiki 使用：

```markdown
[[SwitchCondition]]
[[MysteryShop/MysteryShopTime]]
```

OKF export 时生成：

```markdown
[SwitchCondition](/tables/SwitchCondition.md)
[MysteryShop/MysteryShopTime](/tables/MysteryShop.md)
```

解析策略：

1. 优先用 `_meta.entities`、`graph.nodes`、`wiki/index.md` 的概念映射。
2. 表名优先匹配 `tables/<group>.md` 或 `_tables/schemas.json` 的 `group`。
3. 系统/活动优先匹配 `systems/`、`activities/`。
4. 多候选时保留原文本，生成 `ambiguous_link` warning。
5. 无候选时生成标准 Markdown 文本但不链接，或链接到 `/unresolved/<name>.md` 并记录 `broken_link`，具体由质量配置决定。

推荐初期策略：**不生成虚假的 unresolved 文件**。找不到目标就保留纯文本，并产出 review task。

### 4.4 citations 与 references 策略

OKF 推荐在 body 底部用 `# Citations` 列出支撑来源。Knowledge Hub 应把 citations 变成发布准入的一部分。

建议规则：

| 页面类型 | Citation 要求 |
|---|---|
| system_rule | 至少引用对应 docx reference |
| activity_template | 至少引用对应 docx reference；涉及表配置时引用 table reference |
| table_schema | 引用对应 xlsx/table schema reference |
| ui_flow | 引用对应 docx 或 UI 流程来源 |
| numerical_convention | 引用 docx/xlsx，且关键公式必须有 fact evidence |

reference concept 示例：

```markdown
---
type: Reference
title: 成就.docx
description: 成就系统原始策划文档。
resource: kh://source/gamedocs/成就.docx
tags: [source, gamedoc]
timestamp: 2026-06-17T00:00:00+08:00
kh:
  source_version_id: srcv_...
  content_hash: sha256:...
  original_path: gamedocs/成就.docx
---

# Source Summary

原始文档用于生成 `/systems/成就.md`。

# Extracted Text

...
```

## 5. 策划立法 Profile 如何与 OKF 结合

OKF 不定义固定 taxonomy，这正好给策划立法留下空间。

建议把当前 `KnowledgeRuleProfile` 编译成两个东西：

1. **构建约束**：继续用于 extract/tables/graph/quality。
2. **OKF profile**：用于导出 frontmatter、必填字段、目录、标签和 citations 规则。

映射关系：

| 策划立法内容 | OKF 输出 |
|---|---|
| 页面类型 | `frontmatter.type`、目录名、index 分组 |
| 实体类型 | `entities[].type` |
| 关系类型 | `relationships[].relation` |
| Wiki 必填章节 | Markdown body quality gate |
| 必填事实 | `facts` 扩展字段与 body Facts 章节 |
| 证据要求 | `# Citations` 和 `kh.evidence` |
| 表字段规则 | `# Schema`、`# Joins`、table relationship |
| 质量红线 | OKF export conformance + KH publish gate |

这里要特别注意：**不要让 OKF 的宽松 type 机制削弱策划立法**。

OKF 说消费者应容忍 unknown type；但 Knowledge Hub 作为生产方，应继续阻断未知页面类型进入正式发布。

## 6. 发布体系改造

### 6.1 release manifest 增加 OKF 信息

建议 release manifest 增加：

```json
{
  "okf": {
    "version": "0.1",
    "exporterVersion": 1,
    "bundlePath": "releases/<release_id>/okf_bundle",
    "conformance": {
      "ok": true,
      "conceptCount": 188,
      "missingType": 0,
      "brokenLinks": 0,
      "missingCitations": 3
    }
  }
}
```

### 6.2 release artifact 结构

建议：

```text
releases/<release_id>/
  manifest.json
  components/
  okf_bundle/
  okf_report.json
```

### 6.3 发布准入

发布前检查分三层：

1. **现有 blocking review task**：有 open blocking task 则拒绝发布。
2. **KH 质量门禁**：候选关系、缺证据、缺必填事实等按策划 Profile 执行。
3. **OKF conformance**：OKF bundle 必须满足最小规范。

建议初期只把 OKF conformance 设为 blocking；`description/tags/citations` 缺失先 warning，等回填稳定后再升级。

## 7. 版本管理简化方案

OKF 引入后，Knowledge Hub 的版本管理可以从“每类派生产物都像一等版本对象一样管理”，收束成“资料、规则、构建、审核包、发布包”五类核心版本对象。

推荐模型：

```text
SourceVersion 不可变
  -> KnowledgeRuleProfile 版本化
  -> BuildRun 可重跑、可失败
  -> Draft AssetPackage 可审核、可修订
  -> Release 不可变
  -> OKF Bundle 是 Release 的标准化快照
```

### 7.1 可以简化的部分

#### Wiki / Graph / Table / Index 不再各自承担复杂版本主线

当前系统里，Wiki、Graph、Table、Index 都是重要资产组件。但引入 OKF 后，它们在发布层可以统一成为同一个 release bundle 内的文件和派生索引。

也就是说：

- Wiki concept 是 OKF bundle 的 Markdown 文件；
- Graph 是从 concept links、`relationships` 扩展和 `_kh/graph.json` 派生出的索引；
- Table schema 是 `/tables/*.md` 与 `_kh/table_registry.json`；
- Index 是 `index.md` 和目录级 `index.md`；
- 它们共享同一个 `releaseId + okfBundleHash`。

这样可以减少“同一个发布版本下，Wiki 版本、Graph 版本、Table 版本、Index 版本互相对齐”的复杂度。

#### 组件版本可以从内部 ID 驱动转向 path + hash 驱动

发布层推荐以 OKF path 作为概念稳定地址：

```text
/systems/成就.md
/activities/神秘商店.md
/tables/Achievement.md
/references/gamedocs/成就.md
```

每个 concept 可以有 `conceptHash`，整个 bundle 有 `bundleHash`。

内部仍可保留 `componentId`，但产品语言和 Agent trace 可以优先使用：

- `releaseId`
- `okfPath`
- `conceptHash`
- `citation target`
- `sourceVersionId`

这比要求策划、Agent 或审计者理解 `packageId/componentId/artifactId` 更自然。

#### Rollback 可以简化为切换不可变 release

Rollback 不需要重新解释当时所有 Wiki、Graph、Table、Index 的组合状态。

推荐语义：

```text
rollback to release_x
  = 将当前 Agent 可见版本切换到 release_x
  = release_x.okfBundleHash 决定完整知识快照
```

Graph、table registry、index 都是该 bundle 内的内容或可从该 bundle 重建的派生索引。

#### 变更记录可以标准化到 `log.md`

Release manifest 继续提供机器可读记录；OKF `log.md` 提供人类可读变更历史：

- 新增哪些 concept；
- 修改哪些 concept；
- 删除或废弃哪些 concept；
- 使用哪套策划立法 Profile；
- 来源哪些 source version；
- 质量门禁摘要；
- 是否存在兼容性 warning。

这可以减少前端和文档中对“版本差异”的重复表达。

#### Agent trace 可以简化

Agent 查询不必把一堆内部 ID 作为主要返回信息。

推荐主 trace：

```json
{
  "releaseId": "rel_xxx",
  "okfPath": "/systems/成就.md",
  "conceptHash": "sha256:...",
  "citations": [
    {
      "target": "/references/gamedocs/成就.md",
      "sourceVersionId": "srcv_xxx"
    }
  ],
  "qualityFlags": []
}
```

内部 ID 可以作为 debug 字段保留，而不是作为策划和 Agent 的主要心智模型。

### 7.2 不能简化掉的部分

#### SourceVersion 不能简化

原始 docx/xlsx 是证据链起点。它们必须不可变，否则 citations、evidence records 和 Agent 输出归因都会失去可信基础。

#### KnowledgeRuleProfile 不能简化

OKF 不定义你的页面类型、实体类型、关系类型、Wiki 标准和质量红线。主策划立法仍是内部治理核心。

OKF 只回答“如何打包和交换知识”；策划立法回答“什么知识算合格”。

#### Release 不可变机制不能简化

OKF bundle 是 release 的外壳，不是 release 的替代品。

正式 Agent 消费必须绑定不可变 release：

```text
Agent 只能读 current release
current release 指向一个不可变 OKF bundle hash
```

#### ReviewTask 不能放进 OKF 当主状态

审核任务是工作流状态，仍应保存在数据库中。OKF 可以记录发布时的问题摘要，但不能作为任务流事实源。

#### EvidenceRecords 不能完全删除

OKF citations 是发布后的证据表达；`evidence_records` 仍负责：

- 构建期证据追踪；
- 审核期证据查看；
- 质量门禁；
- Agent 输出归因；
- 反馈回流。

### 7.3 推荐收束后的版本对象

| 对象 | 是否不可变 | 职责 |
|---|---:|---|
| `SourceVersion` | 是 | 原始资料版本 |
| `KnowledgeRuleProfile` | 版本化 | 策划立法规则版本 |
| `BuildRun` | 是 | 一次构建记录，可成功、失败或部分完成 |
| `AssetPackage` | 草稿可演进 | 审核中的资产集合 |
| `Release` | 是 | 对 Agent 可见的发布快照，包含 OKF bundle hash |

`AssetComponent` 可以保留，但定位建议从“独立版本对象”降级为“包内概念/文件索引”：

- 用于 UI 展示资产详情；
- 用于 evidence/review task 关联；
- 用于 release manifest 追踪；
- 不再承担发布层的主要版本心智。

### 7.4 简化后的 release manifest 示例

```json
{
  "releaseId": "rel_xxx",
  "sourceVersionIds": ["srcv_xxx"],
  "buildRunId": "run_xxx",
  "packageIds": ["pkg_xxx"],
  "legislationProfile": {
    "id": "default",
    "hash": "sha256:..."
  },
  "okf": {
    "version": "0.1",
    "bundleHash": "sha256:...",
    "conceptCount": 188,
    "referenceCount": 42
  },
  "qualitySummary": {
    "blocking": 0,
    "warning": 3
  }
}
```

### 7.5 迁移策略

版本管理不要一次性重构。建议：

1. 先在 release manifest 增加 `okf.bundleHash` 和 `okf.bundlePath`。
2. MCP trace 增加 `okfPath`，保留现有 `componentId`。
3. 前端发布详情优先展示 OKF bundle 信息，但保留组件明细。
4. 等 OKF exporter 稳定后，再弱化 UI 中对 Graph/Index/Table 单独版本的表达。
5. 最后把 rollback、diff、Agent trace 的主心智统一到 `releaseId + okfPath + citation`。

## 8. Agent 消费策略

### 8.1 内部 Agent 仍走 Knowledge MCP

内部 Agent 不应直接读 OKF 文件绕过权限、发布版本和审计。

推荐：

```text
Agent
  -> Knowledge MCP
  -> release read model
  -> OKF-derived concept / graph / evidence
```

Knowledge MCP 可以返回 OKF 友好的 trace：

```json
{
  "conceptId": "systems/成就",
  "okfPath": "/systems/成就.md",
  "type": "system_rule",
  "title": "成就系统",
  "citations": [
    {
      "label": "[1]",
      "target": "/references/gamedocs/成就.md",
      "sourceVersionId": "srcv_..."
    }
  ],
  "qualityFlags": []
}
```

### 8.2 外部 Agent 可消费 OKF bundle

外部 Agent 或离线工具可以直接读 `okf_bundle/`，但这种消费不进入内部审计闭环。若需要回流反馈，必须通过 API/MCP 提交 `agent_events` 或 `review_tasks`。

## 9. 引入过程中的主要问题与处理方案

### 9.1 Markdown frontmatter 的 YAML 安全问题

问题：

- 中文、冒号、数组、换行容易生成非法 YAML。
- LLM 生成内容可能把 `---` 写进正文导致解析错误。

方案：

- frontmatter 不直接由 LLM 拼接，由系统序列化生成。
- Markdown body 与 frontmatter 分开处理。
- `description/title/tags` 统一 escape。
- conformance checker 必须逐文件 parse。

### 9.2 Obsidian 链接迁移风险

问题：

- `[[实体名]]` 不一定能唯一定位文件。
- 表名、表族、子表路径存在多种写法。
- 直接替换可能生成错误链接。

方案：

- 初期只在 OKF export 中转换，不改源 Wiki。
- 链接 resolver 输出三类：resolved / ambiguous / unresolved。
- ambiguous/unresolved 进入 review task。
- 不确定时保留原文本，不制造假链接。

### 9.3 typed graph 与 OKF untyped link 的冲突

问题：

OKF 标准 link 本身不承载关系类型，而你的知识图谱需要 `depends_on/configured_in/consumes` 等 typed relation。

方案：

- Markdown link 用于通用浏览和基础图谱。
- `relationships` frontmatter 扩展保留 typed relation。
- `_kh/graph.json` 继续作为高性能图谱索引。
- graph stage 的可信/候选/禁止关系机制不变。

### 9.4 citations 覆盖率不足

问题：

历史 Wiki 页可能只有 `source`，没有每条事实级证据。

方案：

- 第一阶段：页面级 citation，引用 docx/xlsx reference。
- 第二阶段：facts 级 evidence，关键 fact 关联 source chunk。
- 第三阶段：Agent 输出归因使用 citation trace。

质量策略：

- 页面级 citation 缺失：warning。
- 关键 fact 缺 evidence：warning 或 blocking，由 Profile 控制。
- Agent 输出引用不存在：blocking。

### 9.5 OKF 宽松消费与内部严格治理的冲突

问题：

OKF 允许 broken links、unknown type、missing optional fields，但内部发布不能太宽松。

方案：

- 分离 `okfConformance` 与 `khQualityGate`。
- OKF conformance 只保证通用可读。
- KH quality gate 决定能否发布给内部 Agent。

### 9.6 文件名、路径和跨平台问题

问题：

- 中文文件名、空格、括号、`&` 在不同系统和 URL 中可能有兼容问题。
- Windows 与 Linux 路径分隔符不同。

方案：

- OKF concept ID 使用 POSIX path。
- 文件名保留可读中文，但 manifest 中记录 stable ID。
- link target 统一使用 `/systems/成就.md` 形式。
- 对特殊字符进行 URL-safe link encoding。
- exporter 输出路径规范测试。

### 9.7 references 是否暴露敏感信息

问题：

原始 docx/xlsx 可能包含未发布内容、内部路径、人员信息。

方案：

- references 默认只输出摘要、hash、source id，不输出全文。
- 是否导出 extracted text 由 release 配置控制。
- 外部 OKF 包与内部 OKF 包分级：

```text
internal_okf_bundle/  包含 source 摘要和更多 trace
external_okf_bundle/  移除敏感字段，仅保留必要 citations
```

### 9.8 与现有数据库发布模型的关系

问题：

如果 OKF bundle 被视为事实源，会破坏不可变 release 和审核机制。

方案：

- OKF bundle 必须绑定 release id。
- OKF bundle 的 hash 写入 release manifest。
- OKF bundle 不允许被人工单独修改后回写数据库。
- 如果未来支持 OKF import，必须走 source import + review，不得直接覆盖发布资产。

### 9.9 构建性能和包体积

问题：

`gamedata` 表很多，references 全量展开可能导致 release 很大。

方案：

- table reference 先输出 schema 摘要，不输出全量数据。
- 大表数据只保留 source hash 和 row/column summary。
- 支持 lazy references：只为被 Wiki 引用的 source 生成 reference concept。
- `_kh/table_registry.json` 可压缩或按需拆分。

### 9.10 UI 复杂度

问题：

如果把 OKF 暴露成一堆 YAML 字段，会重蹈 JSON 配置不友好的问题。

方案：

- 策划继续在“策划立法”页面维护业务规则。
- OKF 字段由系统自动编译。
- 前端只展示 OKF 预览、缺失项、发布报告，不要求策划手写 YAML。

## 10. 分阶段实施计划

### Phase 1：OKF 兼容性扫描

目标：不改构建结果，只评估当前知识库与 OKF 的差距。

新增能力：

- 扫描 `wiki/**/*.md`
- 检查 frontmatter parse
- 检查 `type` 非空
- 检查 reserved files：`index.md/log.md`
- 统计缺失 `description/resource/tags/timestamp`
- 扫描 `[[...]]` 链接、标准 Markdown link、broken link

输出：

```text
okf_report.json
okf_report.md
```

验收：

- 能报告当前 `knowledge/wiki` 的 OKF 基线。
- 不修改任何知识文件。
- 报告能区分 OKF blocking 与 KH warning。

### Phase 2：OKF Bundle Exporter v1

目标：生成可读、可解析、可 diff 的 OKF bundle。

新增能力：

- 复制 Wiki concept
- 补充标准 frontmatter
- 从 `_meta` 回填 entities/facts/relationships
- 生成 root `index.md`
- 生成目录级 `index.md`
- 生成 `_kh/manifest.json`
- 生成 `_kh/graph.json`

暂不做：

- 不强制 facts 级 citations；
- 不改变原始 `knowledge/wiki`；
- 不做 OKF import。

验收：

- `okf_bundle/**/*.md` 均可 parse。
- 每个 concept 有非空 `type`。
- root index 声明 `okf_version: "0.1"`。
- OKF report 无 conformance blocking。

### Phase 3：链接标准化与 review task 回流

目标：让 Wiki 内容从 `[[...]]` 迁移为 OKF 友好的 Markdown links。

新增能力：

- LinkResolver
- entity/table/page path registry
- resolved/ambiguous/unresolved link report
- ambiguous/unresolved 自动生成 review_task

验收：

- 系统页和活动页中的核心表引用能生成 bundle-relative links。
- 不确定链接不会被误连。
- link 问题进入审核队列。

### Phase 4：References 与 Citations

目标：让 OKF bundle 具备可审计证据链。

新增能力：

- `references/gamedocs/*.md`
- `references/gamedata/*.md`
- Wiki 页 `# Citations`
- facts/evidence 到 citations 的映射

验收：

- 每个 system/activity page 至少有一个 source citation。
- 每个 table_schema page 至少有一个 table reference citation。
- Release manifest 记录 citation coverage。

### Phase 5：Release 集成

目标：OKF bundle 成为正式发布物的一部分。

新增能力：

- release publish 生成 OKF bundle
- manifest 记录 OKF hash
- 发布详情展示 OKF conformance summary
- Agent trace 返回 OKF path/citation

验收：

- 每个 release 都能下载/查看 OKF bundle。
- Agent 查询结果能返回 conceptId、okfPath、citations。
- OKF conformance blocking 时拒绝发布。

### Phase 6：OKF Import / Exchange（后续）

目标：支持其他团队或外部 Agent 提供 OKF bundle，进入 Knowledge Hub 审核流程。

注意：这不是近期必做项。

导入必须走：

```text
OKF bundle
  -> source import
  -> draft asset package
  -> conformance scan
  -> review
  -> publish
```

不能直接把外部 OKF 当成可信发布资产。

## 11. 数据模型建议

可以先不新增大量表，优先复用 release manifest 和 asset component quality。

### 11.1 Release manifest 扩展

```ts
interface ReleaseManifestOkf {
  version: "0.1";
  exporterVersion: number;
  bundlePath: string;
  bundleHash: string;
  conceptCount: number;
  referenceCount: number;
  conformance: {
    blocking: number;
    warning: number;
    info: number;
  };
}
```

### 11.2 Asset component quality 扩展

```ts
interface OkfQuality {
  okfPath?: string;
  conceptId?: string;
  frontmatterValid: boolean;
  linkSummary: {
    resolved: number;
    ambiguous: number;
    unresolved: number;
  };
  citationSummary: {
    required: number;
    present: number;
  };
}
```

### 11.3 Review task 来源扩展

```ts
interface OkfReviewSource {
  source: "okf_export";
  okfPath: string;
  issueType: "missing_frontmatter" | "missing_type" | "ambiguous_link" | "unresolved_link" | "missing_citation";
  blocking: boolean;
}
```

## 12. API 与前端入口建议

### 12.1 API

```text
GET  /api/releases/:releaseId/okf/report
GET  /api/releases/:releaseId/okf/files
GET  /api/releases/:releaseId/okf/file?path=/systems/成就.md
POST /api/releases/:releaseId/okf/rebuild
```

`rebuild` 只允许 admin/lead 使用，并且必须基于同一个 release 的不可变组件重建，不可引入新内容。

### 12.2 前端

在“发布”页增加：

- OKF 状态卡片；
- conformance summary；
- link/citation 问题列表；
- OKF 文件浏览；
- 下载 bundle；
- “生成审核任务”入口。

在“资产包详情”页增加：

- concept 的 OKF frontmatter 预览；
- link resolver 结果；
- citations 覆盖率。

策划侧只看“缺链接、缺证据、缺描述、关系不明确”等业务语言，不展示 YAML。

## 13. 测试计划

### 13.1 单元测试

- frontmatter serializer 能正确处理中文、冒号、数组、换行。
- OKF scanner 能识别 missing type。
- LinkResolver 能解析表、系统、活动。
- LinkResolver 对多候选返回 ambiguous。
- exporter 能从 `_meta` 回填 entities/facts/relationships。
- citation generator 能生成 `# Citations`。
- index generator 能生成目录级 index。
- log generator 使用 ISO date。

### 13.2 服务测试

- 对现有 `knowledge/wiki` 扫描生成 report。
- release publish 后生成 `okf_bundle`。
- OKF conformance blocking 时拒绝发布。
- open blocking review task 仍优先拒绝发布。
- release manifest 包含 OKF hash。

### 13.3 API 测试

- 获取 release OKF report。
- 浏览 OKF 文件列表。
- 读取单个 OKF concept。
- 非 admin 不能 rebuild OKF。

### 13.4 回归测试

- 现有 MCP tool name 不变。
- 现有 release rollback 行为不变。
- 现有 graph/table 查询不依赖 OKF bundle。

## 14. 验收标准

第一阶段成功：

- 能生成当前知识库的 OKF 差距报告。
- 不修改原始 `knowledge/`。
- 能明确列出缺失 description/tags/citations/links 的页面。

第二阶段成功：

- release 中包含可独立阅读的 OKF bundle。
- 所有 concept 均有 parseable frontmatter 和非空 type。
- root index 可作为 Agent 的入口。

第三阶段成功：

- 核心系统/活动页中的表引用可以跳转到对应 table concept。
- ambiguous/unresolved link 能形成审核任务。

第四阶段成功：

- 每个正式发布 concept 都有至少页面级 citation。
- Agent 输出归因可以关联 OKF path 和 citation。

最终成功：

- Knowledge Hub 保持内部强治理；
- OKF bundle 成为标准化发布物；
- 外部 Agent 即使不理解 Knowledge Hub DB，也能读懂知识包；
- 内部 Agent 通过 MCP 获取更清晰的 path、citation、quality trace；
- 策划仍然通过可视化立法页面维护规则，不需要手写 YAML。

## 15. 不建议做的事

1. **不要把 OKF 当成新的数据库。**
   OKF 是导出格式，不应承担审核状态、权限、任务流的事实源职责。

2. **不要一开始就改写现有 `wiki/`。**
   先导出 `okf_bundle/`，确认兼容后再考虑回填。

3. **不要让策划手写 frontmatter。**
   YAML 应由系统生成，策划维护业务规则。

4. **不要丢弃 typed graph。**
   OKF link 是通用关系，不能替代 `depends_on/configured_in/consumes` 等业务关系。

5. **不要因为 OKF 宽松就放松发布门禁。**
   OKF 合规只是基础，可发布仍要过策划立法和质量红线。

## 16. 推荐近期落地顺序

建议下一步只做三件事：

1. `OkfConformanceService`
   读取 `knowledge/wiki` 或 release workspace，输出 conformance report。

2. `OkfExportService`
   从现有 Wiki + `_meta` 生成 `okf_bundle`，先不做复杂 link resolver。

3. Release 页面 OKF 报告入口
   让管理员能看到 OKF bundle 是否可发布、缺哪些字段、哪些页面要补。

这三步完成后，再推进 link resolver、references/citations、Agent trace。这样收益清晰，风险可控，也不会干扰当前知识飞轮主流程。
