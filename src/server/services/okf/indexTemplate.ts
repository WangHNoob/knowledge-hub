// src/server/services/okf/indexTemplate.ts
// 发布物目录（index.md）生成器：把 bundle 渲染成 LLM 可一次读懂的导航目录
// （llms.txt 风格：H1 + blockquote 摘要 + H2 分组文件清单 + Optional 分级）。
// 注意：此处生成的 index.md 是「文档目录」，与 kbBuilder/graphStage 生成的
// 实体导航索引（构建工作区 wiki/index.md，kind=topic_index，不导出）定位不同。

export interface IndexPageMeta {
  /** bundle 内路径，如 concepts/01-战斗框架与伤害公式.md */
  okfPath: string;
  /** 展示标题（正文 H1，如 01 战斗框架与伤害公式） */
  title: string;
  /** 一句话范围描述（正文首段/首个说明行，截断 ~60 字） */
  description: string;
  /** 正文中引用的配表名（去重，最多 6 个） */
  csvRefs: string[];
}

export interface IndexGroup {
  name: string;
  docNumbers: number[];
  /** Optional 组（llms.txt 语义：短上下文可跳过） */
  optional?: boolean;
}

/** 按文档编号的策划分组；未匹配编号（如 tables/ungrouped.md）落入「其他」。 */
export const INDEX_GROUPS: IndexGroup[] = [
  { name: "必读（Start Here）", docNumbers: [0] },
  { name: "战斗与数值核心", docNumbers: [1, 2, 3, 4, 17, 43, 44, 45] },
  { name: "角色与养成", docNumbers: [5, 6, 13, 14, 15, 16, 46] },
  { name: "副本与玩法", docNumbers: [7, 18, 19, 20, 21, 22, 23, 28, 29, 30, 31, 32, 37, 40, 41, 42] },
  { name: "经济与商业化", docNumbers: [8, 9, 24, 25, 26, 27, 33, 34, 35, 47] },
  { name: "系统与规范", docNumbers: [10, 36, 38, 39, 48] },
  { name: "Optional（可跳过）", docNumbers: [11, 12], optional: true },
];

export const OTHER_GROUP_NAME = "其他";

const GROUP_BY_NUMBER = new Map<number, IndexGroup>();
for (const group of INDEX_GROUPS) {
  for (const number of group.docNumbers) GROUP_BY_NUMBER.set(number, group);
}

/** 按文档编号（NN_ 前缀）或路径找分组；未匹配返回「其他」。 */
export function groupForDoc(okfPath: string, title: string): IndexGroup {
  const match = /(?:^|\/)(\d{1,2})[_-]/u.exec(okfPath) ?? /^(\d{1,2})\s/u.exec(title);
  if (match) {
    const group = GROUP_BY_NUMBER.get(Number(match[1]));
    if (group) return group;
  }
  return { name: OTHER_GROUP_NAME, docNumbers: [] };
}

/** 提取正文 H1（去掉 # 与首尾空白），无则返回空串。 */
export function extractIndexTitle(body: string): string {
  for (const line of body.split(/\r?\n/u)) {
    const match = /^#\s+(.+?)\s*$/u.exec(line.trim());
    if (match) return match[1].trim();
  }
  return "";
}

const DESCRIPTION_MAX_LEN = 60;

/**
 * 提取一句话范围描述：H1 之后第一个非标题/非表格/非空行，
 * 剥 `>`（blockquote）与 `**` 加粗；跳过「引用」行与「状态/维护」等元数据行。
 */
export function extractIndexDescription(body: string): string {
  for (const line of body.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#") || trimmed.startsWith("|") || trimmed.startsWith("```")) continue;
    if (/^[-*_]{3,}$/u.test(trimmed)) continue;
    const text = trimmed.replace(/^>\s*/u, "").trim();
    if (!text) continue;
    // 导航/元数据行：引用指向、状态/维护人/更新信息
    if (/^[*_]*引用[*_]*[:：]/u.test(text)) continue;
    if (/^状态[:：]/u.test(text) || /^维护人/u.test(text) || /^最后更新/u.test(text)) continue;
    if (text.includes("｜")) continue; // 元数据行（状态 ｜ 维护人 ｜ 更新）
    const cleaned = text.replace(/\*\*/gu, "").replace(/\*/gu, "");
    if (!cleaned) continue;
    return cleaned.length > DESCRIPTION_MAX_LEN ? `${cleaned.slice(0, DESCRIPTION_MAX_LEN)}…` : cleaned;
  }
  return "";
}

/** 提取正文引用的配表名（Xxx.csv），保持出现顺序去重，最多 max 个。 */
export function extractCsvRefs(body: string, max = 6): string[] {
  const refs: string[] = [];
  const pattern = /\b([A-Za-z][A-Za-z0-9_]*\.csv)\b/gu;
  for (const match of body.matchAll(pattern)) {
    const name = match[1];
    if (!refs.includes(name)) refs.push(name);
    if (refs.length >= max) break;
  }
  return refs;
}

/** 按问题找文档的引导（策划分组 + 常用查询映射到文档编号）。 */
const FIND_GUIDE_LINES = [
  "伤害公式 / 元素克制 / 破韧 → 01、17",
  "属性 / 战力公式 / 词条权重 → 02、44",
  "技能倍率 / 技能突破 / Buff → 03、04、13",
  "角色 / 命座 / 天赋 / 皮肤 → 05、14、15、16",
  "武器 / 装备 / 锻造 / 洗练 / 回收 → 06、33",
  "副本 / 关卡 / 词缀 / 试炼 → 07、20",
  "掉落 / 保底 / 随机数 → 08、45",
  "商店 / 抽卡 / 付费 / 礼包 → 09、24、25、27",
  "体力 / 经济循环 / 反刷 → 34、35",
  "竞技场 / 排位 / PVP 平衡 → 28、29、43",
  "公会 / 组队 / 远征 / 活动 / 世界Boss → 30、31、32、37、40、41、42",
  "任务 / 成就 / 图鉴 / 邮件 → 22、23、38、39",
  "物品 / 道具体系 → 47",
  "配表规范 / 外键 / 校验 → 10、11",
  "ID 注册表 / 术语 / 枚举 → 00",
];

/** 机器可读资产（JSON）的固定描述；不在表内的资产不逐条列出。 */
const ASSET_DESCRIPTIONS: Record<string, string> = {
  "graph/graph.json": "实体关系图（概念/表/字段节点与 has_field、fk_to 边）",
  "tables/schemas.json": "全部配置表 schema（表名 / 字段 / 行数）",
  "tables/aliases.json": "表名别名表",
  "search/index.json": "词法检索索引（工具内部使用）",
  "search/dense.json": "稠密向量索引（工具内部使用）",
  "meta/revision.json": "本次发布相对父版本的修订差异",
};

function entryLine(page: IndexPageMeta): string {
  if (page.csvRefs.length === 0) return `- [${page.title}](/${page.okfPath}): ${page.description}`;
  const description = page.description.replace(/[。！？]\s*$/u, "");
  return `- [${page.title}](/${page.okfPath}): ${description}；关联 ${page.csvRefs.join(", ")}`;
}

/**
 * 渲染目录 index.md。
 * - 带 `okf_version` frontmatter（旧 OKF spec §5：root index 唯一带 frontmatter 的文件）；
 * - 文档按 INDEX_GROUPS 分组列出，每条含一句话描述与关联配表；
 * - 链接用 bundle 绝对路径（/concepts/...），可直接作为 kb_get_page 的入参；
 * - meta/extract/* 等噪音资产不逐条列出，只给一句指引。
 */
export function renderDirectoryIndex(input: {
  releaseVersion: string;
  pages: IndexPageMeta[];
  assetUris: string[];
}): string {
  const byGroup = new Map<string, IndexPageMeta[]>();
  for (const page of input.pages) {
    const groupName = groupForDoc(page.okfPath, page.title).name;
    byGroup.set(groupName, [...(byGroup.get(groupName) ?? []), page]);
  }

  const lines: string[] = [
    "---",
    'okf_version: "0.1"',
    "---",
    "",
    "# StarTrail 知识库目录",
    "",
    `> 知识库导航入口：${input.pages.length} 个页面（策划文档 + 配表注册页）按模块分组，每条附一句话范围与关联配表。`
      + " 先读《00 项目总览与术语表》（ID 注册表 / 术语 / 枚举的唯一权威），"
      + " 再按需打开对应文档或用 kb_query_table 查询配表。",
    "",
  ];

  const orderedGroups = [...INDEX_GROUPS.map((group) => group.name), OTHER_GROUP_NAME];
  for (const groupName of orderedGroups) {
    const pages = byGroup.get(groupName);
    if (!pages || pages.length === 0) continue;
    lines.push(`## ${groupName}`, "");
    for (const page of [...pages].sort((a, b) => a.okfPath.localeCompare(b.okfPath))) {
      lines.push(entryLine(page));
    }
    lines.push("");
  }

  lines.push("## 查找指引（按问题找文档）", "");
  lines.push(...FIND_GUIDE_LINES.map((line) => `- ${line}`));
  lines.push("");

  const assetLines = input.assetUris
    .filter((uri) => uri in ASSET_DESCRIPTIONS)
    .sort()
    .map((uri) => `- [${uri}](/${uri}): ${ASSET_DESCRIPTIONS[uri]}`);
  if (assetLines.length > 0) {
    lines.push("## 机器可读资产（工具内部使用）", "");
    lines.push(...assetLines);
    lines.push("");
  }

  lines.push("> 其余 `meta/extract/**` 为每页抽取快照，供工具内部使用，无需阅读。", "");

  return `${lines.join("\n")}`;
}
