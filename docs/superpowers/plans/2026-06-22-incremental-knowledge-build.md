# Incremental Knowledge Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce rebuild token and time cost by making source-table/document changes reuse unchanged knowledge assets.

**Architecture:** Add incremental behavior in phases. Phase 1 caches expensive LLM extraction outputs by content and configuration hash. Phase 2 adds changed-file/table impact analysis. Phase 3 reuses unchanged components when composing packages and OKF releases.

**Tech Stack:** TypeScript, Vitest, Node fs/path/crypto, existing kb-builder pipeline, PostgreSQL-backed source bundles.

---

### Task 1: Extract Stage Cache

**Files:**
- Modify: `src/server/services/kbBuilder/extractStage.ts`
- Test: `tests/kb-builder-extract.test.ts`

- [x] **Step 1: Write a test that proves cached extract output is reused**

Add a test that runs `runExtractStage` once, edits the generated wiki output to include a sentinel, runs the stage again with identical parsed input, and expects the sentinel to remain because the second run copied cached output instead of re-extracting.

- [x] **Step 2: Add a cache key**

Compute `sha256` over:
- parsed markdown content
- parsed relative path
- `specs.hash`
- selected model name
- table alias file content

Store cached output under `dataDir/.kh-cache/extract/<cacheKey>/wiki.md` and `meta.json`.

- [x] **Step 3: Use the cache**

When `force === false` and both cached files exist, copy them to the target wiki/meta paths, push the output paths, emit progress text with `cached`, and skip `extractPage`.

- [x] **Step 4: Refresh the cache after extraction**

After a fresh extraction writes wiki/meta, copy those files into the cache directory.

- [x] **Step 5: Verify**

Run:

```bash
npx vitest run tests/kb-builder-extract.test.ts
npm run typecheck
```

Expected: all tests pass.

### Task 2: Changed Source Diff

**Files:**
- Create: `src/server/services/kbBuilder/sourceDiff.ts`
- Modify: `src/server/services/kbBuilderService.ts`
- Test: `tests/kb-builder-source-diff.test.ts`

- [x] **Step 1: Compare source versions**

Load `source_files` rows for current and base source versions and classify paths as `added`, `modified`, `deleted`, `unchanged` by content hash.

- [x] **Step 2: Store diff in run config**

When a build starts, write the changed logical paths into `knowledge_build_runs.config.incremental`.

- [x] **Step 3: Verify**

Run a test with two source versions where one table changed and one doc stayed unchanged.

### Task 3: Table-Only Rebuild

**Files:**
- Modify: `src/server/services/kbBuilder/tableStage.ts`
- Modify: `src/server/services/kbBuilderService.ts`
- Test: `tests/kb-builder-table-graph.test.ts`

- [x] **Step 1: Add changed table filter**

Allow `runTableStage` to accept changed logical paths and only reread matching `.csv/.xlsx/.xls` files when a previous schema manifest exists.

- [x] **Step 2: Merge old schemas**

Read existing `wiki/_tables/schemas.json`, replace changed tables, remove deleted tables, and preserve unchanged schemas.

- [x] **Step 3: Verify**

Run table-stage tests proving one changed table does not rewrite unrelated table schemas.

### Task 4: Impact Graph and Component Reuse

**Files:**
- Create: `src/server/services/kbBuilder/impactGraph.ts`
- Modify: `src/server/services/kbBuilderService.ts`
- Modify: `src/server/services/kbBuilder/collector.ts`
- Test: `tests/kb-builder-incremental-service.test.ts`

- [ ] **Step 1: Build source-to-artifact dependency edges**

Use component `source_refs`, wiki `Data Dependencies`, and graph table edges to identify affected artifacts.

- [ ] **Step 2: Reuse unchanged artifact files**

For unchanged artifacts, copy the latest published/draft component storage file into the new run workspace before collect.

- [ ] **Step 3: Verify**

Run an integration test where one table changes and only table schema, affected wiki, graph, and OKF assets change.

### Task 5: Table Patch Review Workflow

**Files:**
- Modify: `src/server/db.ts`
- Create: `src/server/services/tablePatchService.ts`
- Modify: `src/server/services/knowledgeQueryService.ts`
- Test: `tests/table-patch-service.test.ts`

- [ ] **Step 1: Add patch draft table**

Create `table_patch_drafts` with status, source version, table name, row selector, old/new values, reason, evidence, actor, timestamps.

- [ ] **Step 2: Add MCP proposal tool**

Add `kb_propose_table_patch` to write draft changes only. It must not mutate source blobs.

- [ ] **Step 3: Add review integration**

Create review tasks for each patch draft and require approval before producing a new source bundle version.

- [ ] **Step 4: Verify**

Run tests proving Agent proposals do not change released table data until approval.
