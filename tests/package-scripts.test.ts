import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("package scripts", () => {
  it("starts Tauri after the backend health check succeeds", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts["tauri:dev"]).toContain("wait-on http://127.0.0.1:4174/api/health &&");
    expect(pkg.scripts["tauri:dev"]).toContain("node scripts/tauri-dev.mjs");
    expect(pkg.scripts["tauri:dev"]).not.toContain("|| true &&");
  });

  it("builds Tauri through the Cargo path wrapper", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts["tauri:build"]).toBe("npm run build && node scripts/tauri-dev.mjs build");
  });

  it("prepends the Cargo bin directory before launching Tauri", async () => {
    const moduleUrl = new URL("../scripts/tauri-dev.mjs", import.meta.url).href;
    const { tauriBuildSpawnConfig, tauriDevSpawnConfig, withCargoPath } = await import(moduleUrl) as {
      tauriBuildSpawnConfig(env: Record<string, string>): {
        command: string;
        args: string[];
        options: { shell: boolean; env: Record<string, string> };
      };
      tauriDevSpawnConfig(env: Record<string, string>): {
        command: string;
        args: string[];
        options: { shell: boolean; env: Record<string, string> };
      };
      withCargoPath(env: Record<string, string>): Record<string, string>;
    };

    const env = withCargoPath({ PATH: "C:\\Windows\\System32" });

    expect(env.PATH?.split(";")[0]).toBe(join(homedir(), ".cargo", "bin"));

    const spawnConfig = tauriDevSpawnConfig({ PATH: "C:\\Windows\\System32" });
    expect(spawnConfig.command).toBe("npm run tauri -- dev");
    expect(spawnConfig.args).toEqual([]);
    expect(spawnConfig.options.shell).toBe(true);

    const buildSpawnConfig = tauriBuildSpawnConfig({ PATH: "C:\\Windows\\System32" });
    expect(buildSpawnConfig.command).toBe("npm run tauri -- build");
    expect(buildSpawnConfig.args).toEqual([]);
    expect(buildSpawnConfig.options.shell).toBe(true);
    expect(buildSpawnConfig.options.env.PATH?.split(";")[0]).toBe(join(homedir(), ".cargo", "bin"));
  });
});
