import type { TrustScore } from "../api";
import { formatPercent } from "./format";

export function trustFromQuality(quality: Record<string, unknown>): TrustScore | null {
  const trust = quality.trust;
  if (!trust || typeof trust !== "object" || Array.isArray(trust)) return null;
  const value = trust as Partial<TrustScore>;
  if (typeof value.score !== "number") return null;
  return {
    version: "v2-lite",
    score: value.score,
    status: statusValue(value.status),
    breakdown: {
      evidence: numberValue(value.breakdown?.evidence),
      completeness: numberValue(value.breakdown?.completeness),
      auditFreshness: numberValue(value.breakdown?.auditFreshness),
      consistency: numberValue(value.breakdown?.consistency),
    },
    caps: Array.isArray(value.caps) ? value.caps : [],
    reasons: Array.isArray(value.reasons) ? value.reasons.map(String) : [],
    lastTrustedAuditAt: typeof value.lastTrustedAuditAt === "string" ? value.lastTrustedAuditAt : null,
    auditHalfLifeDays: typeof value.auditHalfLifeDays === "number" ? value.auditHalfLifeDays : 180,
    evidenceRequired: typeof value.evidenceRequired === "boolean" ? value.evidenceRequired : true,
  };
}

export function trustTone(trust: TrustScore | null): "ok" | "warn" | "hot" {
  if (!trust) return "warn";
  if (trust.score < 0.55 || trust.status === "blocked") return "hot";
  if (trust.score < 0.85 || trust.caps.length > 0) return "warn";
  return "ok";
}

export function trustLabel(trust: TrustScore | null): string {
  return trust ? `可信度 ${formatPercent(trust.score)}` : "可信度 n/a";
}

export function trustStatusLabel(status: TrustScore["status"]): string {
  if (status === "trusted") return "可信";
  if (status === "usable_with_risk") return "可用有风险";
  if (status === "needs_review") return "需复核";
  return "阻塞";
}

export const TRUST_DIMENSIONS: Array<{ key: keyof TrustScore["breakdown"]; label: string }> = [
  { key: "evidence", label: "证据" },
  { key: "completeness", label: "全面" },
  { key: "auditFreshness", label: "审计时效" },
  { key: "consistency", label: "一致" },
];

function statusValue(value: unknown): TrustScore["status"] {
  return value === "trusted" || value === "usable_with_risk" || value === "needs_review" || value === "blocked" ? value : "needs_review";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
