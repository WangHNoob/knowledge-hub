# Claude Code MCP Loop Test Plan

This document is for a downstream Agent such as Claude Code. The goal is to test the Knowledge Hub knowledge flywheel through MCP only.

Do not read the local database, source code, OKF files, or build artifacts directly. All knowledge access and governance actions must go through Knowledge Hub MCP tools.

## Core Principle

Each loop should verify one full Agent-facing flow:

`query knowledge -> read details -> inspect evidence/trust -> consume table/graph if needed -> report or correct problems -> apply staged correction -> run incremental check -> request publish gate -> inspect status/audit`

The platform is not expected to prove the knowledge is always correct. It must make the knowledge auditable, traceable, governable, and safe for Agent consumption.

## Required Output Format

For every loop, output exactly this structure:

```text
## Loop N - <topic>

Conclusion: pass / partial / fail

Tool chain:
<tool A> -> <tool B> -> <tool C>

Hits:
- Page:
- Table:
- Graph entity:

Trust:
- level:
- evidenceCount:
- sourceRefs:
- lastPublishedAt:
- negativeFeedbackCount:
- lintStatus:
- correctionStatus:
- ruleProfileHash:

Problems found:
- none / specific problem

Governance result:
- correctionId:
- checkRun:
- publishResult:
- skipReason:

Platform fixes needed:
- none / concrete fix suggestion
```

## Loop 0 - Connection And Baseline

Run:

1. `kb_get_flywheel_status`
2. `kb_get_release`
3. `kb_list_pages`
4. `kb_list_tables`
5. `kb_list_entities`

Pass criteria:

- MCP returns the current project and current published release.
- `releaseId`, `version`, `manifestHash`, and `publishedAt` are visible.
- Pages, tables, and graph entities are discoverable, or the tool clearly explains why they are absent.
- Every returned envelope contains `release`, `trace`, and `trust`.
- `trust.summary` exists. `unknown` is acceptable; missing trust fields are not.

Stop and report failure if:

- There is no current release.
- MCP requires direct platform UI interaction before basic querying.
- Project context is ambiguous and no `projectId` or default project is clear.

## Loop 1 - Wiki Knowledge Query

Use 5 real planning topics. Suggested topics:

- 荣耀连战
- 竞技狂欢
- 阵法特权
- PVP 活动
- 奖励 / 商店 / 排行榜 / 体力

For each topic, run:

1. `kb_search`
2. `kb_get_page` for the top relevant hit
3. `kb_get_evidence`
4. `kb_get_quality`
5. `kb_get_page_tables` if the page mentions data dependencies

Pass criteria:

- Search results are understandable by a planner, not only internal component IDs.
- The top hit is relevant to the query.
- The page content and structured dependencies do not contradict each other.
- Evidence and source references are returned when available.
- Low evidence or low trust is visible in `trust.summary`, `qualityFlags`, or the result body.

Fail examples:

- Obvious knowledge exists but MCP returns miss.
- `evidenceCount` is 0 when the page clearly has citations/source refs.
- Data dependencies are in Chinese only when downstream table tools require canonical table names.
- The result is dominated by component IDs and cannot be understood by a planner.

## Loop 2 - Table Consumption

Pick 3 tables from Loop 1 page dependencies or from `kb_list_tables`.

For each table, run:

1. `kb_get_table_schema`
2. `kb_query_table`
3. `kb_validate_table`
4. `kb_get_table_raw` only if exact source layout is needed

Pass criteria:

- Chinese aliases resolve to canonical table names when aliases exist.
- Schema fields are readable.
- Query results return rows or a clear empty result.
- Validation errors are actionable.
- Raw grid is available for exact table reconstruction, but normal table reading should not require it.

Fail examples:

- Alias maps to the wrong table.
- Schema exists but row query cannot access the same table.
- Table dependency in wiki cannot be resolved by table tools.

## Loop 3 - Graph Consumption

Pick 3 entities or topics from wiki pages.

For each topic, run:

1. `kb_resolve_topic`
2. `kb_get_entity`
3. `kb_get_neighbors`
4. `kb_get_relations`

Pass criteria:

- Topic resolution returns page/table/entity candidates.
- Entities link back to relevant wiki or table knowledge.
- Neighbor and relation output is usable for reasoning.
- Missing graph data is explicit, not silently invented.

Fail examples:

- Wiki clearly mentions an entity but graph tools cannot resolve it.
- Relations contradict page dependencies.
- Graph output lacks enough labels to be useful.

## Loop 4 - Feedback Return Flow

Create controlled negative feedback:

1. Query a plausible but absent topic, then call `kb_report_gap`.
2. If a hit is irrelevant, call `kb_report_bad_hit`.
3. If a page seems outdated or contradicted, call `kb_report_stale`.

Then run:

1. `kb_get_flywheel_status`
2. `kb_search` again for the same topic
3. Check whether returned status or audit data reflects the feedback

Pass criteria:

- Feedback records the query and project.
- Feedback can attach to a component when there is a hit.
- The flywheel status reflects pending governance or exception state.
- Feedback does not create unreadable noise such as generic unresolved-query warnings without a concrete next action.

Fail examples:

- Feedback disappears.
- Feedback goes to the wrong project.
- Feedback creates tasks that only say "fix source meta" without explaining the actual user-facing problem.

## Loop 5 - Staged Correction Governance

Choose one low-risk wiki page from Loop 1.

Preferred tool:

1. `kb_govern_flywheel`

Example payload:

```json
{
  "componentId": "<componentId from kb_search>",
  "issue": "Loop test correction: the summary is incomplete or unclear.",
  "suggestion": {
    "field": "summary",
    "value": "This is a staged correction created by MCP loop testing. It must not directly rewrite published assets."
  },
  "confidence": 0.8,
  "check": true,
  "publish": true
}
```

Then run:

1. `kb_get_correction_status`
2. `kb_get_flywheel_status`
3. `kb_get_release`

Pass criteria:

- The correction is created in staged/intermediate state.
- The correction can be applied without requiring consumer/operator capability distinction.
- Incremental check starts or returns a clear reason why it cannot start.
- `publish_if_ready` publishes a new revision only if gates pass.
- If publish is skipped, the skip reason is explicit and actionable.
- Historical published release snapshots are not directly modified.

Acceptable skip reasons:

- `pending_corrections`
- `blocking_tasks`
- `trust_below_threshold`
- `lint_failures`
- `no_changed_components`
- `no_completed_build`
- `no_current_release`

Fail examples:

- Published OKF or release channel is directly mutated without gate output.
- Correction status cannot be tracked.
- Publish fails with a generic error and no actionable reason.
- Scoped correction rebuild removes unrelated wiki groups such as activities or systems.

## Loop 6 - Boundary Test

Ask the Agent to attempt unsafe actions:

- Directly modify a published release.
- Directly rewrite an OKF bundle file.
- Directly switch current release channel.
- Bypass publish gates.

Expected result:

- MCP exposes no tool for direct mutation of published release snapshots.
- Governance must go through correction, scoped check, and publish gate.
- Any skipped publish has an audit event and reason.

Fail examples:

- A tool can directly update or delete published assets.
- The current release channel can be switched without `publish_if_ready` or rollback semantics.
- No audit trail is produced.

## Loop 7 - Multi-Project Isolation

If at least two projects exist, repeat a small query/governance loop with explicit `projectId`.

For project A and project B, run:

1. `kb_get_release`
2. `kb_search`
3. `kb_submit_correction`
4. `kb_get_flywheel_status`

Pass criteria:

- A query in project A does not return project B knowledge.
- A correction in project A does not appear in project B flywheel status.
- Audit and feedback records stay under the correct project.
- Omitting `projectId` uses the server-side current/default project consistently.

Fail examples:

- Cross-project search leakage.
- Corrections or feedback appear in the wrong project.
- Current/default project is inconsistent across tools.

## Final Report

After all loops, provide:

```text
# MCP Loop Test Final Report

Overall result: pass / partial / fail

Passed:
- ...

Failed:
- ...

Highest priority fixes:
1. ...
2. ...
3. ...

Evidence:
- releaseId:
- projectId:
- correctionIds:
- buildRunIds:
- audit observations:

Recommendation:
- Ready for planner trial / needs another fix pass
```

## Stop Conditions

Stop early and report if any of these happen:

- Basic MCP connection or release lookup fails.
- MCP search misses obvious published knowledge repeatedly.
- `trust.summary` is missing from normal query envelopes.
- Evidence/source refs are clearly present but MCP reports zero.
- Corrections can be submitted but cannot be tracked.
- Publish skip reasons are generic or unactionable.
- Project data leaks across projects.
- The flow requires repeated manual platform UI actions for normal Agent-driven governance.
