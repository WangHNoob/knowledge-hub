import "dotenv/config";

const url = process.env.KH_TEST_DATABASE_URL;
if (!url) {
  throw new Error(
    "缺少 KH_TEST_DATABASE_URL；请在 .env 或环境变量中提供测试库连接串（模板见 .env.example）。"
  );
}

export const TEST_DATABASE_URL: string = url;
