import { useCallback, useEffect, useState } from "react";

import { getJson, currentRole } from "../api/http";

export type UiMode = "simple" | "full";

const STORAGE_KEY = "kh_ui_mode_override";

interface UiConfigResponse {
  uiMode: UiMode;
  publishRelaxed: boolean;
  svnSyncEnabled: boolean;
  brand: { title: string; subtitle: string };
}

let cachedConfig: UiConfigResponse | null = null;

export async function fetchUiConfig(): Promise<UiConfigResponse> {
  const data = await getJson<UiConfigResponse>("/api/ui-config");
  cachedConfig = data;
  return data;
}

export function getCachedUiConfig(): UiConfigResponse | null {
  return cachedConfig;
}

export function resolveUiMode(serverMode: UiMode = "simple"): UiMode {
  const override = localStorage.getItem(STORAGE_KEY);
  if (override === "full" || override === "simple") return override;
  return serverMode;
}

export function setUiModeOverride(mode: UiMode | null): void {
  if (!mode) localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, mode);
}

export function useUiMode() {
  const [serverMode, setServerMode] = useState<UiMode>("simple");
  const [svnSyncEnabled, setSvnSyncEnabled] = useState(false);
  const [brandSubtitle, setBrandSubtitle] = useState("内网知识库");
  const [mode, setMode] = useState<UiMode>(() => resolveUiMode("simple"));

  useEffect(() => {
    let cancelled = false;
    fetchUiConfig()
      .then((cfg) => {
        if (cancelled) return;
        setServerMode(cfg.uiMode);
        setSvnSyncEnabled(cfg.svnSyncEnabled);
        setBrandSubtitle(cfg.brand.subtitle);
        setMode(resolveUiMode(cfg.uiMode));
      })
      .catch(() => {
        if (!cancelled) setMode(resolveUiMode("simple"));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleFullMode = useCallback(() => {
    const role = currentRole();
    if (role !== "admin") return;
    const next = mode === "simple" ? "full" : "simple";
    setUiModeOverride(next === serverMode ? null : next);
    setMode(next);
  }, [mode, serverMode]);

  return {
    mode,
    isSimple: mode === "simple",
    svnSyncEnabled,
    brandSubtitle,
    canToggleFull: currentRole() === "admin",
    toggleFullMode,
  };
}
