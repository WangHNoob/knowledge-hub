import { describe, expect, it } from "vitest";

import { createLegislationService } from "../src/server/services/legislationService";
import { createTestDb } from "./helpers/testDb";

describe("LegislationService", () => {
  it("seeds a deterministic default profile and versions activated updates", async () => {
    const { db, cleanup } = await createTestDb();
    try {
      const service = createLegislationService(db);

      const first = await service.getActiveProfile();
      const second = await service.getActiveProfile();
      expect(first.profileId).toBe("default");
      expect(first.active).toBe(true);
      expect(first.hash).toBe(second.hash);
      expect(first.config.pageTypes.system.requiredSections).toContain("Overview");
      expect(first.config.entityTypes.some((item) => item.id === "system")).toBe(true);
      expect(first.config.relationTypes.some((item) => item.id === "configured_in")).toBe(true);

      const created = await service.createProfile({
        name: "Combat rules",
        config: {
          ...first.config,
          entityTypes: [...first.config.entityTypes, { id: "buff", label: "Buff", publishable: true }],
        },
        createdBy: "admin",
        activate: false,
      });
      expect(created.active).toBe(false);
      expect((await service.getActiveProfile()).profileId).toBe("default");

      const activated = await service.activateProfile(created.profileId, "lead");
      expect(activated.active).toBe(true);
      expect(activated.hash).not.toBe(first.hash);
      expect((await service.getActiveProfile()).profileId).toBe(created.profileId);
    } finally {
      await cleanup();
    }
  }, 15000);
});
