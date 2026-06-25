# 快速开始（同事 SVN 拉取后）

本仓库已随版本携带**原始资料**与**数据库种子**，同事 checkout 后无需重新上传/导入任何资料，
即可一键起库、构建并进行功能测试。

## 仓库里都带了什么

| 内容 | 路径 | 说明 |
|---|---|---|
| 全库数据 dump | `seed/db/knowledge_hub.dump` | `pg_dump` 自定义格式，含资料库/资产包/发布/审核等全部业务数据 |
| 原始资料本体 | `data/storage/blobs/` | 内容寻址的不可变 blob（约 218MB），无需再次上传 |
| 已发布 OKF bundle | `data/releases/` | MCP `kb_*` 工具读取当前发布版本的来源 |
| 资产组件正文 | `data/kb-build-runs/<run>/data/{wiki,table_schemas,processed}` | 资产浏览器查看文件内容的来源（仅保留被引用 run 的轻量产物） |

> 可再生的大体积运行产物（各 run 的 `gamedata/gamedocs` 副本、`logs/`、`web-imports/` 等）已被
> `svn:ignore` 排除，不随仓库分发。

## 前置条件

- **Node 22+**
- **Docker Desktop**（用自带的 `docker-compose.yml` 起 PostgreSQL；不想用 Docker 也可自备 PG，见末尾）
- SVN 客户端（TortoiseSVN 或命令行 `svn`）

## 步骤

```bash
# 1. 拉取代码（含原始资料与种子，首次约数百 MB）
svn checkout <SVN_URL> knowledge-hub
cd knowledge-hub

# 2. 准备环境变量：默认值已与 docker-compose 对齐，开箱即用
cp .env.example .env
#   - 仅做功能测试/浏览已发布知识：无需改任何值
#   - 若要重新跑“知识构建”流水线：把 OPENAI_API_KEY / OPENAI_BASE_URL 填上

# 3. 安装依赖
npm install

# 4. 起 PostgreSQL 并恢复全库种子数据（blobs/发布物已随 checkout 到位）
npm run db:up        # 启动容器，首次会自动创建 knowledge_hub / knowledge_hub_test
npm run db:restore   # 把 seed/db 的 dump 恢复进 knowledge_hub

# 5. 构建并启动
npm run build
npm start            # 打开 http://127.0.0.1:4174
```

登录演示账号：`admin / adminpw`（另有 `dev/devpw`、`viewer/viewpw`）。
进去即可看到已有的资料库、知识资产包、发布版本——全部来自种子，无需重新导入。

> **端口占用**：`docker-compose.yml` 把容器 5432 映射到本机 5432。若你本机已经跑了 PostgreSQL
> 占用 5432，请改 `docker-compose.yml` 的端口（如 `"5433:5432"`）并同步把 `.env` 里两个连接串改成 5433。

## 功能测试

```bash
npm test             # vitest，连 knowledge_hub_test，按 schema 隔离，自动建/清
```

也可在 UI 里走完整闭环：资料库 → 知识资产 → 审核 → 发布 → Agent 反馈；
或用 `npm run mcp:stdio` 以标准 MCP 协议验证 `kb_*` 工具读取当前发布版本。

## 不用 Docker（自备 PostgreSQL）

1. 自行创建两个库：`knowledge_hub`、`knowledge_hub_test`。
2. 把 `.env` 里的 `DATABASE_URL` / `KH_TEST_DATABASE_URL` 改成你的连接串。
3. 用本机 `pg_restore` 恢复：
   ```bash
   pg_restore --clean --if-exists --no-owner --no-privileges \
     -d "<你的 knowledge_hub 连接串>" seed/db/knowledge_hub.dump
   ```
4. 其余步骤（`npm install` / `npm run build` / `npm start` / `npm test`）相同。

## 维护者：首次把项目推到 SVN

```powershell
# 在已有 SVN 服务器上准备好一个空目标路径，然后：
pwsh scripts/svn-bootstrap.ps1 -Url <SVN_URL>
svn status | Select-String '^[^?]'    # 复核将提交的内容
svn commit -m "chore: SVN 初始化（含种子数据与原始资料）"
```

更新种子数据（资料/资产有变更后重新生成 dump）：

```bash
pg_dump -Fc -f seed/db/knowledge_hub.dump "<knowledge_hub 连接串>"
svn commit seed/db/knowledge_hub.dump -m "chore: 更新数据库种子"
# 若新增了被引用的 run 或 blob，按需 svn add 对应 data/ 子路径
```
