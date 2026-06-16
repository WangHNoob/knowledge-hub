import { describe, expect, it } from "vitest";

import { createAttributionAuditService } from "../src/server/services/attributionAuditService";
import { createTestDb } from "./helpers/testDb";

describe("AttributionAuditService", () => {
  it("classifies output segments from explicit trace and persists the audit", async () => {
    const { db, cleanup } = await createTestDb();
    try {
      const service = createAttributionAuditService(db);
      const audit = await service.createAudit({
        releaseId: "rel_demo",
        createdBy: "admin",
        title: "Battle design output",
        segments: [
          {
            text: "Battle System uses Skill table.",
            trace: { componentIds: ["cmp_page"], sourceVersionIds: ["ver_1"], evidenceIds: ["ev_1"] }
          },
          {
            text: "Therefore stamina pacing should stay slow.",
            trace: { componentIds: ["cmp_page"], sourceVersionIds: ["ver_1"], evidenceIds: [] },
            derivedFrom: ["cmp_page"]
          },
          {
            text: "Add a new combo burst mode.",
            trace: { componentIds: [], sourceVersionIds: [], evidenceIds: [] }
          }
        ]
      });

      expect(audit.segments.map((segment) => segment.attributionType)).toEqual(["引用", "推导", "创作"]);
      expect(audit.segments[2].risk).toContain("没有知识库依据");

      const listed = await service.listAudits();
      expect(listed[0].auditId).toBe(audit.auditId);
      expect(listed[0].segments).toHaveLength(3);
    } finally {
      await cleanup();
    }
  }, 15000);
});
