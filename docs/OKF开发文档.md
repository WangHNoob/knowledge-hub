# OKF 集成开发文档（P1–P6 总纲）

> 本文是《[OKF 引入方案](./OKF引入方案.md)》的施工图。引入方案回答 **why / what**，本文回答 **how**：落到真实文件路径、TypeScript 接口契约、数据模型改动、API、前端入口、测试与分阶段任务拆分。
>
> **阅读顺序**：先读 §0–§3（共识与契约），再按阶段读 §4–§9，§10–§12 是横切的数据模型 / 测试 / 任务总表。
>
> **状态**：草案 v1，待评审。所有「新增」标记的类型与文件均为待实现；所有「现状」标记的内容均已对照当前代码核实。

---

## §0 目标与非目标

### 0.1 目标

1. 把每个不可变 `Release` 导出为一个符合 OKF v0.1 的 `okf_bundle/`，作为标准化、可交换、可审计、Agent 友好的发布外壳。
2. 不降低现有治理标准：OKF conformance 是底线，策划立法（`KnowledgeRuleProfile`）仍是发布线。
3. 不推翻现有「路由 → Service → DB」薄分层、不可变 source/release、质量门禁、策划立法、MCP 读模型。

### 0.2 非目标

- 不把 OKF 当事实源或新数据库。事实源仍是 `sources / asset_packages / asset_components / evidence_records / review_tasks / releases / knowledge_rule_profiles`。
- 不在第一阶段改写 `knowledge/wiki/` 的生成方式（先导出，后回填）。
- 不让策划手写 YAML frontmatter。
- 不丢弃 typed graph（`depends_on / configured_in / consumes` 等业务关系）。

### 0.3 与《引入方案》的关系与修正

本文采纳引入方案的整体路线，但修正两处与真实代码不符的假设：

| 引入方案的表述 | 真实现状 | 本文的处理 |
|---|---|---|
| release artifact 在仓库根 `releases/<release_id>/okf_bundle/` | `releaseService.publish()` 只写 **DB manifest**，release 当前**没有任何磁盘产物**；`KH_DATA_DIR`（默认 `./data`）才是 source blobs / kb-build-runs 工作区的落盘根 | bundle 落盘到 `KH_DATA_DIR/releases/<releaseId>/okf_bundle/`；**P5 显式定性为「首次为 release 引入磁盘 artifact」**，不是往已有目录加东西 |
| exporter 从 `knowledge/wiki` 派生即可 | `knowledge/wiki` 是 kbBuilder 的**构建产物 / 工作区**，不绑定具体 release；release 绑定的是 `asset_components.storageUri` + `asset_packages` | **P1 conformance 扫工作区做基线**；**P5 集成时 exporter 必须从 release 绑定的 components/packages 派生**，否则破坏不可变发布语义（见 §1.3） |

---

## §1 架构总览

### 1.1 数据流

```text
SourceVersion (不可变)
  -> KnowledgeRuleProfile (版本化，策划立法)
  -> kbBuilder BuildRun  ──> knowledge/wiki/**, _meta/*.json, graph.json, _tables/*.json   [构建工作区，不绑定 release]
  -> Draft AssetPackage / AssetComponent (storageUri 指向落盘产物)
  -> Review (review_tasks)
  -> Release (不可变) ──┐
                        ├─> OkfExportService ──> KH_DATA_DIR/releases/<releaseId>/okf_bundle/   [release 绑定的不可变快照]
                        └─> manifest.okf { bundleHash, conformance, ... }   (写入 releases.manifest_json)
  -> Agent / Git / 审计 / 外部交换
```

### 1.2 两条扫描边界（**关键，引入方案未点破**）

OKF 能力在两个不同输入上运行，**绝不可混用**：

- **P1 `OkfConformanceService`（基线扫描）**：输入 = 任意工作区目录（默认 `knowledge/wiki`）。用途：评估当前知识库与 OKF 的差距、CI 巡检。**只读，不绑定 release，不进入发布闭环。**
- **P5 `OkfExportService`（发布导出）**：输入 = 一个已构造的 `Release` 绑定的 `asset_components`（`storageUri`）+ `asset_packages` + 记录在 manifest 的 legislation profile。用途：生成正式发布物。**输出绑定 releaseId + bundleHash。**

二者共享底层纯函数（frontmatter 序列化、link resolver、index/citations 生成），但入口与语义分离。

### 1.3 不可变性保证

- `releases` 行 published 后不再 UPDATE（现状已如此：`UPDATE ... WHERE status = 'draft'`）。
- `okf_bundle/` 目录写入一次后视为只读；不提供「编辑 bundle 回写 DB」的路径。
- `manifest.okf.bundleHash` 与 release 绑定；rollback = 把 `release_channels.current_release_id` 指回旧 release（现状机制不变，见 `pointChannelToRelease`），其 bundle 目录天然还在。
- `rebuild` 只允许 admin/lead，且必须基于**同一 release 的不可变 components 重建**，重建结果 hash 必须与原 `bundleHash` 一致，否则报错（防止引入新内容）。

### 1.4 bundleHash 计算（确定性）

复用现有 `releaseService.ts` 的 `sha256:` 前缀风格，但对文件树定义稳定算法：

```text
对 bundle 内每个文件 f：fileHash(f) = sha256(bytes(f))
entries = 排序后的 [ (posixRelPath, fileHash) ]   // 按 posixRelPath 升序
bundleHash = "sha256:" + sha256( stableStringify(entries) )
```

- 路径一律 POSIX（`/`），排序用 `localeCompare` 的字节序等价（`a.path < b.path`）。
- `_kh/` 目录**纳入** bundleHash（它是 release 快照的一部分）。
- 时间戳类字段（`timestamp`、`log.md` 日期）必须来自 release 的 `published_at`，不得用 `Date.now()`，否则破坏可重建性。

---

## §2 模块与文件清单

### 2.1 新增文件（后端）

```text
src/server/services/okf/
  types.ts                 OKF 领域类型与契约（§3）
  okfFrontmatter.ts        frontmatter 序列化/反序列化（YAML safe）
  okfMarkdown.ts           body 解析、Citations 章节、[[..]] 提取
  conformanceService.ts    P1 OkfConformanceService
  exportService.ts         P2/P5 OkfExportService
  linkResolver.ts          P3 LinkResolver（resolved/ambiguous/unresolved）
  references.ts            P4 reference concept 生成
  citations.ts             P4 # Citations 生成 + 覆盖率
  indexLog.ts              index.md / log.md 生成
  bundleHash.ts            §1.4 确定性 hash
  conceptRegistry.ts       entity/table/page → okfPath 注册表（resolver 依赖）
```

### 2.2 改动文件（后端）

| 文件 | 改动 |
|---|---|
| `src/server/services/releaseService.ts` | `publish()` 调用 exporter 落盘并写 `manifest.okf`；新增发布门禁第三层（OKF conformance）；`buildManifest` 增 `okf` 字段 |
| `src/server/services/knowledgeQueryService.ts` | MCP trace 返回增加 `okfPath` / `citations`（保留 `componentId`） |
| `src/server/services/legislationService.ts` | 暴露「编译为 OKF profile」的派生（必填字段、目录、tags、citation 规则） |
| `src/server/types.ts` | 增 `ReleaseManifestOkf`、`OkfQuality`、`OkfReviewSource`（§3 / §10） |
| `src/server/app.ts` | 注册 §12 的 OKF 路由 |
| `src/server/config.ts` | 增 `KH_OKF_*` 配置项（导出开关、是否输出 extracted text、internal/external 分级） |

### 2.3 新增文件（前端）

- `src/client/api.ts`：新增 OKF 相关请求函数（类型化）。
- `src/client/ui/App.tsx`：发布页 OKF 状态卡片 / conformance 摘要 / 问题列表 / 文件浏览 / 下载；资产包详情页 frontmatter 预览 + link/citation 覆盖率。策划侧只看业务语言。

### 2.4 测试文件

```text
tests/okf-frontmatter.test.ts      序列化中文/冒号/数组/换行
tests/okf-conformance.test.ts      P1 扫描
tests/okf-link-resolver.test.ts    P3 resolved/ambiguous/unresolved
tests/okf-export.test.ts           P2/P5 exporter + bundleHash 确定性
tests/okf-citations.test.ts        P4
tests/release-service.test.ts      （改）publish 生成 bundle、门禁、manifest.okf
tests/api.test.ts                  （改）OKF API + 权限
```

---

## §3 核心类型与接口契约

> 全部置于 `src/server/services/okf/types.ts`，从 `src/server/types.ts` 再导出。遵循项目规范：禁止 `any`，入参 zod 校验。

```ts
// ---- 概念与 frontmatter ----
export type OkfConceptKind = "concept" | "reference";

export interface OkfFrontmatter {
  type: string;                 // OKF 唯一必填字段
  title?: string;
  description?: string;
  resource?: string;            // 例: kh://source/gamedocs/成就.docx
  tags?: string[];
  timestamp?: string;           // ISO 8601，取 release.published_at
  // ---- KH 扩展（OKF 允许 producer-defined keys；通用消费方可忽略）----
  kh?: {
    okfExportVersion: number;
    sourceVersionIds?: string[];
    packageId?: string;
    componentId?: string;
    legislationProfileId?: string;
    legislationProfileHash?: string;
    qualityStatus?: "passed" | "warning" | "blocked";
    contentHash?: string;       // reference 用
    originalPath?: string;      // reference 用
  };
  entities?: Array<{ name: string; type: string }>;
  facts?: Record<string, string>;
  relationships?: Array<{ relation: string; target: string; evidence?: number[] }>;
}

export interface OkfConcept {
  okfPath: string;              // POSIX，含前导 /，如 /systems/成就.md
  kind: OkfConceptKind;
  frontmatter: OkfFrontmatter;
  body: string;                 // 不含 frontmatter 的 markdown 正文（含 # Citations）
}

// ---- P1 Conformance ----
export type OkfIssueType =
  | "missing_frontmatter" | "missing_type" | "unparseable_yaml"
  | "obsidian_link" | "broken_link" | "ambiguous_link"
  | "missing_description" | "missing_tags" | "missing_timestamp" | "missing_resource"
  | "missing_citation";

export interface OkfIssue {
  okfPath: string;
  issueType: OkfIssueType;
  layer: "okf_conformance" | "kh_publish_quality";  // 见 §0.1：底线 vs 发布线
  blocking: boolean;
  message: string;
}

export interface ConformanceReport {
  okfVersion: "0.1";
  exporterVersion: number;
  scannedAt: string;            // ISO，调用方注入
  conceptCount: number;
  referenceCount: number;
  issues: OkfIssue[];
  summary: { blocking: number; warning: number; info: number };
  linkSummary: { resolved: number; ambiguous: number; unresolved: number };
  citationSummary: { required: number; present: number };
}

// ---- P3 Link ----
export interface LinkResolution {
  rawText: string;              // 原始 [[..]] 内文
  fromPath: string;
  status: "resolved" | "ambiguous" | "unresolved";
  target?: string;             // resolved 时的 okfPath
  candidates?: string[];       // ambiguous 时的多候选
}

// ---- release manifest 扩展（§10）----
export interface ReleaseManifestOkf {
  version: "0.1";
  exporterVersion: number;
  bundlePath: string;           // KH_DATA_DIR 相对路径
  bundleHash: string;           // sha256:...
  conceptCount: number;
  referenceCount: number;
  conformance: { blocking: number; warning: number; info: number };
}
```

### 3.1 Service 接口

```ts
// conformanceService.ts —— P1：纯读，作用于任意工作区
export interface OkfConformanceService {
  scanWorkspace(dir: string, opts?: { now: string }): Promise<ConformanceReport>;
}

// exportService.ts —— P2/P5
export interface OkfExportInput {
  releaseId?: string;                 // P5 提供；P2 试跑可空
  concepts: OkfSourceConcept[];       // 从 components 或 wiki 派生的中间表示
  references: OkfSourceReference[];
  profile: CompiledOkfProfile;        // 由 legislationService 编译
  publishedAt: string;                // bundle timestamp / log 日期来源
  outDir: string;                     // KH_DATA_DIR/releases/<releaseId>/okf_bundle
}

export interface OkfExportResult {
  bundlePath: string;
  bundleHash: string;
  report: ConformanceReport;
  linkResolutions: LinkResolution[];
}

export interface OkfExportService {
  export(input: OkfExportInput): Promise<OkfExportResult>;
}
```

`OkfSourceConcept` / `OkfSourceReference` 是「来源无关」的中间表示：P2 从 `knowledge/wiki` + `_meta` 适配，P5 从 `asset_components.storageUri` 适配。**这是 §1.2 两条边界共用 exporter 的接缝。**

---

## §4 Phase 1：OKF Conformance Service

**目标**：不改任何知识文件，输出当前知识库的 OKF 基线报告。

**实现要点**

1. 遍历 `dir` 下 `**/*.md`，跳过 reserved 文件（`index.md` / `log.md`）。
2. 逐文件 split frontmatter（`---` 分隔），用 YAML parser **逐文件 parse**，捕获异常 → `unparseable_yaml`。
3. 校验：frontmatter 块存在、`type` 非空（缺失 → `missing_frontmatter` / `missing_type`，layer=`okf_conformance`，blocking=true）。
4. 统计 optional 缺失（`description/resource/tags/timestamp`）→ layer=`kh_publish_quality`，blocking=false（warning）。
5. 扫 `[[...]]`（`obsidian_link`）、标准 markdown link、broken link。P1 阶段 broken/obsidian 仅计数与告警，不解析（解析在 P3）。
6. 输出 `ConformanceReport`（JSON）+ 可读 `okf_report.md`。

**依赖**：`okfFrontmatter.ts`、`okfMarkdown.ts`。

**验收**

- 能报告 `knowledge/wiki` 的 OKF 基线，区分 `okf_conformance`（blocking）与 `kh_publish_quality`（warning）。
- 不修改任何知识文件（测试断言目录 mtime/内容不变）。
- 输出 `okf_report.json` + `okf_report.md`。

**任务**：T1.1 frontmatter parser；T1.2 markdown/link 扫描；T1.3 report 聚合 + md 渲染；T1.4 CLI/脚本入口（`npm run okf:scan`）；T1.5 测试。

---

## §5 Phase 2：OKF Bundle Exporter v1

**目标**：从现有 Wiki + `_meta` 生成可读、可解析、可 diff 的 `okf_bundle/`。**暂不做复杂 link resolver**（`[[..]]` 先原样保留并计 warning）、**不做** facts 级强制 citations、**不改** 原始 wiki。

**输出目录结构**

```text
okf_bundle/
  index.md                 # 唯一允许带 frontmatter 的 index：okf_version: "0.1"
  log.md
  systems/   index.md  *.md
  activities/index.md  *.md
  tables/    index.md  *.md
  ui_flows/  index.md  *.md
  numerical/ ...           # 对应 knowledge/wiki/numerical、combat 等现有目录
  _kh/
    manifest.json
    graph.json
    table_fk_registry.json
    quality_summary.json
```

**frontmatter 回填来源**（从 `_meta/<page>.json`，已核实字段：`entities/facts/relationships/page_type/title/source/content_hash/wiki_path`）：

- `type` ← `page_type`
- `title` ← `title`
- `resource` ← `kh://source/gamedocs/<source>`（concept）
- `entities` ← `_meta.entities`
- `facts` ← `_meta.facts`（数组 → `Record<string,string>`）
- `relationships` ← `_meta.relationships`（`target` 先用实体名，P3 再标准化为 okfPath）
- `kh.contentHash` ← `_meta.content_hash`
- `timestamp` ← P2 试跑用固定注入值；P5 用 `published_at`

**index/log**

- root `index.md`：唯一带 frontmatter（仅 `okf_version: "0.1"`），body 按目录分组列概念，每条带 `description`。
- 目录级 `index.md`：无 frontmatter，`* [title](relative-url) - description` 格式。
- `log.md`：P2 可先生成「Creation」单条；P5 接 release diff。

**验收**

- `okf_bundle/**/*.md` 均可 parse；每个 concept 有非空 `type`。
- root index 声明 `okf_version: "0.1"`。
- conformance 无 blocking（warning 允许：`[[..]]`、缺 description/tags）。
- `_kh/manifest.json`、`_kh/graph.json` 生成正确（graph 直接复用 `knowledge/wiki/_tables` / `graph.json` 派生）。

**任务**：T2.1 中间表示适配器（wiki+_meta → `OkfSourceConcept`）；T2.2 frontmatter 序列化器；T2.3 index/log 生成；T2.4 `_kh` 附件；T2.5 bundleHash；T2.6 测试（含 hash 确定性：同输入两次 export hash 相同）。

---

## §6 Phase 3：链接标准化与 review_task 回流

**目标**：把 `[[实体名]]` / `[[表/子表]]` 迁移为 OKF bundle-relative link，不确定的不误连。

**LinkResolver 解析顺序**（`conceptRegistry.ts` 提供索引）

1. `_meta.entities` + `graph.json` nodes 的概念名 → okfPath。
2. 表名匹配 `_tables/groups.json` 的 group → `/tables/<group>.md`；子表用 `table_fk_registry.json` 归并到表族页。
3. 系统/活动名匹配 `systems/` `activities/` 文件名。
4. 多候选 → `ambiguous`，保留原文本 + warning。
5. 无候选 → `unresolved`，**保留纯文本不造假链接**（不生成 `/unresolved/*`）。

**回流**：`ambiguous` / `unresolved` 生成 `review_task`，来源标记 `OkfReviewSource`（§10.3）。`blocking` 由策划 profile 决定（默认 warning）。

**验收**

- 系统页 / 活动页核心表引用生成 bundle-relative link（如 `[SwitchCondition](/tables/SwitchCondition.md)`）。
- 不确定链接不被误连；link 问题进审核队列。

**任务**：T3.1 conceptRegistry；T3.2 resolver（三态）；T3.3 link report；T3.4 review_task 回流；T3.5 测试（含真实样例 `成就.md` 的 `[[海图绘]]`/`[[SwitchCondition]]`）。

---

## §7 Phase 4：References 与 Citations

**目标**：让 bundle 具备可审计证据链。

**References**（`references/` 作为 first-class reference concept）

```text
references/gamedocs/成就.md     type: Reference
references/gamedata/Achievement.md
```

- 默认只输出**摘要 + content_hash + source_version_id + original_path**，不输出全文（§9.7 敏感信息）。
- 是否输出 extracted text 由 `KH_OKF_EXPORT_EXTRACTED_TEXT` + release 配置控制。
- **lazy references**：只为被 Wiki 引用到的 source 生成 reference（§9.9 包体积）；大表只留 schema 摘要 + row/column count。

**Citations**（body 底部 `# Citations`，格式 `[1] [title](/references/...)`）

| 页面类型 | Citation 要求 |
|---|---|
| system_rule | ≥1 对应 docx reference |
| activity_template | ≥1 docx reference；涉及表配置时 + table reference |
| table_schema | ≥1 xlsx/table schema reference |
| ui_flow | ≥1 docx / UI 流程来源 |
| numerical_convention | docx/xlsx，且关键公式必须有 fact evidence |

**质量分层**：页面级 citation 缺失 → warning；关键 fact 缺 evidence → warning/blocking（profile 控制）；Agent 输出引用不存在 → blocking。

**验收**：每个 system/activity page ≥1 source citation；每个 table_schema page ≥1 table reference；manifest 记录 citation coverage。

**任务**：T4.1 reference 生成（含 lazy + 摘要化）；T4.2 citations 生成 + 覆盖率；T4.3 facts→evidence→citation 映射；T4.4 敏感字段分级（internal/external）；T4.5 测试。

---

## §8 Phase 5：Release 集成

**目标**：OKF bundle 成为正式发布物；**首次为 release 引入磁盘 artifact**。

### 8.1 publish 流程改造（`releaseService.publish`）

在现有流程（校验 → 查 open blocking task → 算 quality gate → buildManifest → 写 DB）中插入：

```text
... 现有 findOpenBlockingTasks（门禁第一层：blocking review task）
-> 现有 summarizePackages 质量门禁（门禁第二层：KH publish quality）
-> 【新】从 components(storageUri) + packages 派生 OkfSourceConcept/Reference
-> 【新】OkfExportService.export({ releaseId, outDir: KH_DATA_DIR/releases/<id>/okf_bundle, publishedAt })
-> 【新】门禁第三层：report.summary.blocking > 0 则拒绝发布（初期只 OKF conformance blocking 设为硬门禁；description/tags/citations 缺失先 warning）
-> buildManifest 增 okf: ReleaseManifestOkf
-> 写 DB（现有事务）
```

> 注意：exporter 输入是 **release 绑定 components**，不是 `knowledge/wiki`（§1.2）。需要一个 `componentsToOkfSource()` 适配器，从 `asset_components.storageUri` 读取已落盘的 wiki/meta 产物。

### 8.2 artifact 目录

```text
KH_DATA_DIR/releases/<releaseId>/
  okf_bundle/
  okf_report.json
```

manifest（`releases.manifest_json`）增字段，示例见 §10.1。

### 8.3 rollback

不变（`pointChannelToRelease`）。bundle 目录随 release 保留，rollback 即切 channel 指针。

### 8.4 API（§12）+ 前端（§2.3）+ MCP trace

MCP trace（`knowledgeQueryService`）返回增加：

```json
{
  "conceptId": "systems/成就",
  "okfPath": "/systems/成就.md",
  "type": "system_rule",
  "title": "成就系统",
  "citations": [{ "label": "[1]", "target": "/references/gamedocs/成就.md", "sourceVersionId": "srcv_..." }],
  "qualityFlags": [],
  "componentId": "comp_..."   // 保留作 debug 字段
}
```

**验收**：每个 release 可下载/查看 bundle；Agent 查询返回 conceptId/okfPath/citations；OKF conformance blocking 时拒绝发布；open blocking review task 仍优先拒绝；manifest 含 `okf.bundleHash`。

**任务**：T5.1 `componentsToOkfSource` 适配器；T5.2 publish 集成 + 门禁第三层；T5.3 buildManifest.okf；T5.4 落盘 + okf_report.json；T5.5 API；T5.6 前端发布页；T5.7 MCP trace；T5.8 测试（含 rebuild hash 一致性、门禁拒绝）。

---

## §9 Phase 6：OKF Import / Exchange（后续，不近期实现）

仅定契约，不展开实现。外部 OKF bundle 不得直接成为可信发布资产，必须走：

```text
OKF bundle -> source import -> draft asset package -> conformance scan -> review -> publish
```

复用现有 `sourceBundleService` / `legacyImportService` 的「不修改源 + 落 draft package」模式。导入产生的 concept 一律为 draft，经审核后才发布。

---

## §10 数据模型改动汇总

**原则**：优先复用 `releases.manifest_json` 与 `asset_components.quality`（JSON TEXT 字段），**P1–P5 不新增表**。P6 如需 import 溯源再评估。

### 10.1 Release manifest 扩展（写入 `manifest_json`）

```jsonc
{
  "releaseId": "rel_xxx",
  // ... 现有字段 ...
  "okf": {
    "version": "0.1",
    "exporterVersion": 1,
    "bundlePath": "releases/rel_xxx/okf_bundle",
    "bundleHash": "sha256:...",
    "conceptCount": 188,
    "referenceCount": 42,
    "conformance": { "blocking": 0, "warning": 3, "info": 0 }
  }
}
```

### 10.2 Asset component quality 扩展（写入 `asset_components.quality`）

```ts
interface OkfQuality {
  okfPath?: string;
  conceptId?: string;
  frontmatterValid: boolean;
  linkSummary: { resolved: number; ambiguous: number; unresolved: number };
  citationSummary: { required: number; present: number };
}
```

> 与现有 `quality` 字段合并存储（不破坏现有 key），读写遵循 CLAUDE.md「JSON 字段双向一致」约定。

### 10.3 Review task 来源扩展（写入 `review_tasks`）

```ts
interface OkfReviewSource {
  source: "okf_export";
  okfPath: string;
  issueType: "missing_frontmatter" | "missing_type" | "ambiguous_link" | "unresolved_link" | "missing_citation";
  blocking: boolean;
}
```

### 10.4 配置项（`config.ts` / `.env`）

| 变量 | 默认 | 用途 |
|---|---|---|
| `KH_OKF_EXPORTER_VERSION` | `1` | 写入 manifest，便于演进 |
| `KH_OKF_EXPORT_EXTRACTED_TEXT` | `false` | 是否在 reference 输出全文（§9.7） |
| `KH_OKF_CONFORMANCE_BLOCKING` | `true` | conformance blocking 是否硬门禁 |

---

## §11 测试计划

沿用现有模式：vitest，`app.inject()` 直调 Fastify，每用例 `mkdtempSync` 独立目录 + `createDatabase({ seed: true })`，结束 `rmSync`。

### 11.1 单元

- frontmatter serializer 正确处理中文 / 冒号 / 数组 / 换行；round-trip 后 `---` 不破坏正文。
- conformance 识别 missing type / unparseable yaml。
- LinkResolver 对表 / 系统 / 活动解析，多候选 → ambiguous，无候选 → unresolved（不造链接）。
- exporter 从 `_meta` 回填 entities/facts/relationships。
- citation generator 生成 `# Citations`。
- index generator 生成目录级 index；log 用 ISO date。
- **bundleHash 确定性**：同输入两次 export → hash 相同；改一个文件 → hash 变。

### 11.2 服务

- 扫 `knowledge/wiki` 生成 report。
- publish 后在 `KH_DATA_DIR/releases/<id>/okf_bundle` 生成 bundle。
- OKF conformance blocking → 拒绝发布。
- open blocking review task → 仍优先拒绝发布。
- manifest 含 `okf.bundleHash`。
- rebuild 重建 hash 与原一致；不一致 → 报错。

### 11.3 API

- 获取 release OKF report / 文件列表 / 单文件。
- 非 admin 不能 rebuild。

### 11.4 回归

- 现有 MCP tool name 不变。
- 现有 release rollback 行为不变（channel 切换）。
- 现有 graph/table 查询不依赖 OKF bundle。

---

## §12 API 与分阶段任务拆分

### 12.1 API（`app.ts`，zod 校验入参）

```text
GET  /api/releases/:releaseId/okf/report
GET  /api/releases/:releaseId/okf/files
GET  /api/releases/:releaseId/okf/file?path=/systems/成就.md
POST /api/releases/:releaseId/okf/rebuild        # admin/lead，基于同一 release 不可变组件重建，hash 必须一致
```

### 12.2 任务依赖顺序（每阶段独立可交付）

```text
P1: T1.1 frontmatter parser → T1.2 link scan → T1.3 report → T1.4 CLI → T1.5 test          [无依赖，可立即开工]
P2: T2.1 适配器 → T2.2 serializer(复用T1.1) → T2.3 index/log → T2.4 _kh → T2.5 hash → T2.6 test
P3: T3.1 registry → T3.2 resolver → T3.3 link report → T3.4 review 回流 → T3.5 test          [依赖 P2 的 bundle 结构]
P4: T4.1 references → T4.2 citations → T4.3 facts→evidence 映射 → T4.4 分级 → T4.5 test       [依赖 P3 的 okfPath]
P5: T5.1 componentsToOkfSource → T5.2 publish 集成 → T5.3 manifest.okf → T5.4 落盘 → T5.5 API → T5.6 前端 → T5.7 MCP trace → T5.8 test   [依赖 P2–P4]
P6: 契约定义，后续排期                                                                        [依赖 P5 稳定]
```

### 12.3 推荐近期落地顺序（引入方案 §16）

先做 **P1 全部 + P2 的 T2.1–T2.3 + T2.6**，再加发布页一个只读 OKF 报告入口。这样收益清晰、风险可控、不干扰知识飞轮主流程。link resolver（P3）、references/citations（P4）、Agent trace（P5）随后推进。

---

## 附录 A：验收里程碑（对齐引入方案 §14）

| 里程碑 | 标准 |
|---|---|
| P1 成功 | 生成 OKF 差距报告；不改 `knowledge/`；列出缺 description/tags/citations/links 的页面 |
| P2 成功 | release（或试跑）含可独立阅读的 bundle；所有 concept 有 parseable frontmatter + 非空 type；root index 可作 Agent 入口 |
| P3 成功 | 核心系统/活动页表引用可跳转到 table concept；ambiguous/unresolved 形成审核任务 |
| P4 成功 | 每个发布 concept ≥1 页面级 citation；Agent 输出归因可关联 okfPath + citation |
| 最终 | 内部强治理不变；bundle 成标准化发布物；外部 Agent 不懂 KH DB 也能读懂；内部 Agent 经 MCP 得到 path/citation/quality trace；策划仍用可视化立法页，不写 YAML |
```
