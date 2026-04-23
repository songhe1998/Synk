import type { AnchorHTMLAttributes, ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

function cx(...values: Array<string | null | undefined | false>) {
  return values.filter(Boolean).join(" ");
}

export function SurfacePanel({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLElement> & { children: ReactNode }) {
  return (
    <section className={cx("surface-panel", className)} {...props}>
      {children}
    </section>
  );
}

export function SectionTitle({
  eyebrow,
  title,
  description,
  className
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  className?: string;
}) {
  return (
    <div className={cx("section-title", className)}>
      {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
      <h2>{title}</h2>
      {description ? <p className="section-description">{description}</p> : null}
    </div>
  );
}

export function ActionButton({
  tone = "primary",
  className,
  children,
  ...props
}: (ButtonHTMLAttributes<HTMLButtonElement> | AnchorHTMLAttributes<HTMLAnchorElement>) & {
  tone?: "primary" | "secondary";
  children: ReactNode;
}) {
  const classes = cx("button-base", tone === "primary" ? "button-primary" : "button-secondary", className);

  if ("href" in props && props.href) {
    const anchorProps = props as AnchorHTMLAttributes<HTMLAnchorElement>;
    return (
      <a className={classes} {...anchorProps}>
        {children}
      </a>
    );
  }

  const buttonProps = props as ButtonHTMLAttributes<HTMLButtonElement>;
  return (
    <button className={classes} type={buttonProps.type ?? "button"} {...buttonProps}>
      {children}
    </button>
  );
}

export function StatusPill({
  children,
  className
}: {
  children: ReactNode;
  className?: string;
}) {
  return <span className={cx("status-pill", className)}>{children}</span>;
}

export function MetricTile({
  label,
  value,
  meta,
  className
}: {
  label: string;
  value: string;
  meta?: string;
  className?: string;
}) {
  return (
    <article className={cx("metric-tile", className)}>
      <p>{label}</p>
      <h3>{value}</h3>
      {meta ? <span>{meta}</span> : null}
    </article>
  );
}

export function SidebarNav({
  brand,
  subtitle,
  items,
  className
}: {
  brand: string;
  subtitle?: string;
  items: Array<{ label: string; href: string }>;
  className?: string;
}) {
  return (
    <aside className={cx("sidebar-shell", className)} aria-label="Primary navigation">
      <div className="sidebar-brand">
        <span className="brand-mark">{brand}</span>
        {subtitle ? <p className="brand-subtitle">{subtitle}</p> : null}
      </div>
      <nav className="sidebar-nav">
        {items.map((item) => (
          <a key={item.href} href={item.href}>
            {item.label}
          </a>
        ))}
      </nav>
    </aside>
  );
}

export function SearchShell({
  children,
  className
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cx("search-shell", className)}>{children}</div>;
}

export function InfoList({
  items,
  className
}: {
  items: Array<{ title: string; meta?: string; note?: string; action?: string }>;
  className?: string;
}) {
  return (
    <div className={cx("info-list", className)}>
      {items.map((item) => (
        <article className="info-list-item" key={item.title}>
          <h4>{item.title}</h4>
          {item.meta ? <p>{item.meta}</p> : null}
          {item.note ? <span>{item.note}</span> : null}
          {item.action ? <ActionButton tone="secondary">{item.action}</ActionButton> : null}
        </article>
      ))}
    </div>
  );
}
