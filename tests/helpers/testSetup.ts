import "dotenv/config";

// 测试隔离：即使本地 .env 配了真实 LLM key（供开发/构建用），测试也一律不得发起真实网络调用。
// 统一在此清除 LLM 相关环境变量，让模型解析回落到 deterministic；需要 LLM 的用例自行注入
// llmClientFactory 或在用例内显式设置这些变量（用例内设置发生在本文件之后，不受影响）。
const LLM_ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "ANTHROPIC_API_KEY",
  "KH_AUTO_REMEDIATION_LLM_PROVIDER",
  "KH_AUTO_REMEDIATION_LLM_BASE_URL",
  "KH_AUTO_REMEDIATION_LLM_MODEL",
  "KH_AUTO_REMEDIATION_LLM_API_KEY",
  "KH_KNOWLEDGE_LINT_LLM_PROVIDER",
  "KH_KNOWLEDGE_LINT_LLM_BASE_URL",
  "KH_KNOWLEDGE_LINT_LLM_MODEL",
  "KH_KNOWLEDGE_LINT_LLM_API_KEY",
];

for (const key of LLM_ENV_KEYS) delete process.env[key];
