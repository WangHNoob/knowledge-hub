import "dotenv/config";

const url = process.env.KH_TEST_DATABASE_URL;
if (!url) {
  throw new Error(
    "缺少 KH_TEST_DATABASE_URL；请在 .env 或环境变量中提供测试库连接串（模板见 .env.example）。"
  );
}

// 测试固定 hashing_trick：发布测试不触发 fastembed 模型下载（确定性、离线友好）。
// 允许显式覆盖（如本机已缓存模型且想测 v2 路径时可设 OKF_DENSE_METHOD=fastembed）。
if (!process.env.OKF_DENSE_METHOD) {
  process.env.OKF_DENSE_METHOD = "hashing_trick";
}

export const TEST_DATABASE_URL: string = url;
