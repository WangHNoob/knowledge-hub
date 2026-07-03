import type { ReactNode } from "react";

/**
 * Shared "next step" strip shown at the top of flywheel-aware pages.
 *
 * Replaces BuilderWorkbenchContext (KnowledgeBuilder.tsx),
 * ReviewWorkbenchContext (Review.tsx), and ReleaseWorkbenchContext
 * (Release.tsx) — all three rendered the same pattern: a kicker label,
 * headline, summary, and 1-3 action buttons derived from the workbench.
 */
export function WorkbenchStrip({
  kicker,
  headline,
  summary,
  focused = false,
  actions,
  className,
}: {
  kicker: string;
  headline: string;
  summary: string;
  focused?: boolean;
  actions: Array<{ label: string; onClick: () => void; primary?: boolean }>;
  className?: string;
}) {
  if (actions.length === 0) return null;
  const base = className ?? "workbench-strip";
  return (
    <div className={focused ? `${base} focused` : base}>
      <div>
        <span className="command-kicker">{kicker}</span>
        <strong>{headline}</strong>
        <p>{summary}</p>
      </div>
      <div className="task-primary-actions">
        {actions.map((action) => (
          <button
            key={action.label}
            className={action.primary ? "primary-action" : "secondary-action"}
            type="button"
            onClick={action.onClick}
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Convenience wrapper for rendering children inside a strip-like section. */
export function WorkbenchSection({ children }: { children: ReactNode }) {
  return <section className="workbench-section">{children}</section>;
}
