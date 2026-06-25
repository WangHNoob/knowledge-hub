import { describe, expect, it } from "vitest";

import { computeTrustScore, getTrustPolicy } from "../src/server/services/trustScore";

describe("computeTrustScore", () => {
  it("exposes the same trust policy used by score calculation", () => {
    const policy = getTrustPolicy();

    expect(policy.version).toBe("v2-lite");
    expect(policy.editable).toBe(false);
    expect(policy.dimensions.map((dimension) => dimension.key)).toEqual(["evidence", "completeness", "auditFreshness", "consistency"]);
    expect(policy.dimensions.reduce((sum, dimension) => sum + dimension.weight, 0)).toBeCloseTo(1);
    expect(policy.caps.map((cap) => cap.id)).toContain("pending_audit");
  });

  it("keeps newly ingested but unaudited knowledge below the audit cap", () => {
    const trust = computeTrustScore({
      component: {
        artifactId: "wiki/systems/battle.md",
        kind: "wiki_page",
        legacyPath: "wiki/systems/battle.md",
        quality: { completenessScore: 0.95 },
        sourceRefs: ["gamedocs/battle.md"],
      },
      evidenceRows: [{ sourceVersionId: "src_1", quote: "battle rule source quote", confidence: 0.95 }],
      now: "2026-06-24T00:00:00.000Z",
    });

    expect(trust.score).toBeLessThanOrEqual(0.7);
    expect(trust.caps.map((cap) => cap.id)).toContain("pending_audit");
    expect(trust.breakdown.auditFreshness).toBe(0.45);
  });

  it("uses lastTrustedAuditAt as the freshness clock after the flywheel audit", () => {
    const trust = computeTrustScore({
      component: {
        artifactId: "wiki/activities/pvp.md",
        kind: "wiki_page",
        legacyPath: "wiki/activities/pvp.md",
        quality: { completenessScore: 0.9 },
        sourceRefs: ["gamedocs/pvp.md"],
      },
      evidenceRows: [{ sourceVersionId: "src_1", quote: "pvp activity open condition", confidence: 0.9 }],
      now: "2026-06-24T00:00:00.000Z",
      lastTrustedAuditAt: "2026-06-24T00:00:00.000Z",
    });

    expect(trust.breakdown.auditFreshness).toBe(1);
    expect(trust.score).toBeGreaterThanOrEqual(0.85);
    expect(trust.status).toBe("trusted");
  });

  it("caps low-completeness knowledge even when evidence exists", () => {
    const trust = computeTrustScore({
      component: {
        artifactId: "wiki/systems/battle.md",
        kind: "wiki_page",
        legacyPath: "wiki/systems/battle.md",
        quality: { completenessScore: 0.42 },
        sourceRefs: ["gamedocs/battle.md"],
      },
      evidenceRows: [{ sourceVersionId: "src_1", quote: "battle rule source quote", confidence: 0.95 }],
      now: "2026-06-24T00:00:00.000Z",
      lastTrustedAuditAt: "2026-06-24T00:00:00.000Z",
    });

    expect(trust.score).toBeLessThanOrEqual(0.65);
    expect(trust.caps.map((cap) => cap.id)).toContain("incomplete_spec");
  });
});
