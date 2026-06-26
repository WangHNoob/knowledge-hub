# Docker 部署（应用 + 自带 PostgreSQL，都在 compose 内）

适用场景：**服务器自带的 Node 版本过低**（本项目需要 Node 22）。所以把应用放进 Docker（镜像自带 Node 22）。
数据库也用本编排自带的 `postgres:18` 容器——**不占用宿主 5432**（容器只在 compose 内网通信，不映射宿主端口），
与服务器上已有的其它 PG（如 langfuse 的 postgres:17）互不影响。

---

## 数据库怎么配置（核心）

**结论：基本零配置，全自动。** `docker compose -f docker-compose.prod.yml up -d` 首次启动时，
`postgres` 容器会自动完成下面这些事，你不用手动建库或导数据：

1. 用环境变量创建主库 `knowledge_hub`（`scripts/pg-init/` 在数据卷为空时执行一次）。
2. `01-create-test-db.sql` 创建测试库 `knowledge_hub_test`。
3. `02-restore-seed.sh` 把随包携带的全库 dump（`seed/db/knowledge_hub.dump`）恢复进 `knowledge_hub`——
   原始资料、资产包、发布、审核等数据一次到位。
4. 应用启动后自动迁移表结构（`CREATE TABLE IF NOT EXISTS`，对已恢复的库是空操作），演示数据不会重复 seed。

数据持久化在 Docker 命名卷 `kh-pgdata` 里，独立于宿主和其它容器。

### 可调的几个地方（都在 `.env` 里）

| 变量 | 作用 | 默认 |
|---|---|---|
| `POSTGRES_PASSWORD` | 自带 PG 的密码（仅 compose 内部用，可任意设，**必填**） | 无 |
| `KH_JWT_SECRET` | 应用鉴权密钥（**必填**，已为你生成强随机串） | 无 |
| `APP_HOST_PORT` | 应用对外端口 | `4174` |
| `KH_UPLOAD_MAX_FILE_BYTES` | Web 上传资料的单文件上限，单位 bytes | `2147483648` |
| `KH_UPLOAD_MAX_FILES` | 一次上传最多文件数 | `20000` |
| `KH_UPLOAD_MAX_PARTS` | 一次上传最多 multipart part 数，通常要大于文件数+字段数 | `20200` |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | LLM（仅“知识构建”需要） | 空 |

> 应用连库的 `DATABASE_URL` **不需要你配**——`docker-compose.prod.yml` 内部按
> `postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/knowledge_hub` 自动生成（`postgres` 是服务名，
> `5432` 是容器内端口，与宿主 5432 无关）。

---

## 部署步骤

```bash
# 1. 解压部署包
tar -xzf knowledge-hub-deploy.tar.gz

# 2. 放入配好的 .env（含 KH_JWT_SECRET 和 POSTGRES_PASSWORD，单独上传，不在包里）
mv knowledge-hub-server.env knowledge-hub/.env
cd knowledge-hub

# 3. 一键起栈（首次会自动建库 + 恢复种子，约 1~2 分钟）
docker compose -f docker-compose.prod.yml up -d --build

# 4. 访问 http://<服务器IP>:4174 ，登录 admin / adminpw
```

---

## 验证 / 运维 / 排错

```bash
# 看容器状态（postgres 应为 healthy，app 应为 running）
docker compose -f docker-compose.prod.yml ps

# 看种子是否恢复成功
docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" kh-postgres \
  psql -U postgres -d knowledge_hub -tAc "select count(*) from source_blobs"   # 期望 1279

# 看应用日志（应出现 “Knowledge Hub listening on http://0.0.0.0:4174”）
docker compose -f docker-compose.prod.yml logs -f app

# 进数据库交互式 shell
docker exec -it -e PGPASSWORD="$POSTGRES_PASSWORD" kh-postgres psql -U postgres -d knowledge_hub

# 改完代码/配置后重建重启
docker compose -f docker-compose.prod.yml up -d --build

# 改对外端口
echo "APP_HOST_PORT=8080" >> .env && docker compose -f docker-compose.prod.yml up -d
```

### 上传大文件 / 大目录报错

如果上传原始资料时报 `request file too large`，先在服务器 `.env` 里调大应用限制，然后重建/重启：

```bash
echo "KH_UPLOAD_MAX_FILE_BYTES=4294967296" >> .env   # 4GB 单文件
echo "KH_UPLOAD_MAX_FILES=50000" >> .env
echo "KH_UPLOAD_MAX_PARTS=50200" >> .env
docker compose -f docker-compose.prod.yml up -d --build
```

如果前面有 Nginx 或云厂商网关，还必须同步调大代理层限制。例如 Nginx：

```nginx
server {
  client_max_body_size 4g;
}
```

改完执行 `nginx -t && systemctl reload nginx`。如果代理层没放开，请求会在到达应用前就失败。

### 重置数据库（重新从种子恢复）

种子只在**数据卷为空**时自动恢复。要重来一遍：

```bash
docker compose -f docker-compose.prod.yml down -v   # -v 会删除 kh-pgdata 卷里的数据
docker compose -f docker-compose.prod.yml up -d --build
```

### 备份 / 更新种子

```bash
# 从运行中的容器导出当前全库（自定义格式）
docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" kh-postgres \
  pg_dump -U postgres -Fc knowledge_hub > backup_$(date +%Y%m%d).dump

# 要更新随包种子：把新 dump 覆盖 seed/db/knowledge_hub.dump，再 down -v && up
```

---

## 关键约束

- **不占用宿主 5432**：`postgres` 服务故意不写 `ports`，只在 compose 内网可见。
  如需从宿主用工具连库调试，临时给它加 `ports: ["15432:5432"]`（用 15432，不要用 5432）。
- 自带 PG 是 `postgres:18`，与随包种子的 dump 版本一致（dump 来自 PG 18.4）；
  不要把种子恢复进更低版本（如服务器上 langfuse 的 postgres:17）。
- 数据库数据卷 `kh-pgdata` 独立持久化；`docker compose down`（不带 `-v`）不会清数据，`down -v` 才会清。

---

## 与本地开发编排的区别

- `docker-compose.yml`（开发用）：起一个 PG 并映射宿主 5432，配合 `npm run db:restore` 手动恢复，仅供本机/同事开发。
- `docker-compose.prod.yml`（本部署）：应用 + 自带 PG，自动恢复种子，不映射宿主端口。
