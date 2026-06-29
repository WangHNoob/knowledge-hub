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
  autoPublishRevisions: flag("KH_AUTO_PUBLISH_REVISIONS", false)
};

export const testConfig = {
  databaseUrl: () => required("KH_TEST_DATABASE_URL")
};
