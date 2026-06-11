# KB Builder Pipeline Migration and Quality Gates Design

Date: 2026-06-11

## Purpose

Implement the knowledge asset construction flow in Knowledge Hub by migrating the existing `D:\projects\knowledge` kb-builder pipeline semantics into this product.

The old project's core contract must remain intact:

```text
gamedocs/ + gamedata/
  -> convert
  -> extract
  -> tables
  -> graph
  -> viz
  -> data/wiki + processed + table_schemas
```

In Knowledge Hub, one completed kb-builder pipeline run becomes one knowledge asset package. Knowledge Hub adds source immutability, run traceability, quality gates, review tasks, administrator-controlled gate profiles, and later release governance.

## Current Gap

The current app can import raw material directories into `source_bundle_versions`, and it can list manually/legacy-created `asset_packages`. It does not have a module that consumes a source bundle version through the kb-builder pipeline and registers the generated wiki, index, graph, table schemas, evidence, and quality findings as one governed knowledge asset package.

## Design Decisions

### One Pipeline Run Equals One Asset Package

The primary unit is not an individual source file. The primary unit is a complete pipeline output.

```text
SourceBundleVersion
  -> KnowledgeBuildRun
  -> AssetPackage(kind=kb_builder_pipeline)
  -> AssetComponents(mirror pipeline outputs)
  -> EvidenceRecords
  -> ReviewTasks
```

The asset package represents the full generated knowledge base snapshot from one run.

### Preserve Old Pipeline Semantics

The migrated pipeline must preserve these stages and outputs:

| Stage | Old output | Knowledge Hub component kind |
|---|---|---|
| `convert` | `processed/parsed/*.md` | `processed_doc` |
| `extract` | `wiki/{systems,activities,tables,numerical,combat,ui_flows,resources,progressions}/*.md` | `wiki_page` |
| `extract` | `wiki/_meta/*.json` | `extract_meta` |
| `tables` | `table_schemas/*.json` | `table_schema_json` |
| `tables` | `wiki/_tables/{schemas,groups,table_fk_registry}.json` | `table_registry` |
| `tables` | `wiki/tables/*.md` | `table_wiki_page` |
| `graph` | `wiki/graph.json` | `graph_snapshot` |
| `graph` | `wiki/index.md` | `topic_index` |
| `viz` | `wiki/graph.html` | `graph_view` |
| quality gate | generated report | `quality_report` |

Components are pipeline artifacts, not source files. Source files remain evidence and trace inputs.

### Pipeline Adapter Boundary

The server should introduce a `KbBuilderPipelineService` with an adapter boundary:

```text
materializeSourceVersion(versionId) -> isolated run workspace
copy wiki_specs/profile config
execute stages
collect outputs
run quality gate
register package/components/evidence/tasks
```

The first implementation can execute a vendored or configured kb-builder runner as a subprocess to preserve old behavior. The rest of Knowledge Hub must treat it as an adapter so future implementations can port stages to TypeScript or replace the runner without changing the product workflow.

## Data Model

### Build Run

Add a build run record to trace how a package was created:

```text
knowledge_build_runs
  run_id
  source_version_id
  package_id
  adapter
  stages
  model
  wiki_specs_hash
  quality_profile_id
  status
  started_at
  finished_at
  error
  output_uri
  config_json
```

The `created_by_run_id` field on `asset_packages` points to `run_id`.

### Quality Gate Profile

Add an administrator-editable active profile:

```text
quality_gate_profiles
  profile_id
  name
  active
  config_json
  created_by
  updated_at
```

Profile config uses rule toggles and thresholds, not a free-form rule language.

Example:

```json
{
  "minPackageScore": 0.75,
  "rules": {
    "wikiSpecCompleteness": { "enabled": true, "severity": "blocking", "minScore": 0.75 },
    "requiredFacts": { "enabled": true, "severity": "warning", "minScore": 0.70 },
    "frontmatterSource": { "enabled": true, "severity": "blocking" },
    "metaWikiSync": { "enabled": true, "severity": "blocking" },
    "tableRegistryConsistency": { "enabled": true, "severity": "warning", "minScore": 0.90 },
    "graphIntegrity": { "enabled": true, "severity": "blocking", "minScore": 0.70 },
    "indexCoverage": { "enabled": true, "severity": "warning", "minScore": 0.90 },
    "conceptOveruse": { "enabled": true, "severity": "warning", "maxRatio": 0.35 }
  }
}
```

Only administrators can update the active profile. Developers and viewers can read the active profile and quality reports.

## Quality Engineering

Quality gates are applied after the kb-builder stages finish and before the asset package is marked publishable. They create:

- component-level `quality` objects
- package-level `quality_summary`
- `review_tasks` for blocking and warning findings
- a `quality_report` component in the package

### Wiki Spec Completeness

This is required in the first implementation.

For each generated wiki page:

1. Read `type` from frontmatter.
2. Resolve the matching spec from the run's `processed/wiki_specs` or framework `templates/wiki_specs`.
3. Parse required H2 sections from the spec's section structure.
4. Parse required facts keys from the spec's facts table.
5. Compare the generated markdown and `_meta/*.json` facts.

Score:

```text
structure_score = required H2 sections present / required H2 sections
facts_score = required facts keys present / required facts keys
empty_section_score = 1 - empty required section penalty
wiki_spec_score = structure_score * 0.45
                + facts_score * 0.35
                + empty_section_score * 0.20
```

Missing critical sections or required facts lowers the component confidence. Depending on the quality profile, the finding becomes blocking or warning.

### Frontmatter and Source Traceability

Each wiki page must include:

- `type`
- `title`
- `source`

Checks:

- `type` exists in `manifest.json`.
- page path matches manifest `page_types[type].dir`.
- `source` maps to a `source_files.logical_path` in the source version.
- `_meta.source` matches wiki frontmatter `source`.
- `_meta.wiki_path` points to the actual generated wiki page.

### Extraction Metadata Quality

For each `_meta/*.json`:

- no `error`
- valid `page_type`
- title entity exists
- entity types are known
- relationship types are known
- relationship endpoints exist in entities
- no duplicate entities
- no self-loop relationships
- facts exist when required by spec

The old design already describes extraction confidence fields, but the current old pipeline does not consistently produce them. First implementation should support missing confidence by assigning conservative defaults and generating a warning.

### Table and Field Quality

For `gamedata` and table outputs:

- every `table_schemas/*.json` table appears in `wiki/_tables/schemas.json`
- every `groups.json` table exists in schemas
- every FK registry target exists
- every `wiki/tables/*.md` page matches its group membership and field counts
- generated table wiki pages have valid `table_schema` frontmatter

For precision table editing, Knowledge Hub should add a deterministic table/field graph layer:

```text
table -> has_field -> field
field -> fk_to -> table
field -> has_enum -> enum_value
system/activity -> configured_in -> table
system/activity -> configured_by_field -> field
```

This layer must be generated from table registries and schemas, not by free-form LLM output.

### Index and Graph Quality

Checks:

- `wiki/graph.json` exists and parses.
- graph nodes have valid types.
- graph edges have valid relation types.
- no dangling edges.
- duplicate/self-loop edges are flagged.
- node `wiki_page` paths exist when present.
- `wiki/index.md` exists and links to existing pages.
- index coverage over graph nodes meets threshold.

The old project currently has a mismatch: `manifest.json` defines eight page types, while `graph_builder.py` has a five-type `PAGE_TYPE_DIRS` map. The migrated pipeline must either patch this map or make the quality gate fail/warn when manifest page types are not included in graph/index scanning.

### Concept Overuse and Graph Semantics

The current semantic graph types are acceptable for high-level planning:

```text
system, activity, table, resource, attribute, concept, ui_element, progression
```

The current relations are acceptable for knowledge lookup and plan generation:

```text
depends_on, unlocks, configured_in, produces, consumes, belongs_to, references
```

However, `concept` is broad and can become a catch-all. The quality gate should flag:

- excessive `concept` ratio
- isolated concept nodes
- concepts with no source-backed relationship
- table entities not found in registry
- `configured_in` targets that are not real tables

## API Surface

### Build Pipeline

```text
POST /api/source-bundles/:bundleId/versions/:versionId/build
```

Request:

```json
{
  "stages": ["convert", "extract", "tables", "graph", "viz"],
  "model": "deepseek/deepseek-chat",
  "force": false,
  "only": null,
  "qualityProfileId": "default"
}
```

Response:

```json
{
  "run": { "runId": "...", "status": "completed" },
  "package": { "packageId": "...", "status": "draft" },
  "qualitySummary": {
    "overallScore": 0.82,
    "blockingCount": 0,
    "warningCount": 12
  }
}
```

### Quality Profile

```text
GET /api/quality-gate/profile
PUT /api/quality-gate/profile
```

`PUT` requires `admin`.

### Build Runs

```text
GET /api/build-runs
GET /api/build-runs/:runId
```

## Frontend

### Source Version Detail

Add a "Build Knowledge Asset Package" action to the selected source version detail.

The panel shows:

- source version identity
- file count and categories
- selected quality profile
- selected stages
- model
- force/only options
- build status

After success, navigate to the generated package detail.

### Asset Package Detail

Show package as a structured output of the old pipeline:

- pipeline run summary
- component groups: processed docs, wiki pages, meta, tables, graph, index, visualization, quality report
- source trace and evidence coverage
- quality score and findings
- review tasks

### Admin Quality Gate

Only administrators can edit:

- active profile thresholds
- rule enabled/disabled
- severity level for each rule

Non-admin users see a read-only summary.

## Error Handling

- If source materialization fails, create a failed build run and no package.
- If pipeline subprocess fails, store stderr/stdout in the run error/output log and create no package unless outputs are explicitly recoverable.
- If pipeline succeeds but quality gate has blocking findings, create the package with status `draft` and review tasks; do not mark it publishable.
- If quality gate itself fails, mark run failed because trust cannot be established.

## Testing Strategy

Use TDD for implementation.

Required tests:

- Source version materialization preserves `gamedocs/` and `gamedata/` logical paths.
- A mocked kb-builder output tree registers exactly one package.
- Pipeline output files register correct component groups/kinds.
- Wiki spec completeness detects missing required sections.
- Required facts completeness detects missing facts keys.
- Frontmatter source check fails when a page source cannot map to `source_files`.
- Table registry checks detect missing table references.
- Graph checks detect dangling edges and invalid relation types.
- Admin can update quality profile; non-admin cannot.
- Build API returns package and quality summary.

## Non-Goals

- Do not rewrite kb-builder semantics in the first version.
- Do not introduce a custom free-form rule language.
- Do not require LLM confidence fields before the old extractor consistently emits them.
- Do not publish packages automatically.
- Do not let Agent consume draft packages.

## Open Implementation Notes

- The old pipeline should be vendored or configured as an adapter. The product-facing contract must be stable even if the runner changes.
- `wiki_specs` used for a run must be copied into the run workspace and hashed, so quality results can be reproduced.
- Build output should be stored under the app data directory, not in the source import storage directory.
- The generated package should retain the old output tree paths as `legacyPath` or `storageUri` so users can inspect familiar files.
