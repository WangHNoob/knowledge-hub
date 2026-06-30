// 把内部组件 ID（如 cmp_pkg_xxx_wiki_systems_battle_md_a1b2c3d4）翻成人能读的
// 名称（wiki/systems/battle.md），用于明细列表、反馈卡片等只有 ID、没有 title 的场景。
// 解析失败时退回原 ID，绝不丢信息（完整 ID 仍可放进 tooltip）。
export function componentLabel(componentId: string, title?: string): string {
  if (title && title.trim() && title !== componentId) return title;
  const wikiMatch = componentId.match(/_wiki_(.+?)_md(?:_[a-f0-9]+)?$/iu);
  if (wikiMatch?.[1]) return `wiki/${wikiMatch[1].replace(/_/gu, "/")}.md`;
  const tableMatch = componentId.match(/_tables?_(.+?)(?:_[a-f0-9]+)?$/iu);
  if (tableMatch?.[1]) return `table/${tableMatch[1].replace(/_/gu, "/")}`;
  const graphMatch = componentId.match(/_graph_(.+?)(?:_[a-f0-9]+)?$/iu);
  if (graphMatch?.[1]) return `graph/${graphMatch[1].replace(/_/gu, "/")}`;
  const indexMatch = componentId.match(/_index_(.+?)(?:_[a-f0-9]+)?$/iu);
  if (indexMatch?.[1]) return `index/${indexMatch[1].replace(/_/gu, "/")}`;
  return componentId;
}
