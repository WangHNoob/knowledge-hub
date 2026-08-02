import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`缺少环境变量 ${name}（请在 .env 或部署环境中配置；模板见 .env.example）。`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : fallback;
}

function positiveInt(name: string, fallback: number): number {
  const raw = optional(name, String(fallback));
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`环境变量 ${name} 必须是正整数（当前值：${raw}）。`);
  }
  return Math.floor(value);
}

function flag(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

export const config = {
  port: Number(optional("PORT", "4174")),
  host: optional("HOST", "0.0.0.0"),
  dataDir: optional("KH_DATA_DIR", "./data"),
  publicBaseUrl: optional("KH_PUBLIC_BASE_URL", ""),
  jwtSecret: required("KH_JWT_SECRET"),
  databaseUrl: required("DATABASE_URL"),
  logLevel: optional("KH_LOG_LEVEL", "info") as "debug" | "info" | "warn" | "error",
  logRetentionDays: Number(optional("KH_LOG_RETENTION_DAYS", "14")),
  webImportRetentionHours: Number(optional("KH_WEBIMPORT_RETENTION_HOURS", "24")),
  logToFile: optional("KH_LOG_TO_FILE", "true") !== "false",
  logToDb: optional("KH_LOG_TO_DB", "true") !== "false",
  uploadMaxFileBytes: positiveInt("KH_UPLOAD_MAX_FILE_BYTES", 2 * 1024 * 1024 * 1024),
  uploadMaxFiles: positiveInt("KH_UPLOAD_MAX_FILES", 20000),
  uploadMaxFields: positiveInt("KH_UPLOAD_MAX_FIELDS", 200),
  uploadMaxParts: positiveInt("KH_UPLOAD_MAX_PARTS", 20200),
  autoPublishRevisions: flag("KH_AUTO_PUBLISH_REVISIONS", true),
  autoBuildOnUpload: flag("KH_AUTO_BUILD_ON_UPLOAD", true),
  healthSweepIntervalHours: Number(optional("KH_HEALTH_SWEEP_INTERVAL_HOURS", "24")),
  generateBuildReviewTasks: flag("KH_GENERATE_BUILD_REVIEW_TASKS", false),
  autoRemediationEnabled: flag("KH_AUTO_REMEDIATION_ENABLED", true),
  autoAliasRemediationEnabled: flag("KH_AUTO_ALIAS_REMEDIATION_ENABLED", true),
  autoRemediationConfidenceThreshold: Number(optional("KH_AUTO_REMEDIATION_CONFIDENCE_THRESHOLD", "0.85")),
  autoRemediationLlmProvider: optional("KH_AUTO_REMEDIATION_LLM_PROVIDER", ""),
  autoRemediationLlmBaseUrl: optional("KH_AUTO_REMEDIATION_LLM_BASE_URL", ""),
  autoRemediationLlmModel: optional("KH_AUTO_REMEDIATION_LLM_MODEL", ""),
  autoRemediationLlmApiKey: optional("KH_AUTO_REMEDIATION_LLM_API_KEY", ""),
  /** When set, stdio MCP requires matching KH_MCP_SERVICE_TOKEN in the environment of the caller process. Empty = allow (dev). */
  mcpServiceToken: optional("KH_MCP_SERVICE_TOKEN", ""),
  /** When true, refuse mcp:stdio unless KH_MCP_SERVICE_TOKEN is configured. */
  mcpStdioRequireToken: flag("KH_MCP_STDIO_REQUIRE_TOKEN", false),
  /** Per-user MCP HTTP requests allowed per window. 0 disables. */
  mcpRateLimitMax: Number(optional("KH_MCP_RATE_LIMIT_MAX", "120")),
  /** MCP rate-limit window in milliseconds. */
  mcpRateLimitWindowMs: Number(optional("KH_MCP_RATE_LIMIT_WINDOW_MS", "60000")),
  /**
   * Event bus delivery: inline (default, process EventEmitter) or outbox
   * (persist to knowledge_event_outbox + worker with SKIP LOCKED for multi-instance).
   */
  eventBusMode: optional("KH_EVENT_BUS_MODE", "inline") === "outbox" ? "outbox" as const : "inline" as const,
  eventOutboxIntervalMs: Number(optional("KH_EVENT_OUTBOX_INTERVAL_MS", "1000")),
  retrievalEvalEnabled: flag("KH_RETRIEVAL_EVAL_ENABLED", false),
  retrievalEvalGoldPath: optional("KH_RETRIEVAL_EVAL_GOLD_PATH", "evals/retrieval-gold.json"),
  retrievalEvalMinHitAtK: Number(optional("KH_RETRIEVAL_EVAL_MIN_HIT_AT_K", "0.85")),
  retrievalEvalMinCitationCoverage: Number(optional("KH_RETRIEVAL_EVAL_MIN_CITATION", "0")),
  retrievalEvalBlockOnRegression: flag("KH_RETRIEVAL_EVAL_BLOCK_ON_REGRESSION", true),
};

export const testConfig = {
  databaseUrl: () => required("KH_TEST_DATABASE_URL")
};
