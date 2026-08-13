/**
 * document_rewrite 校验（flywheel 02-P4，K5）：
 * 从「长度 ≥ 20」升级为三道闸——结构、事实核对、引用封闭集合。
 * 全部通过才允许自动落稿；任一项不过 → 人工兜底（完整 diff 预览任务）。
 *
 * - 结构：标题层级（≥1 个 ##/###）、表格行管道数一致、正文非空；
 * - 事实：正文（排除表格行）中出现的数值/百分比必须能在证据引文或源文
 *   中找到（封闭集合，复用 kb_check_table_value 的"只认已知事实"思路）；
 * - 引用：`[evidence:ID]` / `[ID]` 标记必须落在已知 evidenceId 集合内，
 *   禁止幻觉引用。
 */

export interface DocumentRewriteEvidence {
  evidenceId: string;
  quote: string;
}

export interface DocumentRewriteValidationContext {
  evidence: DocumentRewriteEvidence[];
  /** 源文/原文快照（组件正文预览），数值封闭集合的一部分。 */
  sourceText?: string;
}

export interface DocumentRewriteValidationResult {
  valid: boolean;
  structureOk: boolean;
  factsOk: boolean;
  citationsOk: boolean;
  reason: string;
}

const MIN_MARKDOWN_LENGTH = 20;

/** 提取 markdown 中的显式证据标记 id（[evidence:ID] 或 [ID]）。 */
export function extractCitationIds(markdown: string): string[] {
  const ids: string[] = [];
  const explicit = /\[evidence:([a-zA-Z0-9_\-:.]+)\]/gu;
  for (const match of markdown.matchAll(explicit)) ids.push(match[1]!);
  // 裸 [ID] 形式：仅当形似内部 id（含 _ / 前缀如 ev_ / cmp_ / rel_）时提取
  const bare = /\[([a-z][a-z0-9]*(?:_[a-zA-Z0-9]+)+)\]/gu;
  for (const match of markdown.matchAll(bare)) ids.push(match[1]!);
  return [...new Set(ids)];
}

/** 提取正文（排除表格行）中的数值声明（≥2 位整数、小数、百分比）。 */
export function extractProseNumbers(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/u).filter((line) => !line.includes("|"));
  const text = lines.join("\n").replace(/```[\s\S]*?```/gu, " ");
  const numbers: string[] = [];
  const pattern = /(?<![\w.])(\d{2,}(?:\.\d+)?%?|\d+\.\d+%?)(?![\w.])/gu;
  for (const match of text.matchAll(pattern)) numbers.push(match[1]!);
  return [...new Set(numbers)];
}

/** 表格结构：连续表格行（含 | 的行）每行管道数一致。 */
export function tableStructureOk(markdown: string): boolean {
  const lines = markdown.split(/\r?\n/u);
  let currentPipeCount = -1;
  for (const line of lines) {
    if (!line.includes("|")) {
      currentPipeCount = -1;
      continue;
    }
    const pipes = line.split("|").length - 1;
    if (currentPipeCount === -1) {
      currentPipeCount = pipes;
      continue;
    }
    if (pipes !== currentPipeCount) return false;
  }
  return true;
}

export function validateDocumentRewrite(
  markdown: string,
  ctx: DocumentRewriteValidationContext,
): DocumentRewriteValidationResult {
  const text = (markdown ?? "").trim();
  const structureOk = text.length >= MIN_MARKDOWN_LENGTH
    && /^#{2,3}\s+/mu.test(text)
    && tableStructureOk(text);
  if (!structureOk) {
    return {
      valid: false,
      structureOk,
      factsOk: false,
      citationsOk: false,
      reason: "结构校验失败：正文需 ≥ 20 字、含 ## 标题层级、表格行管道数一致",
    };
  }

  const knownIds = new Set(ctx.evidence.map((row) => row.evidenceId).filter(Boolean));
  const cited = extractCitationIds(text);
  const unknownCitations = cited.filter((id) => !knownIds.has(id));
  const citationsOk = unknownCitations.length === 0;
  if (!citationsOk) {
    return {
      valid: false,
      structureOk,
      factsOk: false,
      citationsOk,
      reason: `引用校验失败：存在封闭集合外的引用 [${unknownCitations.join(", ")}]（禁止幻觉引用）`,
    };
  }

  const knownText = [...ctx.evidence.map((row) => row.quote), ctx.sourceText ?? ""].join("\n");
  const unknownNumbers = extractProseNumbers(text).filter((number) => !knownText.includes(number));
  const factsOk = unknownNumbers.length === 0;
  if (!factsOk) {
    return {
      valid: false,
      structureOk,
      factsOk,
      citationsOk,
      reason: `事实核对失败：正文出现无法在证据/源文中核实的数值或比例 [${unknownNumbers.slice(0, 5).join(", ")}]`,
    };
  }

  return { valid: true, structureOk, factsOk, citationsOk, reason: "" };
}
