# 知识库立法机制：策划治理与 Agent 反馈闭环

> 从"文档仓库"到"策划集体大脑"的关键一环

## 核心问题

知识库能沉淀**显性知识**（写在文档里的规则、表结构、数值），但沉淀不了**隐性知识**（策划脑子里的判断标准）：

- "这个数值为什么这么定？"
- "这种活动设计为什么不行？"
- "什么时候该用 A 方案而不是 B 方案？"

**解法**：让策划从"文档作者"升级为"知识立法者"——他们定义什么是好知识、什么不能动、什么必须有证据，系统负责把这些规则编译成不可绕过的约束。

---

## 一、双端立法：知识库端 + Agent 端

### 知识库端：资产生产的合规性

```
策划立法 → Wiki Spec + 可变性矩阵 + 质量标准
         ↓
   知识库强制执行（质量门禁）
         ↓
   只有合规资产才能发布
```

**作用**：保证进入 Agent 的知识是**可信、可追溯、结构化**的。

### Agent 端：消费反馈的结构化

```
Agent 查询 → 命中/未命中/低质量命中
          ↓
    结构化反馈记录
          ↓
    驱动知识库演进
```

**作用**：把"Agent 用得怎么样"转成**可操作的改进任务**，而不是主观抱怨。

### 闭环

```
策划立法 → 知识库执行 → Agent 消费 → 反馈回流 → 策划修订立法
```

没有立法，知识库是搜索引擎；有了立法，知识库是**治理系统**。

---

## 二、知识库端立法：三张表 + 一个流程

### 2.1 Wiki Spec：每种资产的"产品需求"

策划为每种知识资产类型定义**必填字段、推荐字段、禁止模式、证据要求**。

**模板**

```yaml
spec_id: system_rule_v2
owner: 战斗策划组/张三
last_update: 2026-06-10
status: active

required_fields:           # 缺这些就不算合格
  - 系统名称
  - 触发条件
  - 核心循环
  - 数值边界
  - 依赖系统

recommended_fields:        # 有更好
  - 设计意图
  - 反例（不该出现的情况）
  - 历史变更原因

forbidden_patterns:        # 出现就驳回
  - "大概"、"可能"、"一般来说"等模糊表达
  - 没有数值的"很多"、"较少"
  - 未经验证的推断性结论

evidence_requirement:      # 证据强度
  level: strict            # strict / normal / loose
  must_cite: true
  min_source_refs: 1

review_role: 系统策划主程
review_sla: 48h
```

**策划填这张表**，开发把它编译成 JSON Schema + 质量检查函数。

**存放位置**：`constitution/wiki_specs/system_rule_v2.yaml`

---

### 2.2 资产可变性矩阵：什么动了会死

策划列出每种资产的**可变程度、变更影响范围、审批权限**。

**模板**

| 资产类型 | 可变性 | 变更影响 | 谁能批 | 变更必须走的流程 |
|----------|--------|----------|--------|------------------|
| 原始 docx/xlsx | **不可变** | 重新生成下游全部资产 | 文档作者 | 只能出新版本，不能原地修改 |
| 数值常量（暴击率公式系数） | **半不可变** | 触发全表重平衡 review | 数值策划主程 | 必须附影响分析报告 |
| 枚举值（装备品质 1-5） | **不可变** | 所有引用表必须迁移 | 系统策划主程 | 只能加，不能改不能删 |
| Wiki 页面正文 | **可变** | 走审核流程 | 模块负责人 | draft → review → approved |
| Topic Index / 别名表 | **完全可变** | 不影响下游 | 任何策划 | 直接修改 + 审核 |
| 已发布 Release | **不可变（绝对）** | 修复必须出新版 | 知识库管理员 | 不可回退已发布版本的指针 |
| 推断关系（low_confidence） | **可变** | 标记为人工确认即可 | 模块负责人 | 补证据后转 approved |
| 表结构 Schema | **半不可变** | 影响所有引用表和 Wiki | 表结构负责人 | 必须先检查 FK 依赖 |

**这张表就是"知识库宪章"**。系统按这张表施加约束（不可变项的修改请求直接拒绝，半不可变的触发影响分析）。

**存放位置**：`constitution/knowledge/KC-MUTABILITY-001.md`

---

### 2.3 质量标准：用反例定义"坏知识"

策划用**反例**来定义坏知识，比正例更有效。

**模板**

```yaml
quality_rules_v1:
  owner: 知识库质量组/李四
  last_update: 2026-06-10

  blocking:    # 阻断发布
    - id: Q-NO-EVIDENCE
      desc: 系统规则页面无 source_refs
      example_bad: "玩家死亡后会复活"  # 没说出处
      example_good: "玩家死亡后会复活 [复活系统设计文档v3 §2.1]"
      check: artifact.source_refs is not empty

    - id: Q-DANGLING-FK
      desc: 表字段 FK 指向不存在的表
      example_bad: drop_table_id 引用了 ItemDrop 表，但 ItemDrop 表不存在
      check: all FK targets exist in current release

    - id: Q-CONFLICT-NUMBER
      desc: 同一数值在两处文档值不同且都未标注哪个是最新
      example_bad: 暴击伤害公式在《战斗设计》=1.5x，在《数值大表》=2.0x
      check: conflict tag must be resolved or marked with supersedes

    - id: Q-VAGUE-LANGUAGE
      desc: 正文中出现模糊量词
      example_bad: "玩家获得很多经验"
      example_good: "玩家获得 100 经验"
      check: forbidden_patterns not in content

  warning:     # 警告（不阻断但需要关注）
    - id: Q-LOW-CONFIDENCE-HIGH-USE
      desc: 标记为 low_confidence 的知识被 Agent 频繁命中
      action: 优先补证据
      threshold: hit_count > 10 in 7 days

    - id: Q-ORPHAN-PAGE
      desc: Wiki 页面没有被任何 index 引用
      action: 补充到 topic_index 或标记为废弃

  forbidden_in_published:    # 发布版禁止出现
    - 任何 inferred 标签未经人工确认的关系
    - 任何 conflict 未解决的页面
    - 任何 source_refs 为空的核心资产（系统规则、表结构）
```

**策划用自然语言写反例，开发把它转成 check 函数**。

**存放位置**：`constitution/quality/QC-RULES-001.yaml`

---

### 2.4 立法流程

```
策划提交 spec / 可变性规则 / 质量标准
  → 知识库管理员 review
  → 合并到 constitution/
  → 系统自动加载为约束
  → 下一次 artifact 生成/审核/发布时强制执行
```

**关键点**：
- 立法文档必须版本化（v1 → v2），旧资产按旧规则，新资产按新规则
- spec owner 必须到人，不能是"策划组"
- 立法文档变更必须走 PR 流程（就像改代码一样）

---

## 三、Agent 端反馈：把消费结果转成改进任务

### 3.1 结构化反馈类型

Agent 查询后，系统记录以下反馈：

| 反馈类型 | 含义 | 转成的任务 |
|----------|------|------------|
| **未命中（miss）** | Agent 查询了某个主题/实体/表，但知识库没有 | 补 topic_index / 补 Wiki 页 / 补表结构 |
| **低质量命中（low_quality_hit）** | 命中了但返回的知识标记为 low_confidence / conflict / stale | 优先补证据 / 解决冲突 / 更新过期内容 |
| **高频重复查询（repeated_query）** | Agent 反复查同一关系/同一表/同一实体 | 检查图谱是否需要强化 / 是否该建索引 |
| **证据不足抱怨（evidence_insufficient）** | Agent 调用返回的 quality_flags 中有 `missing_evidence` | 回溯到原始文档补证据 |
| **关系推断失败（relation_inference_failed）** | Agent 期望 A 和 B 有关系，但图谱中没有 | 人工确认后补关系，或标记为"确实无关" |

### 3.2 反馈记录格式

```json
{
  "feedback_id": "fb_2026_06_10_001",
  "type": "miss",
  "agent_query": "获取装备强化系统的触发条件",
  "query_intent": "system_rule",
  "missed_topic": "装备强化",
  "current_release_id": "rel_2026_06_10_001",
  "timestamp": "2026-06-10T10:30:00Z",
  "suggested_action": "补充 topic_index: '装备强化' → wiki/systems/equipment_enhance.md",
  "priority": "high",
  "assigned_to": null
}
```

**存放位置**：`data/feedback/<feedback_id>.json`

### 3.3 反馈驱动的改进任务

```
反馈记录
  → 自动分类（miss / low_quality / repeated）
  → 生成维护任务
  → 关联到对应 artifact / package / spec
  → 分配给 spec owner
  → 不处理则阻断下次大版本发布
```

**关键机制**：
- 同类反馈 ≥ 3 次 → 自动升级为"阻断级任务"
- 反馈关联到具体 artifact_id 和 spec_id，不是抽象问题
- 反馈解决后，回填到错误本（`constitution/knowledge/KC-ERRORBOOK-001.md`）

---

## 四、错误本机制：从失败中立法

你已经有 `KC-ERRORBOOK-001`，可以更进一步：

### 4.1 错误本触发 Spec 修订

```
错误本中某类失败 ≥ 3 次
  → 自动生成"Spec 修订建议"
  → 指定 spec owner 处理
  → owner 必须选择：
      1. 修订 spec，补充遗漏字段
      2. 修订质量标准，加强检查
      3. 说明为什么这不是 spec 问题（需要主管审批）
```

### 4.2 错误本 = 持久纠错源

```yaml
error_book_entry:
  id: EB-2026-06-10-001
  failure_type: miss
  pattern: Agent 查询"装备强化系统"未命中
  root_cause: topic_index 中没有"装备强化"别名，只有"强化系统"
  solution: 修订 spec 要求所有系统页面必须列出常用别名
  spec_updated: wiki_specs/system_rule_v2.yaml
  status: resolved
  recurrence_count: 0
```

**如果同一 pattern 再次出现 → recurrence_count++**，超过阈值则标记为"未根治"，阻断发布。

---

## 五、双端协同的完整流程

### 初始化阶段

1. **策划填三张表**（1-2 周）
   - 资产可变性矩阵
   - 每种 artifact_type 的 wiki_spec
   - 5-10 个最痛的"坏知识"反例

2. **开发实现约束**（1-2 周）
   - wiki_spec → JSON Schema + 生成时校验
   - 可变性矩阵 → artifact 修改时权限检查
   - 质量标准 → 质量门禁 check 函数

3. **Agent 接入结构化工具**（1-2 周）
   - 迁移到 MCP，只走 `kb_get_*` / `kb_query_*` 工具
   - 禁止自由文本读取
   - 每次查询记录反馈

### 运行阶段

```
策划提交文档
  → 知识库生成 artifact
  → 质量门禁按 spec 和标准检查
    → 不合规 → 驳回 + 生成待修任务
    → 合规 → 进入审核
  → 人工审核通过
  → 发布为 release
  → Agent 消费
    → 命中 → 记录使用情况
    → 未命中 / 低质量 → 生成反馈
  → 反馈累积到阈值
    → 转成维护任务
    → 分配给 spec owner
  → owner 修复或修订 spec
  → 下一版发布
```

### 演进阶段

```
错误本中重复失败 ≥ 3 次
  → 强制修订 spec
  → spec 版本升级（v1 → v2）
  → 旧 artifact 标记"待复审"
  → 按新 spec 重新审核
```

---

## 六、关键设计原则

### 6.1 策划必须是立法者，不是执行者

❌ 错误做法：开发定义 spec，策划被动填写
✅ 正确做法：策划定义什么是好知识，开发把规则编译成约束

### 6.2 立法必须版本化

❌ 错误做法：spec 改了就全局生效，旧资产突然不合规
✅ 正确做法：spec 有版本（v1 / v2），旧资产按旧规则，新资产按新规则，旧资产标记"待按新规则复审"

### 6.3 反馈必须结构化，不能是自由文本

❌ 错误做法："Agent 用得不好"
✅ 正确做法：`{ type: "miss", topic: "装备强化", suggested_action: "补 topic_index" }`

### 6.4 错误本必须驱动立法演进

❌ 错误做法：错误本只是日志，看了就忘
✅ 正确做法：同类失败 ≥ 3 次 → 强制修订 spec，否则阻断发布

### 6.5 Agent 必须只读结构化资产

❌ 错误做法：Agent 可以读自由文本，策划不痛
✅ 正确做法：Agent 只能通过 `kb_get_system_rule(id)` 等工具读取，读不到就 miss，策划才会感受到"知识没结构化"的代价

---

## 七、存放位置规范

```
constitution/
  wiki_specs/                    # Wiki Spec（策划填写）
    system_rule_v2.yaml
    table_schema_v1.yaml
    activity_template_v1.yaml
  knowledge/                     # 可变性和错误本（策划+管理员维护）
    KC-MUTABILITY-001.md         # 资产可变性矩阵
    KC-ERRORBOOK-001.md          # 错误本机制
  quality/                       # 质量标准（策划填写）
    QC-RULES-001.yaml            # 质量反例库

data/
  feedback/                      # Agent 反馈（系统自动生成）
    <feedback_id>.json
  error_book/                    # 错误本实例（系统+人工记录）
    <error_id>.json
```

---

## 八、验收标准

立法机制成功落地的标志：

- ✅ 每种 artifact_type 都有明确的 spec owner（到人）
- ✅ 资产可变性矩阵覆盖所有核心资产类型
- ✅ 质量门禁有 ≥ 10 条具体的"坏知识反例"
- ✅ Agent 消费反馈能自动转成维护任务
- ✅ 错误本中同类失败 ≥ 3 次能强制触发 spec 修订
- ✅ spec 版本化，旧资产标记"待复审"而不是直接失效
- ✅ 策划能看懂 spec、能填 spec、能根据错误本修订 spec

---

## 九、总结

| 端 | 角色 | 输入 | 输出 | 核心机制 |
|----|------|------|------|----------|
| **知识库端** | 资产生产的合规性守护者 | spec + 可变性矩阵 + 质量标准 | 合规的可发布资产 | 质量门禁 + 版本化约束 |
| **Agent 端** | 消费反馈的结构化记录者 | Agent 查询 + 命中情况 | 结构化反馈 + 维护任务 | 反馈分类 + 任务生成 |
| **错误本** | 持久纠错源 + 立法演进驱动器 | 重复失败模式 | spec 修订建议 + 阻断发布 | ≥ 3 次失败 → 强制修 spec |

**最终目标**：让知识库从"搜索引擎"变成"治理系统"，从"文档仓库"变成"策划集体大脑"。

没有策划立法的知识库，再精巧的工程也只是高级文档管理器。有了立法的知识库，才能真正成为**公司策划的第二大脑**。
