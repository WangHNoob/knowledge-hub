-- 单元/功能测试始终连真实 PostgreSQL，并按 schema 隔离，但测试库本身需预先存在。
-- 该脚本仅在数据卷首次初始化（为空）时由 postgres 容器自动执行一次。
SELECT 'CREATE DATABASE knowledge_hub_test'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'knowledge_hub_test')\gexec
