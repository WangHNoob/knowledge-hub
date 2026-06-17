import { BookOpen } from "lucide-react";
import type { ComponentType, ReactNode } from "react";

export function Page({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="page">
      <header className="page-head">
        <BookOpen size={22} />
        <div>
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
      </header>
      {children}
    </div>
  );
}

export interface TabItem<T extends string> {
  id: T;
  label: string;
  icon?: ComponentType<{ size?: number }>;
  count?: number;
}

/**
 * 页内分段导航：让一个页面里的多个区块变成可切换的子页面，避免无尽下滑。
 * 用 `key={active}` 包裹内容即可让面板切换时复用 fade-up 动画。
 */
export function Tabs<T extends string>({
  items,
  active,
  onChange
}: {
  items: ReadonlyArray<TabItem<T>>;
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="subnav" role="tablist">
      {items.map((item) => {
        const Icon = item.icon;
        const isActive = item.id === active;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={isActive ? "subnav-tab active" : "subnav-tab"}
            onClick={() => onChange(item.id)}
          >
            {Icon && <Icon size={16} />}
            <span>{item.label}</span>
            {typeof item.count === "number" && item.count > 0 && (
              <span className="subnav-count">{item.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function Metric({ label, value, hint, tone }: { label: string; value: string | number; hint: string; tone?: "hot" | "warn" | "ok" }) {
  return (
    <div className={`metric ${tone ?? ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{hint}</small>
    </div>
  );
}

export function Badge({ label, tone }: { label: string; tone?: "hot" | "warn" | "ok" }) {
  return <span className={`badge ${tone ?? ""}`}>{label}</span>;
}

export function Loading({ title }: { title: string }) {
  return <div className="state">{title}...</div>;
}

export function ErrorState({ error }: { error: unknown }) {
  return <div className="state error">{error instanceof Error ? error.message : String(error)}</div>;
}

export function EmptyWork({ title, body }: { title: string; body: string }) {
  return (
    <section className="empty">
      <h2>{title}</h2>
      <p>{body}</p>
    </section>
  );
}
