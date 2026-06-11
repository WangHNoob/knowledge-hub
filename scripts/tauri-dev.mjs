import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

export function cargoBinPath() {
  return join(homedir(), ".cargo", "bin");
}

export function pathEnvKey(env = process.env) {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

export function withCargoPath(env = process.env) {
  const nextEnv = { ...env };
  const key = pathEnvKey(nextEnv);
  const cargoBin = cargoBinPath();
  const current = nextEnv[key] ?? "";
  const entries = current
    .split(delimiter)
    .filter(Boolean)
    .filter((entry) => entry.toLowerCase() !== cargoBin.toLowerCase());

  nextEnv[key] = [cargoBin, ...entries].join(delimiter);
  return nextEnv;
}

export function tauriDevSpawnConfig(env = process.env) {
  return {
    command: "npm run tauri -- dev",
    args: [],
    options: {
      shell: true,
      stdio: "inherit",
      env: withCargoPath(env)
    }
  };
}

export function runTauriDev(env = process.env) {
  const { command, args, options } = tauriDevSpawnConfig(env);
  const child = spawn(command, args, {
    stdio: "inherit",
    ...options
  });

  child.on("error", (error) => {
    console.error(error);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTauriDev();
}
