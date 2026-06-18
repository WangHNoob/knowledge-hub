import { createContext, useContext } from "react";
import type { ReactNode } from "react";

export type View =
  | "dashboard"
  | "sources"
  | "builder"
  | "legislation"
  | "assets"
  | "review"
  | "release"
  | "agent"
  | "diagnostics"
  | "maintenance"
  | "storage";

export interface NavParams {
  packageId?: string;
  componentId?: string;
  runId?: string;
  versionId?: string;
  releaseId?: string;
  severity?: string;
}

export interface NavContextValue {
  navigate: (view: View, params?: NavParams) => void;
  params: NavParams;
}

const NavContext = createContext<NavContextValue | null>(null);

export function NavProvider({ value, children }: { value: NavContextValue; children: ReactNode }) {
  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}

export function useNav(): NavContextValue {
  const ctx = useContext(NavContext);
  if (!ctx) throw new Error("useNav must be used within a NavProvider");
  return ctx;
}

/**
 * Renders an internal ID as a small chip. When `onClick` is provided it becomes a
 * clickable cross-navigation link; otherwise it is a plain monospace label.
 */
export function IdChip({ label, title, onClick }: { label: string; title?: string; onClick?: () => void }) {
  if (!onClick) return <code className="id-chip">{label}</code>;
  return (
    <button type="button" className="id-chip clickable" title={title ?? label} onClick={onClick}>
      {label}
    </button>
  );
}
