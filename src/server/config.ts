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
  databaseUrl: optional("DATABASE_URL", "")  // 桌面模式可选，服务端模式必须
};

export const testConfig = {
  databaseUrl: () => required("KH_TEST_DATABASE_URL")
};
