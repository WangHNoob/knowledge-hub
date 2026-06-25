#!/usr/bin/env bash
# 首次初始化数据库时，自动把随包携带的全库种子 dump 恢复进 knowledge_hub。
# 仅在数据卷为空（首次 docker compose up）时由 postgres 容器执行一次。
# dump 通过 docker-compose 把 ./seed/db 挂载到 /seed 提供；未挂载时（如本地 dev 编排）自动跳过。
set -e
DUMP=/seed/knowledge_hub.dump
if [ -f "$DUMP" ]; then
  echo "[init] 正在恢复种子数据到 knowledge_hub ..."
  pg_restore --clean --if-exists --no-owner --no-privileges -U "$POSTGRES_USER" -d knowledge_hub "$DUMP"
  echo "[init] 种子数据恢复完成。"
else
  echo "[init] 未发现 $DUMP，跳过种子恢复。"
fi
