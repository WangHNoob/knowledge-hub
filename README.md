# Knowledge Hub

TypeScript full-stack knowledge asset hub for collaborative knowledge governance.

## Stack

- Fastify API
- React + Vite SPA
- SQLite WAL via Node 22 `node:sqlite`
- Vitest tests

## First Run

```bash
npm install
npm test
npm run build
npm start
```

Open:

```text
http://127.0.0.1:4174
```

Seed users:

| User | Password | Role |
|---|---|---|
| `admin` | `adminpw` | admin |
| `dev` | `devpw` | developer |
| `viewer` | `viewpw` | viewer |

## Model

The product language is intentionally user-facing:

```text
资料库 -> 知识资产包 -> 资产组件 -> 审核任务 -> 发布版本 -> Agent 反馈
```

Internal identifiers remain visible for administrators and lead developers:

- `sourceVersionId`
- `packageId`
- `componentId`
- `artifactId`
- `releaseId`

## Current MVP

- Login with seeded users.
- Source upload with content hash, immutable storage and idempotent source versions.
- Legacy `kb-builder` directory scan preview for source, Wiki, Index, Graph and Table assets.
- Legacy scan-to-package import that keeps original files untouched and creates a draft asset package.
- Dashboard for the knowledge evolution flywheel.
- Asset package browser with Wiki / Index / Graph / Table grouping.
- Blocking review task view.
- Release list.
- Agent feedback list.
- JSON API protected by JWT.

## Next Milestones

1. Evidence records and evidence coverage views.
2. Package publish workflow with immutable manifest hash.
3. Standard MCP server and expanded `kb_*` tools.
4. Multi-user management screens for admin accounts.
