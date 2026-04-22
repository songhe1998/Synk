import Link from "next/link";

export function ResultLoadingShell({
  label,
  title,
  copy
}: {
  label: string;
  title: string;
  copy: string;
}) {
  return (
    <main className="world-loading-page">
      <section className="world-loading-stage">
        <div className="world-loading-grid" />
        <div className="world-loading-sweep" />
        <Link href="/" className="world-loading-back">
          Back home
        </Link>

        <div className="world-loading-card">
          <span className="status-badge status-running">{label}</span>
          <h1>{title}</h1>
          <p className="world-loading-copy">{copy}</p>
          <div className="world-loading-pulse" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </div>
      </section>
    </main>
  );
}
