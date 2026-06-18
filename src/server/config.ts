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
  logToDb: optional("KH_LOG_TO_DB", "true") !== "false"
};

export const testConfig = {
  databaseUrl: () => required("KH_TEST_DATABASE_URL")
};
