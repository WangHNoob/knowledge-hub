import { describe, expect, it } from "vitest";

import { shouldAutoPublishByMode } from "../src/server/services/releaseAutomationService";

describe("auto publish mode (flywheel 02-P3)", () => {
  it("off disables revision auto-publish regardless of legacy boolean", async () => {
    expect(await shouldAutoPublishByMode("off", "p1")).toBe(false);
    // 兼容旧布尔：false 等价 off
    expect(await shouldAutoPublishByMode(undefined, "p1")).toBe(true); // 默认 revisions
  });

  it("revisions (default) enables revision auto-publish", async () => {
    expect(await shouldAutoPublishByMode("revisions", "p1")).toBe(true);
    expect(await shouldAutoPublishByMode(undefined, "p1")).toBe(true);
  });

  it("revisions_and_new enables auto-publish", async () => {
    expect(await shouldAutoPublishByMode("revisions_and_new", "p1")).toBe(true);
  });

  it("supports per-project resolver functions", async () => {
    const byProject = async (projectId: string) => (projectId === "strict" ? "off" : "revisions");
    expect(await shouldAutoPublishByMode(byProject, "strict")).toBe(false);
    expect(await shouldAutoPublishByMode(byProject, "default_project")).toBe(true);
  });
});
