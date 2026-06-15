import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("Tauri configuration", () => {
  it("does not provide an object config for the dialog plugin", () => {
    const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")) as {
      plugins?: Record<string, unknown>;
    };

    expect(config.plugins?.dialog).toBeUndefined();
  });

  it("does not use legacy shell plugin scope configuration", () => {
    const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")) as {
      plugins?: Record<string, unknown>;
    };

    expect(config.plugins?.shell).toBeUndefined();
  });
});
