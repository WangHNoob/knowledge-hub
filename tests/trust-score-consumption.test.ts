import { describe, expect, it } from "vitest";

import { computeTrustScore, consumptionScore, type ConsumptionStats } from "../src/server/services/trustScore";

const baseComponent = {
  artifactId: "wiki/Combat",
  kind: "wiki_page",
  legacyPath: "systems/combat.md",
  quality: { wikiSpecScore: 0.8 },
  sourceRefs: ["src/combat.md"],
};

const now = "2026-08-13T00:00:00.000Z";

describe("trust consumption dimension (flywheel 02-P4)", () => {
  it("consumptionScore stays neutral without consumption data", () => {
    const stats: ConsumptionStats = { attributionCount: 0, searchCount: 0, clickCount: 0, negativeFeedbackCount: 0 };
    expect(consumptionScore(stats)).toBe(0.5);
  });

  it("consumptionScore rewards attribution and post-search clicks, penalizes negative feedback", () => {
    const good: ConsumptionStats = { attributionCount: 3, searchCount: 10, clickCount: 6, negativeFeedbackCount: 0 };
    expect(consumptionScore(good)).toBeCloseTo(1, 5); // 0.5 + 0.5 + 0.5*1(点击率 0.6*2=1.2→1)

    const punished: ConsumptionStats = { attributionCount: 0, searchCount: 5, clickCount: 0, negativeFeedbackCount: 4 };
    expect(consumptionScore(punished)).toBeCloseTo(0.05, 5); // 0.5 - 0.15*3(封顶)

    const partial: ConsumptionStats = { attributionCount: 0, searchCount: 10, clickCount: 2, negativeFeedbackCount: 1 };
    expect(consumptionScore(partial)).toBeCloseTo(0.5 + 0.5 * Math.min(1, 2 * 0.2) - 0.15, 5);
  });

  it("computeTrustScore without consumption keeps v2-lite behavior", () => {
    const v2 = computeTrustScore({ component: baseComponent, now, lastTrustedAuditAt: now });
    expect(v2.version).toBe("v2-lite");
    expect(v2.breakdown.consumption).toBeUndefined();
  });

  it("computeTrustScore with consumption switches to v3-consumption and moves the score", () => {
    const withGood = computeTrustScore({ component: baseComponent, now, lastTrustedAuditAt: now, consumption: 1 });
    expect(withGood.version).toBe("v3-consumption");
    expect(withGood.breakdown.consumption).toBe(1);
    const v2 = computeTrustScore({ component: baseComponent, now, lastTrustedAuditAt: now });
    expect(withGood.score).toBeGreaterThan(v2.score);

    const withBad = computeTrustScore({ component: baseComponent, now, lastTrustedAuditAt: now, consumption: 0 });
    expect(withBad.version).toBe("v3-consumption");
    expect(withBad.score).toBeLessThan(v2.score);
    expect(withBad.reasons.join(" ")).toContain("消费认可度");
  });

  it("clamps out-of-range consumption values", () => {
    const clamped = computeTrustScore({ component: baseComponent, now, lastTrustedAuditAt: now, consumption: 5 });
    expect(clamped.breakdown.consumption).toBe(1);
  });
});
