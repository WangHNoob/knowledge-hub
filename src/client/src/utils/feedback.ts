import type { AgentEvent, ReviewTask } from "../api";

export interface FeedbackInsight {
  toolName: string;
  queryText: string;
  problem: "miss" | "evidence" | "quality" | "repeated" | "other";
  headline: string;
  impact: string;
  nextStep: string;
  componentIds: string[];
  qualityFlags: string[];
}

export function insightFromTask(task: ReviewTask): FeedbackInsight {
  const parsed = parseDescription(task.description);
  const query = parseQueryKey(task.title) ?? parseQueryKey(parsed.queryKey) ?? parseQueryKey(`${parsed.toolName}:${parsed.payloadQuery}`);
  const qualityFlags = parsed.qualityFlags;
  const problem = problemFromText(task.title, task.description, qualityFlags);
  const componentIds = unique([
    task.componentId,
    ...componentIdsFromFlags(qualityFlags),
  ].filter(Boolean));
  return buildInsight({
    toolName: query.toolName || parsed.toolName,
    queryText: query.queryText || parsed.payloadQuery,
    problem,
    componentIds,
    qualityFlags,
  });
}

export function insightFromEvent(event: AgentEvent): FeedbackInsight {
  const query = parseQueryKey(event.query);
  return buildInsight({
    toolName: query.toolName,
    queryText: query.queryText,
    problem: problemFromText(event.feedbackType, event.suggestedAction, event.qualityFlags),
    componentIds: unique([...event.hitComponentIds, ...componentIdsFromFlags(event.qualityFlags)]),
    qualityFlags: event.qualityFlags,
  });
}

function buildInsight(input: {
  toolName: string;
  queryText: string;
  problem: FeedbackInsight["problem"];
  componentIds: string[];
  qualityFlags: string[];
}): FeedbackInsight {
  const toolName = input.toolName || "MCP";
  const queryText = input.queryText || "未解析查询";
  if (input.problem === "miss") {
    return {
      ...input,
      toolName,
      queryText,
      headline: `${toolName} 没有找到「${queryText}」`,
      impact: "Agent 会拿不到当前发布里的答案，重复出现时应进入错误本。",
      nextStep: "补 topic/index/wiki 或调整别名后重新发布，再用同一个查询复测。",
    };
  }
  if (input.problem === "evidence") {
    return {
      ...input,
      toolName,
      queryText,
      headline: `${toolName} 找到了「${queryText}」，但缺少可追溯证据`,
      impact: input.componentIds.length
        ? `影响 ${input.componentIds.length} 个命中组件，Agent 能答但引用链不完整。`
        : "Agent 能答但引用链不完整。",
      nextStep: "打开命中组件查看 source refs / evidence；补证据或重新构建后再复测。",
    };
  }
  if (input.problem === "quality") {
    return {
      ...input,
      toolName,
      queryText,
      headline: `${toolName} 命中了「${queryText}」，但资产质量偏低`,
      impact: "当前回答可能来自低置信 wiki，适合先人工复核再放大使用。",
      nextStep: "补齐 wiki 结构、事实字段或来源引用，重新构建后观察 quality flags。",
    };
  }
  if (input.problem === "repeated") {
    return {
      ...input,
      toolName,
      queryText,
      headline: `${toolName} 多次处理不了「${queryText}」`,
      impact: "这已经不是偶发 miss，应该作为错误本候选优先处理。",
      nextStep: "补资产入口、索引词和图谱关系，然后用 MCP 控制台复测。",
    };
  }
  return {
    ...input,
    toolName,
    queryText,
    headline: `${toolName} 反馈：${queryText}`,
    impact: input.qualityFlags.length ? `质量标记：${input.qualityFlags.join(", ")}` : "需要人工判断是否影响消费。",
    nextStep: "查看命中组件和审核建议，处理后重新模拟查询。",
  };
}

function parseDescription(description: string): { toolName: string; payloadQuery: string; queryKey: string; qualityFlags: string[] } {
  const toolName = /Knowledge MCP\s+([^\s]+)\s+feedback:/u.exec(description)?.[1] ?? "";
  const payloadText = /feedback:\s+(\{.*?\})\.\s+Quality flags:/u.exec(description)?.[1] ?? "";
  const flagsText = /Quality flags:\s*(.+?)\.?$/u.exec(description)?.[1] ?? "";
  let payloadQuery = "";
  try {
    const payload = payloadText ? JSON.parse(payloadText) as Record<string, unknown> : {};
    payloadQuery = String(payload.query ?? payload.q ?? payload.topic ?? payload.page ?? payload.table ?? "");
  } catch {
    payloadQuery = "";
  }
  return {
    toolName,
    payloadQuery,
    queryKey: toolName && payloadQuery ? `${toolName}:${payloadQuery}` : "",
    qualityFlags: flagsText && flagsText !== "none" ? flagsText.split(",").map((flag) => flag.trim()).filter(Boolean) : [],
  };
}

function parseQueryKey(value: string): { toolName: string; queryText: string } {
  const match = /(kb_[a-z_]+):\s*(.+)$/iu.exec(value);
  if (!match) return { toolName: "", queryText: "" };
  return { toolName: match[1], queryText: match[2].trim() };
}

function problemFromText(title: string, description: string, qualityFlags: string[]): FeedbackInsight["problem"] {
  const text = `${title} ${description}`.toLowerCase();
  if (text.includes("重复") || text.includes("repeated")) return "repeated";
  if (text.includes("无命中") || text.includes("miss")) return "miss";
  if (text.includes("低质量") || qualityFlags.some((flag) => flag.startsWith("low_quality:"))) return "quality";
  if (text.includes("证据不足") || qualityFlags.some((flag) => flag.startsWith("evidence_missing:"))) return "evidence";
  return "other";
}

function componentIdsFromFlags(flags: string[]): string[] {
  return flags
    .map((flag) => /^evidence_missing:(.+)$/u.exec(flag)?.[1] ?? /^low_quality:(.+)$/u.exec(flag)?.[1] ?? "")
    .filter(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
