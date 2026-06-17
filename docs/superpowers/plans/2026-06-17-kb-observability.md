# KB Pipeline Observability & Asset Inspection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three independent UX/observability improvements to the knowledge pipeline: (A) move 策划立法 before 知识构建 in nav; (B) a file browser to inspect the files inside an asset package; (C) a live, command-line-style streaming log of a running build.

**Architecture:** Reuse existing infrastructure wherever possible. (A) is a one-line array reorder. (B) adds one read-only file-content endpoint on `KnowledgeQueryService` (which already resolves component files via `readComponentText`) plus a tree+viewer in `Assets.tsx`. (C) adds an in-process `EventEmitter` to the existing `DiagnosticLogger`, a per-document `onProgress` callback threaded into the extract stage, an SSE endpoint that replays history then live-tails by `runId`, and a `fetch`+`ReadableStream` terminal panel (not `EventSource`, so the JWT `Authorization` header still works).

**Tech Stack:** Fastify v5 (`reply.hijack()` + `reply.raw` for SSE), Node `EventEmitter`, PostgreSQL (`diagnostic_logs`), React 19 + React Query, Vitest (`app.inject()` + `mkdtempSync` + `createDatabase({seed})`). No new runtime dependencies.

**Branch:** `feat/kb-pipeline-observability` (already created; pipeline fixes committed at `f590f30`).

**Execution order:** Feature A (trivial) → Feature B (file browser) → Feature C (SSE). Each feature is independently committable and shippable.

---

## File Structure

| File | Change | Feature |
|---|---|---|
| `src/client/src/ui/App.tsx` | reorder `NAV` array (swap legislation/builder) | A |
| `src/server/services/knowledgeQueryService.ts` | add public `getComponentFile()` + containment guard; reuse `readComponentText` resolution | B |
| `src/server/routes/packages.ts` | add `GET /api/packages/:packageId/components/:componentId/content` | B |
| `src/client/src/api/packages.ts` + `api/types.ts` | add `getComponentContent()` + `ComponentContent` type | B |
| `src/client/src/pages/Assets.tsx` | build legacyPath tree + file viewer panel | B |
| `src/server/services/diagnosticService.ts` | add `EventEmitter`, emit on `write()`, `subscribe()` | C |
| `src/server/services/kbBuilder/types.ts` + `extractStage.ts` | add `onProgress` to extract options; call per document | C |
| `src/server/services/kbBuilderService.ts` | pass `onProgress` that writes per-doc diagnostic events | C |
| `src/server/routes/builder.ts` | add `GET /api/build-runs/:runId/stream` (SSE) | C |
| `src/server/services/sse.ts` | new — pure `formatSseFrame()` helper | C |
| `src/client/src/api/buildLogs.ts` | new — `streamBuildLogs()` fetch+reader SSE parser | C |
| `src/client/src/components/BuildLogConsole.tsx` | new — terminal-style log panel | C |
| `src/client/src/pages/KnowledgeBuilder.tsx` | mount `BuildLogConsole` for the active run | C |
| `tests/component-content.test.ts` | new — Feature B endpoint tests | B |
| `tests/diagnostics-stream.test.ts` | new — emitter + sse-frame + onProgress tests | C |

---

# FEATURE A — Move 策划立法 before 知识构建

### Task A1: Reorder navigation

**Files:**
- Modify: `src/client/src/ui/App.tsx:32-43`

- [ ] **Step 1: Edit the `NAV` array** — move the `legislation` entry directly above the `builder` entry. Final array:

```ts
const NAV: Array<{ id: View; label: string; icon: typeof Activity }> = [
  { id: "dashboard",    label: "首页",      icon: Activity },
  { id: "sources",      label: "资料库",    icon: Database },
  { id: "legislation",  label: "策划立法",  icon: ScrollText },
  { id: "builder",      label: "知识构建",  icon: PackagePlus },
  { id: "assets",       label: "知识资产",  icon: Boxes },
  { id: "review",       label: "审核中心",  icon: CheckCircle2 },
  { id: "release",      label: "发布",      icon: GitBranch },
  { id: "agent",        label: "Agent 反馈", icon: SearchCheck },
  { id: "diagnostics",  label: "运行诊断",  icon: Bug },
  { id: "maintenance",  label: "高级维护",  icon: Archive },
];
```

Only the order of the `legislation` and `builder` lines changes. Do not touch icons, ids, labels, or the `<main>` render switch.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/client/src/ui/App.tsx
git commit -m "feat(ui): move 策划立法 before 知识构建 in nav"
```

---

# FEATURE B — Asset package file browser

### Task B1: Backend — component file-content method

**Files:**
- Modify: `src/server/services/knowledgeQueryService.ts`
- Test: `tests/component-content.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/component-content.test.ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "../src/server/db";
import { createKnowledgeQueryService } from "../src/server/services/knowledgeQueryService";

let dir: string;
let db: Awaited<ReturnType<typeof createDatabase>>;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "kh-content-"));
  db = await createDatabase({ seed: true, dataDir: dir });
});
afterEach(async () => {
  await db.close?.();
  rmSync(dir, { recursive: true, force: true });
});

async function insertPackageWithComponent(opts: { runId: string; storageUri: string }) {
  await db.adapter.query(
    `INSERT INTO asset_packages (package_id, name, kind, status, description, created_by_run_id, source_version_ids, legacy_paths, quality_summary, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    ["pkg_t", "t", "kb_builder_pipeline", "draft", "", opts.runId, "[]", "[]", "{}", new Date().toISOString()],
  );
  await db.adapter.query(
    `INSERT INTO asset_components (component_id, package_id, artifact_id, group_name, kind, title, status, legacy_path, storage_uri, source_refs, quality)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    ["cmp_t", "pkg_t", "art_t", "wiki", "wiki_page", "成就", "draft", "wiki/systems/成就.md", opts.storageUri, "[]", "{}"],
  );
}

describe("getComponentFile", () => {
  it("returns file content for a component in its run workspace", async () => {
    const runId = "run_test_0001";
    const fileAbs = path.join(dir, "kb-build-runs", runId, "data", "wiki", "systems", "成就.md");
    mkdirSync(path.dirname(fileAbs), { recursive: true });
    writeFileSync(fileAbs, "# 成就系统\nhello", "utf8");
    await insertPackageWithComponent({ runId, storageUri: "data/wiki/systems/成就.md" });

    const svc = createKnowledgeQueryService(db, dir);
    const result = await svc.getComponentFile("pkg_t", "cmp_t");
    expect(result.kind).toBe("wiki_page");
    expect(result.legacyPath).toBe("wiki/systems/成就.md");
    expect(result.content).toContain("成就系统");
    expect(result.truncated).toBe(false);
  });

  it("rejects a component that does not belong to the package", async () => {
    await insertPackageWithComponent({ runId: "run_x", storageUri: "data/wiki/x.md" });
    const svc = createKnowledgeQueryService(db, dir);
    await expect(svc.getComponentFile("pkg_other", "cmp_t")).rejects.toThrow(/not found|unknown/i);
  });

  it("rejects legacy:// components", async () => {
    await insertPackageWithComponent({ runId: "run_x", storageUri: "legacy://wiki/x.md" });
    const svc = createKnowledgeQueryService(db, dir);
    await expect(svc.getComponentFile("pkg_t", "cmp_t")).rejects.toThrow(/legacy/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/component-content.test.ts`
Expected: FAIL — `getComponentFile is not a function` (or compile error).

- [ ] **Step 3: Implement `getComponentFile`** in `src/server/services/knowledgeQueryService.ts`.

First confirm the existing imports at the top of the file include `isAbsolute`, `join`, `relative`, `existsSync`, `readFileSync` from `node:path`/`node:fs`. `readComponentText` already uses `isAbsolute`, `join`, `existsSync`, `readFileSync`; add `relative` to the `node:path` import if missing.

Add this public method to the `KnowledgeQueryService` class (place it just above the private `readComponentText` method). It loads the component, verifies package ownership, resolves the file with the SAME candidate logic as `readComponentText`, adds a path-containment guard, and caps size:

```ts
  async getComponentFile(packageId: string, componentId: string): Promise<{
    componentId: string;
    kind: string;
    legacyPath: string;
    storageUri: string;
    content: string;
    truncated: boolean;
  }> {
    const { rows } = await this.adapter.query(
      "SELECT * FROM asset_components WHERE component_id = $1 AND package_id = $2",
      [componentId, packageId],
    );
    if (rows.length === 0) throw new Error(`Component not found in package: ${componentId}`);
    const component = mapComponent(rows[0]);
    if (component.storageUri.startsWith("legacy://")) {
      throw new Error(`Legacy component is not materialized locally: ${componentId}`);
    }

    const packages = await this.releasePackages({ packageIds: [component.packageId] } as ReleaseRecord);
    const runId = packages[0]?.createdByRunId ?? "";
    const runRoot = runId ? join(this.dataDir, "kb-build-runs", runId) : "";
    const candidates = [
      isAbsolute(component.storageUri) ? component.storageUri : "",
      runRoot ? join(runRoot, component.storageUri) : "",
      join(this.dataDir, component.storageUri),
    ].filter(Boolean);

    const resolved = candidates.find((candidate) => existsSync(candidate));
    if (!resolved) throw new Error(`Artifact file not found for component ${componentId}: ${component.storageUri}`);

    // Path-containment guard: resolved file must stay under the run workspace or the data dir.
    const allowedRoots = [runRoot, this.dataDir].filter(Boolean);
    const contained = allowedRoots.some((root) => {
      const rel = relative(root, resolved);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    });
    if (!contained) throw new Error(`Refusing to read file outside allowed roots: ${componentId}`);

    const MAX_BYTES = 512 * 1024;
    const raw = readFileSync(resolved, "utf8");
    const truncated = raw.length > MAX_BYTES;
    return {
      componentId: component.componentId,
      kind: component.kind,
      legacyPath: component.legacyPath,
      storageUri: component.storageUri,
      content: truncated ? `${raw.slice(0, MAX_BYTES)}\n\n…[truncated ${raw.length - MAX_BYTES} chars]` : raw,
      truncated,
    };
  }
```

Confirm `mapComponent` is already imported in this file (it is used elsewhere in the service). If `createKnowledgeQueryService(db, dataDir)` is the export signature, the test's call matches; verify the factory at the bottom of the file accepts `(db, dataDir)`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/component-content.test.ts`
Expected: PASS (3 tests). If `createDatabase` signature differs (e.g. no `dataDir` option), check `src/server/db.ts` `createDatabase` and adapt the test setup to whatever existing tests use (see `tests/db.test.ts` for the canonical setup) — match the existing pattern.

- [ ] **Step 5: Commit**

```bash
git add src/server/services/knowledgeQueryService.ts tests/component-content.test.ts
git commit -m "feat(assets): add component file-content read with path containment"
```

### Task B2: Backend — content route

**Files:**
- Modify: `src/server/routes/packages.ts`
- Test: append to `tests/component-content.test.ts`

- [ ] **Step 1: Write the failing test** (append; uses `buildApp` + `app.inject` like `tests/api.test.ts`)

```ts
import { buildApp } from "../src/server/app";

describe("GET /api/packages/:packageId/components/:componentId/content", () => {
  async function tokenFor(app: Awaited<ReturnType<typeof buildApp>>) {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "adminpw" } });
    return JSON.parse(res.body).token as string;
  }

  it("serves component content via HTTP", async () => {
    const runId = "run_http_0001";
    const fileAbs = path.join(dir, "kb-build-runs", runId, "data", "wiki", "systems", "成就.md");
    mkdirSync(path.dirname(fileAbs), { recursive: true });
    writeFileSync(fileAbs, "# 成就系统", "utf8");
    await insertPackageWithComponent({ runId, storageUri: "data/wiki/systems/成就.md" });

    const app = await buildApp({ db, dataDir: dir });
    const token = await tokenFor(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/packages/pkg_t/components/cmp_t/content",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).content).toContain("成就系统");
    await app.close();
  });

  it("returns 404 for unknown component", async () => {
    const app = await buildApp({ db, dataDir: dir });
    const token = await tokenFor(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/packages/pkg_t/components/nope/content",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
```

> Note: match the real `buildApp` options shape — inspect `src/server/app.ts` `BuildAppOptions` (the Explore notes show `buildApp({ db, ... })` with `dataDir` derived); pass what existing tests in `tests/api.test.ts` pass. Adapt the two `buildApp(...)` calls accordingly.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/component-content.test.ts`
Expected: the two new tests FAIL with 404/route-not-found for the happy path.

- [ ] **Step 3: Add the route** in `src/server/routes/packages.ts`, inside `registerPackageRoutes`, after the `/api/packages/:packageId` route:

```ts
  app.get<{ Params: { packageId: string; componentId: string } }>(
    "/api/packages/:packageId/components/:componentId/content",
    { preHandler: app.authenticate },
    async (request, reply) => {
      try {
        return await ctx.queryService.getComponentFile(request.params.packageId, request.params.componentId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to read component file.";
        const code = /legacy/i.test(message) ? 400 : 404;
        return reply.code(code).send({ error: message });
      }
    },
  );
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/component-content.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/packages.ts tests/component-content.test.ts
git commit -m "feat(assets): add component content HTTP route"
```

### Task B3: Frontend — API client + types

**Files:**
- Modify: `src/client/src/api/packages.ts`, `src/client/src/api/types.ts`

- [ ] **Step 1: Add the type** to `src/client/src/api/types.ts`:

```ts
export interface ComponentContent {
  componentId: string;
  kind: string;
  legacyPath: string;
  storageUri: string;
  content: string;
  truncated: boolean;
}
```

- [ ] **Step 2: Add the client function** to `src/client/src/api/packages.ts`:

```ts
import type { AssetPackage, ComponentContent, EvidenceCoverage, EvidenceRecord, PackageDetail } from "./types";

export async function getComponentContent(packageId: string, componentId: string): Promise<ComponentContent> {
  return getJson(`/api/packages/${encodeURIComponent(packageId)}/components/${encodeURIComponent(componentId)}/content`);
}
```

(Keep the existing `import` line's other names; just add `ComponentContent`.)

Ensure `ComponentContent` is re-exported from the api barrel (`src/client/src/api/index.ts` if one exists, mirroring how `AssetPackage`/`PackageDetail` are exported). If `Assets.tsx` imports types from `"../api"`, add `ComponentContent` and `getComponentContent` to that barrel.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/client/src/api/packages.ts src/client/src/api/types.ts src/client/src/api/index.ts
git commit -m "feat(assets): add getComponentContent api client"
```

### Task B4: Frontend — file tree + viewer in Assets

**Files:**
- Modify: `src/client/src/pages/Assets.tsx`

- [ ] **Step 1: Add a tree builder + state + viewer.** Replace the flat group rendering (lines 64-84) with a directory tree built from each component's `legacyPath`, and add a right-hand viewer panel that loads content on click. Full new component body for the detail section:

Add imports at top:
```ts
import { getComponentContent, getPackage, listPackages, type AssetPackage } from "../api";
```

Add a tree helper near the top of the file (module scope):
```ts
type TreeNode = {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  component?: { componentId: string; kind: string; legacyPath: string };
};

function buildTree(components: Array<{ componentId: string; kind: string; legacyPath: string }>): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map() };
  for (const component of components) {
    const parts = (component.legacyPath || component.componentId).split("/").filter(Boolean);
    let node = root;
    parts.forEach((part, index) => {
      const childPath = parts.slice(0, index + 1).join("/");
      if (!node.children.has(part)) node.children.set(part, { name: part, path: childPath, children: new Map() });
      node = node.children.get(part)!;
      if (index === parts.length - 1) node.component = component;
    });
  }
  return root;
}
```

Inside the `Assets` component, add viewer state after the existing `useState`/`useQuery` hooks:
```ts
  const [openFile, setOpenFile] = useState<{ componentId: string } | null>(null);
  const fileContent = useQuery({
    queryKey: ["component-content", effectiveSelected, openFile?.componentId],
    queryFn: () => getComponentContent(effectiveSelected, openFile!.componentId),
    enabled: Boolean(effectiveSelected && openFile),
  });
  const tree = useMemo(() => buildTree(detail.data?.components ?? []), [detail.data]);
```

Add a recursive tree renderer as a nested function inside the component (so it can call `setOpenFile`):
```tsx
  const renderNode = (node: TreeNode, depth: number): JSX.Element[] =>
    [...node.children.values()]
      .sort((a, b) => (a.children.size === b.children.size ? a.name.localeCompare(b.name) : b.children.size - a.children.size))
      .flatMap((child) => {
        const isFile = child.children.size === 0 && Boolean(child.component);
        const row = (
          <button
            key={child.path}
            className={`tree-node ${isFile ? "file" : "dir"} ${openFile?.componentId === child.component?.componentId ? "active" : ""}`}
            style={{ paddingLeft: `${depth * 14 + 8}px` }}
            onClick={() => { if (isFile && child.component) setOpenFile({ componentId: child.component.componentId }); }}
          >
            {isFile ? "📄" : "📁"} {child.name}
          </button>
        );
        return isFile ? [row] : [row, ...renderNode(child, depth + 1)];
      });
```

Replace the `{Object.entries(byGroup).map(...)}` block (the old flat list, lines 64-84) with a two-pane layout:
```tsx
              <div className="asset-browser">
                <div className="asset-tree">{renderNode(tree, 0)}</div>
                <div className="asset-viewer">
                  {!openFile && <p className="subtle">点击左侧文件查看内容。</p>}
                  {openFile && fileContent.isLoading && <p className="subtle">加载中…</p>}
                  {openFile && fileContent.isError && <p className="error">{(fileContent.error as Error).message}</p>}
                  {openFile && fileContent.data && (
                    <>
                      <div className="viewer-head">
                        <code>{fileContent.data.legacyPath}</code>
                        <span>{fileContent.data.kind}{fileContent.data.truncated ? " · 已截断" : ""}</span>
                      </div>
                      <pre className="viewer-body">{formatContent(fileContent.data.legacyPath, fileContent.data.content)}</pre>
                    </>
                  )}
                </div>
              </div>
```

Add a module-scope formatter (pretty-prints JSON; everything else verbatim — no markdown library needed):
```ts
function formatContent(pathName: string, content: string): string {
  if (pathName.endsWith(".json")) {
    try { return JSON.stringify(JSON.parse(content), null, 2); } catch { return content; }
  }
  return content;
}
```

Keep `byGroup`/`evidenceByComponent` if still used elsewhere; if `byGroup` is now unused, remove it to satisfy the no-unused lint. Keep the evidence-coverage panel above the browser unchanged.

- [ ] **Step 2: Add minimal styles** to `src/client/src/styles.css` (append):

```css
.asset-browser { display: grid; grid-template-columns: 280px 1fr; gap: 12px; min-height: 360px; }
.asset-tree { overflow: auto; border-right: 1px solid var(--border, #2a2a2a); padding-right: 8px; }
.tree-node { display: block; width: 100%; text-align: left; background: none; border: 0; cursor: pointer; padding: 4px 8px; font-size: 13px; border-radius: 4px; }
.tree-node:hover { background: rgba(127,127,127,0.12); }
.tree-node.active { background: rgba(80,140,255,0.18); }
.tree-node.dir { font-weight: 600; }
.asset-viewer { overflow: auto; }
.viewer-head { display: flex; justify-content: space-between; gap: 8px; padding-bottom: 6px; }
.viewer-body { white-space: pre-wrap; word-break: break-word; background: #0d1117; color: #d6deeb; padding: 12px; border-radius: 6px; font-family: ui-monospace, monospace; font-size: 12.5px; max-height: 70vh; overflow: auto; }
```

(Use existing CSS variables if the project defines them; otherwise the literal fallbacks above are fine.)

- [ ] **Step 3: Typecheck + manual verify**

Run: `npm run typecheck` → PASS.
Manual: start the app, open 知识资产, select a package, confirm the file tree renders grouped by directory, clicking a file shows its content, `.json` is pretty-printed, an unknown/legacy file shows the error message.

- [ ] **Step 4: Commit**

```bash
git add src/client/src/pages/Assets.tsx src/client/src/styles.css
git commit -m "feat(assets): file tree browser with content viewer"
```

---

# FEATURE C — Live streaming build log (command-line style)

### Task C1: Diagnostic event bus

**Files:**
- Modify: `src/server/services/diagnosticService.ts`
- Test: `tests/diagnostics-stream.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/diagnostics-stream.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "../src/server/db";
import { createDiagnosticLogger } from "../src/server/services/diagnosticService";

let dir: string;
let db: Awaited<ReturnType<typeof createDatabase>>;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), "kh-diag-")); db = await createDatabase({ seed: false, dataDir: dir }); });
afterEach(async () => { await db.close?.(); rmSync(dir, { recursive: true, force: true }); });

describe("DiagnosticLogger event bus", () => {
  it("emits each written record to subscribers and unsubscribes", async () => {
    const logger = createDiagnosticLogger(db, dir, { logToDb: false, logToFile: false });
    const seen: string[] = [];
    const unsub = logger.subscribe((record) => seen.push(record.message));
    await logger.write({ category: "kb_build", message: "first", runId: "run_1", status: "event" });
    unsub();
    await logger.write({ category: "kb_build", message: "second", runId: "run_1", status: "event" });
    expect(seen).toEqual(["first"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/diagnostics-stream.test.ts`
Expected: FAIL — `logger.subscribe is not a function`.

- [ ] **Step 3: Implement the event bus** in `src/server/services/diagnosticService.ts`.

Add the import at top:
```ts
import { EventEmitter } from "node:events";
```

Inside `class DiagnosticLogger`, add a field and methods, and emit at the end of `write()`:
```ts
  private readonly emitter = new EventEmitter();

  subscribe(listener: (record: DiagnosticLogRecord) => void): () => void {
    this.emitter.setMaxListeners(0);
    this.emitter.on("log", listener);
    return () => this.emitter.off("log", listener);
  }
```

At the END of the `write()` method (after the DB insert try/catch, just before the method returns), emit the mapped record. The `record` local already has snake_case fields; map it with the existing `mapLog`:
```ts
    this.emitter.emit("log", mapLog(record));
```
Place this as the final statement of `write()` so subscribers receive every record regardless of `logToDb`/`logToFile`. (The early `return` for below-threshold level at the top of `write()` correctly skips emission too.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/diagnostics-stream.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/services/diagnosticService.ts tests/diagnostics-stream.test.ts
git commit -m "feat(diagnostics): add in-process log event bus"
```

### Task C2: SSE frame formatter

**Files:**
- Create: `src/server/services/sse.ts`
- Test: append to `tests/diagnostics-stream.test.ts`

- [ ] **Step 1: Write the failing test** (append)

```ts
import { formatSseFrame } from "../src/server/services/sse";

describe("formatSseFrame", () => {
  it("formats a data frame terminated by a blank line", () => {
    const frame = formatSseFrame({ a: 1, msg: "x" });
    expect(frame).toBe(`data: {"a":1,"msg":"x"}\n\n`);
  });
  it("supports an event name", () => {
    expect(formatSseFrame({ ok: true }, "done")).toBe(`event: done\ndata: {"ok":true}\n\n`);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/diagnostics-stream.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/server/services/sse.ts
export function formatSseFrame(data: unknown, event?: string): string {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  return event ? `event: ${event}\n${payload}` : payload;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/diagnostics-stream.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/services/sse.ts tests/diagnostics-stream.test.ts
git commit -m "feat(diagnostics): add SSE frame formatter"
```

### Task C3: Per-document extract progress

**Files:**
- Modify: `src/server/services/kbBuilder/types.ts` (or wherever `ExtractOptions`/stage option types live — note `ExtractOptions` is declared inline in `extractStage.ts:30-37`), `src/server/services/kbBuilder/extractStage.ts`, `src/server/services/kbBuilderService.ts`
- Test: append to `tests/diagnostics-stream.test.ts`

- [ ] **Step 1: Write the failing test** (append; deterministic model → no LLM needed)

```ts
import { mkdirSync as mkd, writeFileSync as wf } from "node:fs";
import { runExtractStage } from "../src/server/services/kbBuilder/extractStage";
import { loadWikiSpecs } from "../src/server/services/kbBuilder/specs";

describe("runExtractStage onProgress", () => {
  it("invokes onProgress once per parsed document", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "kh-extract-"));
    // minimal specs with a 'concept' page type (deterministicFallback returns type 'concept')
    const specDir = path.join(ws, "processed", "wiki_specs");
    mkd(specDir, { recursive: true });
    wf(path.join(specDir, "manifest.json"), JSON.stringify({ page_types: { concept: { dir: "concepts", template: "concept.md" } }, entity_types: [], relation_types: [] }));
    wf(path.join(specDir, "concept.md"), "## Overview\n");
    const parsed = path.join(ws, "processed", "parsed");
    mkd(parsed, { recursive: true });
    wf(path.join(parsed, "a.md"), "# A\nbody");
    wf(path.join(parsed, "b.md"), "# B\nbody");

    const specs = loadWikiSpecs(specDir);
    const messages: string[] = [];
    await runExtractStage({
      dataDir: ws, specs, model: "deterministic", force: true, only: null,
      onProgress: (info) => messages.push(info.message),
    });
    expect(messages.length).toBe(2);
    rmSync(ws, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/diagnostics-stream.test.ts -t "onProgress"`
Expected: FAIL — `onProgress` not in options type / never called.

- [ ] **Step 3: Add `onProgress` to the extract options and call it per document.**

In `src/server/services/kbBuilder/extractStage.ts`, extend the `ExtractOptions` type (lines 30-37):
```ts
type ExtractOptions = {
  dataDir: string;
  specs: WikiSpecSet;
  model: string;
  modelConfig?: PipelineModelConfig;
  force: boolean;
  only: string | null;
  onProgress?: (info: { message: string; index: number; total: number }) => void;
};
```

In `runExtractStage`, change the loop (around lines 54-80) to be indexed and emit progress. Replace the `for (const absolute of walkMarkdownFiles(parsedDir))` loop header with:
```ts
  const files = walkMarkdownFiles(parsedDir).filter((absolute) => {
    const rel = relative(parsedDir, absolute).replace(/\\/g, "/");
    return !only || matchesOnlyFilter(rel, only);
  });
  for (let index = 0; index < files.length; index += 1) {
    const absolute = files[index];
    const rel = relative(parsedDir, absolute).replace(/\\/g, "/");
    // (keep the existing body: read file, extractPage, pageType lookup, write wiki+meta)
    // ... existing body unchanged ...
    options.onProgress?.({ message: `extract ${index + 1}/${files.length}: ${rel} → ${extracted.type}`, index, total: files.length });
  }
```
Keep the existing per-file body intact (the `readFileSync` → `extractPage` → `pageType` check → write). Move the `onProgress` call to AFTER `extracted` is computed and the page is written (or after the unknown-type `continue` is skipped — place it right before the loop's end so it reflects the resolved type). Remove the now-duplicated `if (only && !matchesOnlyFilter(...)) continue;` line since filtering moved into `files`.

In `src/server/services/kbBuilderService.ts`, pass `onProgress` when invoking the extract stage (line ~163). Change:
```ts
if (stages.includes("extract")) await this.withStage(runId, options, "extract", async () => runExtractStage({
  dataDir: workspace.dataDir, specs, model: modelName(modelConfig), modelConfig, force: options.force, only: options.only,
  onProgress: (info) => { void this.diagnostics?.write({ traceId: options.traceId, category: "kb_build", status: "event", level: "info", message: info.message, actor: options.requestedBy, entityType: "build_run", entityId: runId, runId, context: { stage: "extract", index: info.index, total: info.total } }); },
}));
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/diagnostics-stream.test.ts -t "onProgress"`
Expected: PASS (2 progress messages).

- [ ] **Step 5: Run full stream test file + typecheck**

Run: `npx vitest run tests/diagnostics-stream.test.ts && npm run typecheck`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/services/kbBuilder/extractStage.ts src/server/services/kbBuilderService.ts tests/diagnostics-stream.test.ts
git commit -m "feat(kb): per-document extract progress events"
```

### Task C4: SSE endpoint

**Files:**
- Modify: `src/server/routes/builder.ts`

- [ ] **Step 1: Add the SSE route.** (Manually verified — `app.inject()` buffers the whole response and cannot consume an open stream, so no automated test for the live socket; the pure pieces are covered by C1/C2.)

Add imports at top of `src/server/routes/builder.ts`:
```ts
import { formatSseFrame } from "../services/sse";
```

Inside `registerBuilderRoutes`, add after the `GET /api/build-runs/:runId` route:
```ts
  app.get<{ Params: { runId: string } }>(
    "/api/build-runs/:runId/stream",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { runId } = request.params;
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      reply.hijack();

      // 1) replay history for this run (ascending), capped
      const history = await ctx.diagnostics.listLogs({ runId, limit: 500 });
      for (const record of history.reverse()) {
        reply.raw.write(formatSseFrame(record));
      }

      // 2) live tail
      const isTerminal = (r: { runId: string; entityType: string; status: string }) =>
        r.runId === runId && r.entityType === "build_run" && (r.status === "completed" || r.status === "failed");
      const unsubscribe = ctx.diagnostics.subscribe((record) => {
        if (record.runId !== runId) return;
        reply.raw.write(formatSseFrame(record));
        if (isTerminal(record)) {
          reply.raw.write(formatSseFrame({ runId }, "end"));
          cleanup();
        }
      });
      const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 15000);
      function cleanup() {
        clearInterval(heartbeat);
        unsubscribe();
        reply.raw.end();
      }
      request.raw.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
    },
  );
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Manual verify** (after a server is running with a build in progress):

```bash
curl -N -H "authorization: Bearer <token>" http://127.0.0.1:4174/api/build-runs/<runId>/stream
```
Expected: replayed history lines, then live `data: {...}` frames as the build progresses, `: ping` heartbeats, and a final `event: end` when the run finishes.

- [ ] **Step 4: Commit**

```bash
git add src/server/routes/builder.ts
git commit -m "feat(kb): SSE endpoint streaming build logs by runId"
```

### Task C5: Frontend stream client

**Files:**
- Create: `src/client/src/api/buildLogs.ts`

- [ ] **Step 1: Implement the fetch+reader SSE parser** (keeps the JWT `Authorization` header, which `EventSource` cannot):

```ts
// src/client/src/api/buildLogs.ts
import { authHeaders } from "./http";

export interface BuildLogRecord {
  logId: string;
  level: string;
  category: string;
  message: string;
  status: string;
  runId: string;
  entityType: string;
  createdAt: string;
}

// Streams diagnostic log records for a run. Returns an AbortController; call .abort() to stop.
export function streamBuildLogs(
  runId: string,
  onRecord: (record: BuildLogRecord) => void,
  onEnd?: () => void,
): AbortController {
  const controller = new AbortController();
  void (async () => {
    try {
      const response = await fetch(`/api/build-runs/${encodeURIComponent(runId)}/stream`, {
        headers: authHeaders(),
        signal: controller.signal,
      });
      if (!response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const isEnd = frame.includes("event: end");
          const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
          if (dataLine) {
            try {
              const parsed = JSON.parse(dataLine.slice("data: ".length));
              if (isEnd) onEnd?.();
              else onRecord(parsed as BuildLogRecord);
            } catch { /* ignore malformed/heartbeat */ }
          }
        }
      }
      onEnd?.();
    } catch (error) {
      if ((error as { name?: string }).name !== "AbortError") onEnd?.();
    }
  })();
  return controller;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/client/src/api/buildLogs.ts
git commit -m "feat(kb): build log stream client (fetch+reader SSE)"
```

### Task C6: Terminal-style console component + mount

**Files:**
- Create: `src/client/src/components/BuildLogConsole.tsx`
- Modify: `src/client/src/pages/KnowledgeBuilder.tsx`, `src/client/src/styles.css`

- [ ] **Step 1: Create the console component**

```tsx
// src/client/src/components/BuildLogConsole.tsx
import { useEffect, useRef, useState } from "react";
import { streamBuildLogs, type BuildLogRecord } from "../api/buildLogs";

export function BuildLogConsole({ runId }: { runId: string }) {
  const [lines, setLines] = useState<BuildLogRecord[]>([]);
  const [live, setLive] = useState(true);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setLines([]);
    setLive(true);
    const controller = streamBuildLogs(
      runId,
      (record) => setLines((current) => [...current.slice(-999), record]),
      () => setLive(false),
    );
    return () => controller.abort();
  }, [runId]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [lines]);

  return (
    <div className="build-console">
      <div className="build-console-head">
        <span>构建日志 · {runId}</span>
        <span className={live ? "live" : "ended"}>{live ? "● live" : "○ ended"}</span>
      </div>
      <div className="build-console-body">
        {lines.map((line) => (
          <div key={line.logId} className={`log-line lvl-${line.level} st-${line.status}`}>
            <span className="log-time">{line.createdAt.slice(11, 19)}</span>
            <span className="log-cat">{line.category}</span>
            <span className="log-msg">{line.message}</span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Mount it in `KnowledgeBuilder.tsx`** in the `runs` tab. Import at top:
```ts
import { BuildLogConsole } from "../components/BuildLogConsole";
```
In the `tab === "runs"` section, render a console for the most relevant run (prefer `activeRunId`, else the newest selected run). Add right after the `<div className="run-list">…</div>` block (after line ~365, still inside the `runs` section):
```tsx
            {(() => {
              const streamRunId = activeRunId ?? selectedRuns[0]?.runId ?? null;
              return streamRunId ? <BuildLogConsole key={streamRunId} runId={streamRunId} /> : null;
            })()}
```

- [ ] **Step 3: Add styles** to `src/client/src/styles.css` (append):
```css
.build-console { margin-top: 16px; border-radius: 8px; overflow: hidden; border: 1px solid #1d2430; }
.build-console-head { display: flex; justify-content: space-between; padding: 6px 12px; background: #11161f; color: #9aa7bd; font-size: 12px; font-family: ui-monospace, monospace; }
.build-console-head .live { color: #34d399; }
.build-console-head .ended { color: #6b7280; }
.build-console-body { background: #0d1117; color: #c8d3e6; font-family: ui-monospace, monospace; font-size: 12px; line-height: 1.5; max-height: 360px; overflow: auto; padding: 8px 12px; }
.log-line { display: flex; gap: 10px; white-space: pre-wrap; }
.log-line .log-time { color: #5b6images678; }
.log-line .log-cat { color: #7aa2f7; min-width: 64px; }
.log-line.lvl-error .log-msg, .log-line.st-failed .log-msg { color: #f87171; }
.log-line.st-completed .log-msg { color: #34d399; }
```
(Fix the `#5b6images678` typo to a valid hex like `#5b667a` when typing — placeholder guard; use `#5b667a`.)

- [ ] **Step 4: Typecheck + manual verify**

Run: `npm run typecheck` → PASS.
Manual: start the app + a real LLM build; on 运行进度 tab watch the console stream `extract 1/18 …`, stage spans, and turn to `○ ended` with a green completion line when done.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/components/BuildLogConsole.tsx src/client/src/pages/KnowledgeBuilder.tsx src/client/src/styles.css
git commit -m "feat(kb): live terminal-style build log console"
```

---

## Self-Review

- **Spec coverage:** (A) nav reorder = Task A1 ✅. (B) file browser = backend method B1 + route B2 + client B3 + tree/viewer UI B4 ✅. (C) SSE live log = event bus C1 + frame formatter C2 + per-doc progress C3 + SSE endpoint C4 + stream client C5 + console UI C6 ✅. The "real-time" requirement for the file viewer = on-click fetch (B4); the "command-line continuous output" = SSE tail + auto-scroll console (C6).
- **Placeholder scan:** one intentional guard noted — the CSS `#5b6images678` is flagged with an explicit fix instruction in C6 Step 3 (use `#5b667a`). No other TBD/TODO.
- **Type consistency:** `getComponentFile` (service) ↔ `getComponentContent` (client) ↔ `ComponentContent` type ↔ route all return `{componentId, kind, legacyPath, storageUri, content, truncated}`. `subscribe(listener)→()=>void`, `formatSseFrame(data, event?)`, `onProgress({message,index,total})`, `streamBuildLogs(runId,onRecord,onEnd)→AbortController`, `BuildLogRecord` fields match what `mapLog` emits (`logId/level/category/message/status/runId/entityType/createdAt`).
- **Caveats to verify during implementation:** confirm `createDatabase`/`buildApp` option shapes against `tests/db.test.ts` and `tests/api.test.ts` and adapt the test scaffolding; confirm the api barrel path (`src/client/src/api/index.ts`) for re-exports; confirm `mapComponent`/`relative` imports exist in `knowledgeQueryService.ts`.
- **DB-reset caveat (operational, not code):** the live DB lost runtime rows during this session's aggressive process-killing. Normal single-server operation persists. After implementation, re-import `knowledge/` and run one build to exercise B + C end-to-end.
