# Knowledge Hub Architecture

## Boundary

Knowledge Hub is a new TypeScript implementation that reuses the knowledge-platform documents and ideas, but does not import the old Python code. The old system remains a reference and future import source.

## Layers

```text
React SPA
  -> Fastify routes
  -> KnowledgeService read model
  -> SQLite tables
  -> local storage files
```

The first version keeps the stack small. The important boundary is that UI routes do not construct knowledge summaries themselves; they call `KnowledgeService`, which owns the product read model.

## Core Tables

- `sources`: immutable source versions.
- `asset_packages`: one import/generation/manual curation unit.
- `asset_components`: package members such as Wiki, Index, Graph, Table, Evidence, Quality.
- `review_tasks`: human-actionable issues derived from quality findings.
- `releases`: immutable Agent-facing versions.
- `agent_events`: feedback from Agent reads, misses and quality flags.
- `users`: local account store for small-team access.

## Legacy Preview

`scanLegacyKbBuilder()` inspects a legacy `kb-builder data/` directory without mutating it. It reports:

- original source files under `gamedocs/` and `gamedata/`
- Wiki pages under `wiki/`
- index assets under `wiki/_meta/`
- graph snapshots under `graph/`
- table/schema assets under `tables/` and `wiki/tables/`

The scan result is a preview for administrators. A later import step will convert the preview into a first-class asset package.

## Product Flow

```text
资料进入
  -> 生成/导入知识资产包
  -> 审核证据和结构
  -> 发布给 Agent
  -> 观察 Agent 使用反馈
  -> 修订资料、索引、Wiki、图谱、表结构
```

## Current Tradeoffs

- SQLite is used for simple deployment and small-team concurrency.
- `node:sqlite` requires Node 22 and currently emits an experimental warning.
- Seed data is intentionally included so the first screen is useful immediately.
- The first MVP focuses on viewing and collaboration flow; file ingestion and MCP protocol come next.
