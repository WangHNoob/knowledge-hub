import { nanoid } from "nanoid";

import type { DatabaseHandle, GapFillCandidate, GapFillCandidateStatus } from "../types";
import { emitKnowledgeEvent } from "./eventService";

export function createGapFillCandidateService(db: DatabaseHandle): GapFillCandidateService {
  return new GapFillCandidateService(db);
}

export class GapFillCandidateService {
  private readonly adapter;

  constructor(private readonly db: DatabaseHandle) {
    this.adapter = db.adapter;
  }

  /**
   * Upsert an open gap-fill candidate for untargeted Agent feedback.
   * Never publishes knowledge — only records a controlled "awaiting source" card.
   */
  async upsertFromFeedback(input: {
    projectId: string;
    releaseId: string;
    query: string;
    feedbackType: string;
    expected?: string;
    reason?: string;
  }): Promise<GapFillCandidate> {
    const queryKey = normalizeGapQueryKey(input.query);
    const queryRaw = input.query.trim();
    const now = new Date().toISOString();
    const candidateId = `gap_${nanoid(10)}`;
    const { rows } = await this.adapter.query(
      `INSERT INTO gap_fill_candidates (
         candidate_id, project_id, release_id, query_key, query_raw, feedback_type,
         expected, reason, status, source_bundle_id, source_path, event_count, last_seen_at, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open','','',$9,$10,$10)
       ON CONFLICT (project_id, query_key) DO UPDATE SET
         release_id = EXCLUDED.release_id,
         query_raw = EXCLUDED.query_raw,
         feedback_type = EXCLUDED.feedback_type,
         expected = CASE WHEN EXCLUDED.expected <> '' THEN EXCLUDED.expected ELSE gap_fill_candidates.expected END,
         reason = CASE WHEN EXCLUDED.reason <> '' THEN EXCLUDED.reason ELSE gap_fill_candidates.reason END,
         status = CASE WHEN gap_fill_candidates.status = 'dismissed' THEN 'open' ELSE gap_fill_candidates.status END,
         event_count = gap_fill_candidates.event_count + 1,
         last_seen_at = EXCLUDED.last_seen_at
       RETURNING *`,
      [
        candidateId,
        input.projectId,
        input.releaseId,
        queryKey,
        queryRaw,
        input.feedbackType,
        input.expected ?? "",
        input.reason ?? "",
        1,
        now,
      ],
    );
    const candidate = mapGapFillCandidate(rows[0]);
    if (candidate.eventCount === 1) {
      await emitKnowledgeEvent(this.db, {
        eventType: "gap.fill_candidate_created",
        entityType: "gap_fill_candidate",
        entityId: candidate.candidateId,
        payload: {
          projectId: candidate.projectId,
          candidateId: candidate.candidateId,
          queryKey: candidate.queryKey,
          feedbackType: candidate.feedbackType,
        },
      });
    }
    return candidate;
  }

  async listOpen(projectId: string): Promise<GapFillCandidate[]> {
    const { rows } = await this.adapter.query(
      `SELECT * FROM gap_fill_candidates
       WHERE project_id = $1 AND status = 'open'
       ORDER BY event_count DESC, last_seen_at DESC
       LIMIT 50`,
      [projectId],
    );
    return rows.map(mapGapFillCandidate);
  }

  async linkSource(input: {
    projectId: string;
    candidateId: string;
    sourceBundleId: string;
    sourcePath?: string;
    linkedBy: string;
  }): Promise<GapFillCandidate | null> {
    const now = new Date().toISOString();
    const { rows } = await this.adapter.query(
      `UPDATE gap_fill_candidates
       SET status = 'source_linked',
           source_bundle_id = $3,
           source_path = $4,
           last_seen_at = $5
       WHERE project_id = $1 AND candidate_id = $2 AND status = 'open'
       RETURNING *`,
      [input.projectId, input.candidateId, input.sourceBundleId, input.sourcePath ?? "", now],
    );
    if (!rows.length) return null;
    const candidate = mapGapFillCandidate(rows[0]);
    await emitKnowledgeEvent(this.db, {
      eventType: "gap.fill_candidate_linked",
      entityType: "gap_fill_candidate",
      entityId: candidate.candidateId,
      payload: {
        projectId: input.projectId,
        candidateId: candidate.candidateId,
        sourceBundleId: input.sourceBundleId,
        sourcePath: input.sourcePath ?? "",
        linkedBy: input.linkedBy,
      },
    });
    return candidate;
  }

  async dismiss(input: { projectId: string; candidateId: string }): Promise<GapFillCandidate | null> {
    const { rows } = await this.adapter.query(
      `UPDATE gap_fill_candidates
       SET status = 'dismissed', last_seen_at = $3
       WHERE project_id = $1 AND candidate_id = $2 AND status IN ('open', 'source_linked')
       RETURNING *`,
      [input.projectId, input.candidateId, new Date().toISOString()],
    );
    return rows.length ? mapGapFillCandidate(rows[0]) : null;
  }

  async countOpen(projectId: string): Promise<number> {
    const { rows } = await this.adapter.query(
      `SELECT COUNT(*)::int AS c FROM gap_fill_candidates WHERE project_id = $1 AND status = 'open'`,
      [projectId],
    );
    return Number(rows[0]?.c ?? 0);
  }
}

export function normalizeGapQueryKey(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 400) || "empty";
}

function mapGapFillCandidate(row: Record<string, unknown>): GapFillCandidate {
  return {
    candidateId: String(row.candidate_id),
    projectId: String(row.project_id ?? ""),
    releaseId: String(row.release_id ?? ""),
    queryKey: String(row.query_key ?? ""),
    queryRaw: String(row.query_raw ?? ""),
    feedbackType: String(row.feedback_type ?? ""),
    expected: String(row.expected ?? ""),
    reason: String(row.reason ?? ""),
    status: String(row.status ?? "open") as GapFillCandidateStatus,
    sourceBundleId: String(row.source_bundle_id ?? ""),
    sourcePath: String(row.source_path ?? ""),
    eventCount: Number(row.event_count ?? 0),
    lastSeenAt: String(row.last_seen_at ?? ""),
    createdAt: String(row.created_at ?? ""),
  };
}
