import { config } from "../config";
import { emitKnowledgeEvent, onKnowledgeEvent, type KnowledgeEvent } from "./eventService";
import { createLlmClient, LlmError, type LlmClient } from "./kbBuilder/llmClient";
import { extractMaxTokens, modelName, normalizeModelConfig, redactModelConfig, type PipelineModelConfig } from "./kbBuilder/modelConfig";
import {
  AUTO_REMEDIATION_JSON_SCHEMA,
  buildSystemPrompt,
  buildUserPrompt,
  parseRemediationOutput,
  type ParsedRemediation,
  type RemediationPromptContext
} from "./autoRemediationPrompts";
import type { DiagnosticLogger } from "./diagnosticService";
import type { KnowledgeService } from "./knowledgeService";
import type { DatabaseHandle, LlmAnalysis } from "../types";

export interface AutoRemediationDeps {
  db: DatabaseHandle;
  knowledgeService: KnowledgeService;
  diagnostics: DiagnosticLogger;
  llmClientFactory?: (config: PipelineModelConfig) => LlmClient | null;
}

/**
 * Register the LLM-driven auto-remediation listener.
 *
 * On every negative "agent.feedback.received" event, an LLM is asked to
 * diagnose and produce a corrected value. High-confidence fixes are auto-
 * applied via knowledgeService.annotateReviewTask (with autoFixed=true),
 * which emits the standard writeback_requested event and triggers the
 * existing scoped-rebuild → revision-draft → auto-publish pipeline.
 *
 * Low-confidence / ambiguous cases append LLM suggestions to the task's
 * candidate list and leave the task open for human review.
 */
export function registerAutoRemediation(deps: AutoRemediationDeps): () => void {
  return onKnowledgeEvent("agent.feedback.received", async (event) => {
    try {
      const modelConfig = await resolveModelConfig(deps.db);
      await handleFeedbackEvent(deps, modelConfig, event);
    } catch (error) {
      await deps.diagnostics.write({
        level: "error",
        category: "system",
        message: "autoRemediation top-level failure",
        error,
        context: { eventId: event.eventId, entityId: event.entityId }
      });
    }
  });
}

async function handleFeedbackEvent(
  deps: AutoRemediationDeps,
  modelConfig: PipelineModelConfig,
  event: KnowledgeEvent
): Promise<void> {
  if (!config.autoRemediationEnabled) return;

  const payload = event.payload as Record<string, unknown>;
  const feedbackType = String(payload.feedbackType ?? "");
  const taskId = String(payload.taskId ?? "");
  const componentId = String(payload.componentId ?? "");
  const projectId = String(payload.projectId ?? "default_project");

  if (!taskId || !componentId) return;
  if (feedbackType === "hit") return;
  if (modelConfig.provider === "deterministic") {
    await deps.diagnostics.write({
      level: "warn",
      category: "system",
      message: "autoRemediation skipped: no LLM model configured",
      context: { taskId, componentId, feedbackType }
    });
    return;
  }

  const span = deps.diagnostics.startSpan({
    category: "llm",
    message: "auto_remediation",
    entityType: "review_task",
    entityId: taskId,
    context: {
      componentId,
      projectId,
      feedbackType,
      model: redactModelConfig(modelConfig)
    }
  });

  try {
    const tasks = await deps.knowledgeService.listReviewTasks({ projectId });
    const task = tasks.find((t) => t.taskId === taskId);
    if (!task) {
      await span.complete({ skipped: "task_not_found" });
      return;
    }
    if (task.autoFixed || task.status !== "open") {
      await span.complete({ skipped: "task_already_processed", status: task.status });
      return;
    }

    const components = await deps.knowledgeService.listComponents({ projectId });
    const component = components.find((c) => c.componentId === componentId);
    if (!component) {
      await span.complete({ skipped: "component_not_found" });
      return;
    }

    const evidence = await deps.knowledgeService.listEvidenceRecords({ componentId });

    const client = (deps.llmClientFactory ?? createLlmClient)(modelConfig);
    if (!client) {
      await span.complete({ skipped: "no_llm_client" });
      return;
    }

    const promptCtx: RemediationPromptContext = {
      feedbackType,
      agentQuery: String(payload.query ?? ""),
      suggestedAction: String(payload.suggestedAction ?? ""),
      component: {
        componentId: component.componentId,
        kind: component.kind,
        group: component.group,
        title: component.title,
        legacyPath: component.legacyPath,
        quality: component.quality ?? {},
        body: componentBodyPreview(component)
      },
      evidence,
      task: {
        taskId: task.taskId,
        title: task.title,
        description: task.description,
        suggestedAction: task.suggestedAction,
        ruleId: task.ruleId,
        candidates: task.candidates
      }
    };

    const system = buildSystemPrompt(component.kind);
    const user = buildUserPrompt(promptCtx);
    const start = Date.now();
    let raw: string;
    try {
      const result = await client.complete({
        system,
        user,
        maxTokens: extractMaxTokens(),
        jsonSchema: AUTO_REMEDIATION_JSON_SCHEMA
      });
      raw = result.text;
    } catch (error) {
      const detail = error instanceof LlmError ? `${error.message} (status=${error.status ?? "n/a"})` : String(error);
      await span.fail(error, { stage: "llm_call", detail });
      return;
    }

    let parsed: ParsedRemediation;
    try {
      parsed = parseRemediationOutput(raw);
    } catch (error) {
      await span.fail(error, { stage: "parse", raw: raw.slice(0, 500) });
      return;
    }

    const analysis: LlmAnalysis = {
      diagnosis: parsed.diagnosis,
      confidence: parsed.confidence,
      rationale: parsed.rationale,
      fixType: parsed.fixType,
      modelProvider: modelConfig.provider,
      modelName: modelName(modelConfig),
      generatedAt: new Date().toISOString()
    };

    const validation = validateCorrectValue(component.kind, parsed.correctValue);
    const shouldAutoFix =
      parsed.fixType === "annotation_override" &&
      parsed.confidence >= config.autoRemediationConfidenceThreshold &&
      validation.valid;

    if (shouldAutoFix) {
      await deps.knowledgeService.annotateReviewTask({
        taskId,
        correctValue: parsed.correctValue,
        applyMode: "override",
        note: `auto-remediation: ${parsed.rationale}`,
        actor: "system:auto-remediation",
        autoFixed: true,
        llmAnalysis: analysis
      });
      await emitKnowledgeEvent(deps.db, {
        eventType: "annotation.created",
        entityType: "review_task",
        entityId: taskId,
        payload: {
          source: "auto_remediation",
          projectId,
          componentId,
          confidence: parsed.confidence,
          fixType: parsed.fixType,
          latencyMs: Date.now() - start
        }
      });
      await span.complete({
        action: "auto_fixed",
        confidence: parsed.confidence,
        fixType: parsed.fixType,
        latencyMs: Date.now() - start
      });
      return;
    }

    const suggestions = validation.valid || Object.keys(parsed.correctValue).length === 0
      ? parsed.suggestions
      : [
          {
            label: `LLM 建议未自动执行：${validation.reason}`,
            value: parsed.correctValue,
            rationale: parsed.rationale
          },
          ...parsed.suggestions
        ];

    if (suggestions.length > 0) {
      await deps.knowledgeService.addLlmSuggestions(taskId, suggestions.map((s) => ({
        label: s.label,
        value: s.value,
        rationale: s.rationale
      })));
    }
    await span.complete({
      action: "human_needed",
      confidence: parsed.confidence,
      fixType: parsed.fixType,
      suggestionCount: suggestions.length,
      validationReason: validation.reason,
      diagnosis: parsed.diagnosis.slice(0, 200)
    });
  } catch (error) {
    await span.fail(error, { stage: "unknown" });
  }
}

function validateCorrectValue(componentKind: string, value: Record<string, unknown>): { valid: boolean; reason: string } {
  if (Object.keys(value).length === 0) return { valid: false, reason: "correctValue 为空" };
  if (componentKind === "wiki_page" || componentKind === "table_wiki_page" || componentKind === "topic_index") {
    const markdown = typeof value.markdown === "string" ? value.markdown.trim() : "";
    const replaceBody = typeof value.replaceBody === "string" ? value.replaceBody.trim() : "";
    if (markdown.length >= 20 || replaceBody.length >= 20) return { valid: true, reason: "" };
    return { valid: false, reason: "wiki 修复缺少可用正文 markdown/replaceBody" };
  }
  if (componentKind === "table") {
    if (Array.isArray(value.rows) || Array.isArray(value.columns)) return { valid: true, reason: "" };
    return { valid: false, reason: "表格修复缺少 rows 或 columns" };
  }
  if (componentKind === "entity") {
    if (typeof value.name === "string" && value.name.trim()) return { valid: true, reason: "" };
    return { valid: false, reason: "实体修复缺少 name" };
  }
  if (componentKind === "graph_snapshot") {
    if (Array.isArray(value.nodes) && Array.isArray(value.edges)) return { valid: true, reason: "" };
    return { valid: false, reason: "图谱修复缺少 nodes/edges" };
  }
  return { valid: true, reason: "" };
}

/**
 * Pick the LLM config auto-remediation should use. Priority:
 *   1. Explicit KH_AUTO_REMEDIATION_LLM_* env vars.
 *   2. The most recent knowledge_build_runs.config_json.modelConfig
 *      (provider/baseUrl/model), with the API key sourced from env.
 *   3. OPENAI_API_KEY env fallback (openai-compatible).
 *   4. Deterministic (no-op).
 */
async function resolveModelConfig(db: DatabaseHandle): Promise<PipelineModelConfig> {
  const provider = config.autoRemediationLlmProvider;
  if (provider === "anthropic" || provider === "openai-compatible") {
    return normalizeModelConfig(
      {
        provider,
        baseUrl: config.autoRemediationLlmBaseUrl,
        model: config.autoRemediationLlmModel,
        apiKey: config.autoRemediationLlmApiKey || undefined
      },
      config.autoRemediationLlmModel || "deterministic"
    );
  }

  const lastRunConfig = await loadLastBuildRunModelConfig(db);
  if (lastRunConfig) {
    const withKey = attachApiKeyFromEnv(lastRunConfig);
    if (withKey) return withKey;
  }

  const envKey = process.env.OPENAI_API_KEY;
  if (envKey) {
    return {
      provider: "openai-compatible",
      baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
      apiKey: envKey
    };
  }
  return { provider: "deterministic", model: "deterministic" };
}

async function loadLastBuildRunModelConfig(db: DatabaseHandle): Promise<Omit<Exclude<PipelineModelConfig, { provider: "deterministic" }>, "apiKey"> | null> {
  try {
    const { rows } = await db.adapter.query(
      `SELECT config_json
         FROM knowledge_build_runs
        WHERE status = 'completed'
          AND config_json ? 'modelConfig'
        ORDER BY started_at DESC
        LIMIT 1`
    );
    if (rows.length === 0) return null;
    const cfgRaw = rows[0].config_json;
    const cfg = typeof cfgRaw === "string" ? JSON.parse(cfgRaw) : cfgRaw;
    const mc = cfg?.modelConfig;
    if (!mc || typeof mc !== "object") return null;
    const providerVal = String((mc as Record<string, unknown>).provider ?? "");
    if (providerVal === "anthropic" || providerVal === "openai-compatible") {
      return {
        provider: providerVal,
        baseUrl: String((mc as Record<string, unknown>).baseUrl ?? ""),
        model: String((mc as Record<string, unknown>).model ?? "")
      };
    }
    return null;
  } catch {
    return null;
  }
}

function attachApiKeyFromEnv(
  cfg: Omit<Exclude<PipelineModelConfig, { provider: "deterministic" }>, "apiKey">
): PipelineModelConfig | null {
  if (cfg.provider === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY || config.autoRemediationLlmApiKey;
    if (!apiKey) return null;
    return {
      provider: "anthropic",
      baseUrl: cfg.baseUrl || "https://api.anthropic.com/v1",
      model: cfg.model || "claude-sonnet-4-5",
      apiKey
    };
  }
  const apiKey = process.env.OPENAI_API_KEY || config.autoRemediationLlmApiKey;
  if (!apiKey) return null;
  return {
    provider: "openai-compatible",
    baseUrl: cfg.baseUrl || "https://api.openai.com/v1",
    model: cfg.model || "gpt-4.1-mini",
    apiKey
  };
}

function componentBodyPreview(component: {
  legacyPath: string;
  quality: Record<string, unknown>;
  title: string;
  kind: string;
}): string {
  const parts: string[] = [];
  parts.push(`Title: ${component.title}`);
  parts.push(`Kind: ${component.kind}`);
  parts.push(`Path: ${component.legacyPath}`);
  const quality = component.quality ?? {};
  const body = pickString(quality, ["preview", "body", "markdown", "summary", "content"]);
  if (body) parts.push(`Body preview: ${body}`);
  const facts = quality.facts;
  if (facts && typeof facts === "object") {
    parts.push(`Facts: ${JSON.stringify(facts).slice(0, 1500)}`);
  }
  return parts.join("\n");
}

function pickString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return "";
}
