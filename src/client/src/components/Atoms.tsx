import { BookOpen } from "lucide-react";
import type { ReactNode } from "react";

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
