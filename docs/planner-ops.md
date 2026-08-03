# 策划可用模式运维说明

面向内网试点：策划交 SVN → Hub 同步 → 建版本 → 构建 → 发布 → Agent 经 MCP 查询。

## 目标工作流

```text
策划提交 SVN
    → 服务器工作副本 svn update（或工作台「从 SVN 同步」）
    → Hub 导入新资料版本
    → 飞轮 sync（构建 / lint / 发布）
    → design-agent 等经 MCP 读已发布知识
```

## 环境变量（瘦身相关）

| 变量 | 默认 | 说明 |
|------|------|------|
| `KH_UI_MODE` | `simple` | simple=工作台导航；full=完整飞轮台。admin 可前端临时切换 |
| `KH_PUBLISH_RELAXED` | `true` | 降低自动发布门槛 |
| `KH_MIN_AUTO_PUBLISH_SCORE` | `0.35` | 宽松模式最低自动发布分 |
| `KH_AUTO_REMEDIATION_ENABLED` | `false` | 关闭 LLM 自愈 |
| `KH_AUTO_ALIAS_REMEDIATION_ENABLED` | `false` | 关闭别名自动修复 |
| `KH_SVN_SYNC_ENABLED` | `false` | 开启才允许 SVN 同步 |
| `KH_SVN_WC_PATH` | 空 | SVN 工作副本根目录 |
| `KH_SVN_UPDATE_CMD` | `svn update` | 更新命令 |

计划任务：`KH_OPS_BASE_URL` / `KH_OPS_TOKEN` 或 `KH_OPS_USER`+`KH_OPS_PASSWORD`。

```bash
KH_UI_MODE=simple
KH_PUBLISH_RELAXED=true
KH_MIN_AUTO_PUBLISH_SCORE=0.35
KH_AUTO_REMEDIATION_ENABLED=false
KH_AUTO_ALIAS_REMEDIATION_ENABLED=false
KH_SVN_SYNC_ENABLED=true
KH_SVN_WC_PATH=D:/svn/gamedocs
```

## 日常操作

- 工作台：admin/developer 点「从 SVN 同步到知识库」
- 计划任务：`npm run ops:svn-sync` 或 `node scripts/svn-sync-ingest.mjs`
- 无 SVN：简单模式「上传资料」；`KH_AUTO_BUILD_ON_UPLOAD=true` 自动流转

## 验收清单

- [ ] 默认侧栏为简单导航
- [ ] admin 可切完整/简单模式
- [ ] remediation 默认关
- [ ] 宽松发布可自动过门禁
- [ ] SVN 按钮或脚本能完成 update→版本→sync
- [ ] 待我处理可读；MCP 可查已发布内容

## 回退

- `KH_UI_MODE=full`；`KH_PUBLISH_RELAXED=false`；打开 `KH_AUTO_REMEDIATION_*`；`KH_SVN_SYNC_ENABLED=false`
