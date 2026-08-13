import type { AssetComponent, AssetPackage, DatabaseHandle, ReleaseRecord } from "../../types";
import { trustFromQuality } from "../trustScore";
import type { OkfBundleReader } from "./OkfBundleReader";
import type { GraphEdge, GraphNode, KnowledgeAssetRef, ToolResult } from "./types";
import { same } from "./utils";

/**
 * 图谱域 MCP 工具（kb_get_entity / kb_get_neighbors / kb_list_entities /
 * kb_get_relations 及内部 graph 读取）。从 KnowledgeQueryService 拆出
 * （纯移动，行为不变），通过 ctx 委托主服务的组件读取能力。
 */
export interface GraphToolsContext {
  adapter: DatabaseHandle["adapter"];
  okfReader: OkfBundleReader;
  shared: {
    releaseComponents: (release: ReleaseRecord, kinds?: string[]) => Promise<AssetComponent[]>;
    readComponentText: (component: AssetComponent) => Promise<string>;
    releasePackages: (release: ReleaseRecord) => Promise<AssetPackage[]>;
  };
}

export class KbGraphTools {
  constructor(private readonly ctx: GraphToolsContext) {}

  private get adapter() {
    return this.ctx.adapter;
  }

  private get okfReader() {
    return this.ctx.okfReader;
  }

  findGraphNodeSafe(release: ReleaseRecord, entityId: string): { componentId: string; node: GraphNode } | null {
    try {
      const graph = this.okfReader.readOkfGraph(release);
      if (!graph) return null;
      const node = (graph.nodes ?? []).find((item) => same(item.id, entityId) || same(item.label, entityId));
      return node ? { componentId: graph.componentId, node } : null;
    } catch {
      return null;
    }
  }

  async kbGetEntity(release: ReleaseRecord, entityId: string): Promise<ToolResult> {
    const graph = await this.readGraph(release);
    const node = graph.nodes.find((item) => same(item.id, entityId) || same(item.label, entityId));
    return {
      result: node ? { found: true, node, trust: graph.component.trust ?? null } : { found: false, entityId },
      componentIds: node ? [graph.component.componentId] : [],
      artifactIds: node ? [graph.component.artifactId] : [],
    };
  }

  async kbGetNeighbors(release: ReleaseRecord, entityId: string): Promise<ToolResult> {
    const graph = await this.readGraph(release);
    const node = graph.nodes.find((item) => same(item.id, entityId) || same(item.label, entityId));
    if (!node) return { result: { found: false, entityId, nodes: [], edges: [] }, componentIds: [] };
    const edges = graph.edges.filter((edge) => edge.source === node.id || edge.target === node.id);
    const ids = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
    const nodes = graph.nodes.filter((item) => ids.has(item.id));
    return { result: { found: true, node, nodes, edges, trust: graph.component.trust ?? null }, componentIds: [graph.component.componentId], artifactIds: [graph.component.artifactId] };
  }

  async kbListEntities(release: ReleaseRecord, type?: string): Promise<ToolResult> {
    const graph = await this.readGraph(release);
    const nodes = type ? graph.nodes.filter((node) => same(node.type, type)) : graph.nodes;
    return { result: { nodes, trust: graph.component.trust ?? null }, componentIds: [graph.component.componentId], artifactIds: [graph.component.artifactId] };
  }

  async kbGetRelations(release: ReleaseRecord, source?: string, target?: string, relation?: string): Promise<ToolResult> {
    const graph = await this.readGraph(release);
    const edges = graph.edges.filter((edge) =>
      (!source || same(edge.source, source)) &&
      (!target || same(edge.target, target)) &&
      (!relation || same(edge.relation, relation))
    );
    return { result: { edges, trust: edges.length ? graph.component.trust ?? null : null }, componentIds: edges.length ? [graph.component.componentId] : [], artifactIds: edges.length ? [graph.component.artifactId] : [] };
  }

  /** 读取当前 release 的图谱（OKF 优先，回退构建产物），供工具与主服务共享。 */
  async readGraph(release: ReleaseRecord): Promise<{ component: KnowledgeAssetRef; nodes: GraphNode[]; edges: GraphEdge[] }> {
    const okfGraph = this.okfReader.readOkfGraph(release);
    if (okfGraph) {
      return {
        component: { componentId: okfGraph.componentId, artifactId: okfGraph.artifactId, trust: okfGraph.trust ?? null },
        nodes: okfGraph.nodes ?? [],
        edges: okfGraph.edges ?? [],
      };
    }
    const component = (await this.ctx.shared.releaseComponents(release, ["graph_snapshot"]))[0];
    if (!component) throw new Error("Current release does not contain a graph_snapshot component.");
    const graph = JSON.parse(await this.ctx.shared.readComponentText(component)) as { nodes?: GraphNode[]; edges?: GraphEdge[] };
    return { component: { ...component, trust: trustFromQuality(component.quality) }, nodes: graph.nodes ?? [], edges: graph.edges ?? [] };
  }
}
