import type { WebsiteJob } from "@/lib/types";
import type { WebsiteAssetPlan, WebsiteImageryComponent } from "@/lib/website-asset-plan";

export interface WebsiteScaffoldFile {
  relativePath: string;
  buffer: Buffer;
}

export type WebsiteScaffoldFamily = "editorial" | "product" | "marketing";
export type WebsiteScaffoldVariant = "editorial" | "marketing" | "product-settings" | "product-dashboard";

function countHits(transcriptText: string, keywords: string[]) {
  const transcript = transcriptText.toLowerCase();
  return keywords.reduce((count, keyword) => count + (transcript.includes(keyword) ? 1 : 0), 0);
}

export function inferWebsiteScaffoldFamily(transcriptText: string): WebsiteScaffoldFamily {
  const productHits = countHits(transcriptText, [
    "dashboard",
    "analytics",
    "settings",
    "security",
    "privacy",
    "sidebar",
    "filters",
    "table",
    "chart",
    "metrics",
    "queue",
    "player",
    "workflow",
    "app"
  ]);
  if (productHits >= 2) {
    return "product";
  }

  const editorialHits = countHits(transcriptText, [
    "journal",
    "essays",
    "archive",
    "lectures",
    "historian",
    "research",
    "editorial",
    "biography",
    "personal page",
    "portfolio",
    "selected work",
    "publication"
  ]);
  if (editorialHits >= 2) {
    return "editorial";
  }

  return "marketing";
}

function buildEditorialApp() {
  return `import "./styles.css";

const stories = [
  { title: "Lead essay", meta: "Archive note" },
  { title: "Field note", meta: "Recent publication" },
  { title: "Lecture", meta: "Upcoming event" }
];

export default function App() {
  return (
    <main className="page-shell editorial-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark">Studio</span>
          <span className="brand-line" />
        </div>
        <nav className="nav-links" aria-label="Primary">
          <a href="#work">Work</a>
          <a href="#writing">Writing</a>
          <a href="#about">About</a>
          <a href="#contact">Contact</a>
        </nav>
      </header>

      <section className="editorial-hero">
        <div className="hero-copy">
          <p className="eyebrow">Editorial scaffold</p>
          <h1>Replace this scaffold with a preview-faithful editorial homepage.</h1>
          <p className="lead">
            Keep the preview's hierarchy and imagery, but reuse this structure instead of rebuilding the entire app
            from scratch.
          </p>
          <div className="hero-actions">
            <a className="primary-action" href="#work">
              Explore
            </a>
            <a className="secondary-action" href="#contact">
              Contact
            </a>
          </div>
        </div>
        <figure className="hero-visual-slot" aria-label="Hero image slot">
          <div className="slot-hint">hero image slot</div>
        </figure>
      </section>

      <section className="content-grid" id="work">
        <article className="feature-panel">
          <p className="kicker">Journal intro</p>
          <h2>Replace this intro panel with the preview's main supporting copy.</h2>
          <p>
            Preserve the preview's panel hierarchy, typographic rhythm, and tone. This scaffold gives you a strong
            shell so you can focus on fidelity.
          </p>
        </article>
        <aside className="note-panel" id="contact">
          <p className="kicker">Sidebar note</p>
          <h3>Use this for contact, lecture, or support content.</h3>
          <p>Keep it short, structured, and actionable.</p>
          <a className="secondary-action" href="#about">
            More details
          </a>
        </aside>
      </section>

      <section className="story-strip" id="writing" aria-label="Story strip">
        {stories.map((story) => (
          <article className="story-card" key={story.title}>
            <div className="story-image-slot">image slot</div>
            <h3>{story.title}</h3>
            <p>{story.meta}</p>
          </article>
        ))}
      </section>

      <section className="footer-band" id="about">
        <div>
          <p className="kicker">About</p>
          <h2>Keep the closing section useful and concise.</h2>
        </div>
        <a className="primary-action" href="#contact">
          Start a conversation
        </a>
      </section>
    </main>
  );
}
`;
}

function buildProductApp() {
  return `import "./styles.css";
import {
  ActionButton,
  MetricTile,
  SectionTitle,
  SidebarNav,
  StatusPill,
  SurfacePanel
} from "./ui/primitives";

const stats = [
  { label: "Security score", value: "92", meta: "Protected" },
  { label: "Active devices", value: "3", meta: "Trusted" },
  { label: "Recovery windows", value: "14d", meta: "Remaining" }
];

export default function App() {
  return (
    <main className="page-shell product-shell">
      <SidebarNav
        brand="Pulse"
        subtitle="Product scaffold"
        items={[
          { label: "Privacy", href: "#overview" },
          { label: "Identity", href: "#identity" },
          { label: "Security", href: "#security" },
          { label: "Recovery", href: "#support" }
        ]}
      />

      <section className="workspace">
        <header className="workspace-header">
          <SectionTitle
            eyebrow="Product scaffold"
            title="Replace this with a preview-faithful dashboard or settings interface."
          />
          <ActionButton href="#settings">Apply changes</ActionButton>
        </header>

        <section className="stats-row" id="overview">
          {stats.map((stat) => (
            <MetricTile key={stat.label} label={stat.label} value={stat.value} meta={stat.meta} />
          ))}
        </section>

        <section className="workspace-grid">
          <SurfacePanel className="main-panel" id="identity">
            <div className="panel-header">
              <SectionTitle
                className="panel-title"
                eyebrow="Identity section"
                title="Keep the main profile and ownership controls here."
              />
              <StatusPill>Verified</StatusPill>
            </div>
            <div className="chart-slot">large data or settings surface</div>
          </SurfacePanel>

          <SurfacePanel className="side-panel" id="security">
            <SectionTitle
              className="panel-title"
              eyebrow="Security controls"
              title="Use this rail for grouped controls, notes, and review states."
            />
            <div className="settings-list">
              <button type="button">Notifications</button>
              <button type="button">Permissions</button>
              <button type="button">Retention</button>
            </div>
          </SurfacePanel>
        </section>
      </section>
    </main>
  );
}
`;
}

function inferProductScaffoldVariant(transcriptText: string): WebsiteScaffoldVariant {
  const transcript = transcriptText.toLowerCase();
  const dashboardHits = countHits(transcript, [
    "dashboard",
    "dispatch",
    "operations",
    "logistics",
    "route",
    "shipments",
    "alerts",
    "metrics",
    "map",
    "board"
  ]);
  const settingsHits = countHits(transcript, [
    "settings",
    "privacy",
    "security",
    "permissions",
    "billing",
    "profile",
    "account",
    "preferences"
  ]);

  return dashboardHits >= settingsHits ? "product-dashboard" : "product-settings";
}

function buildProductDashboardApp() {
  return `import "./styles.css";
import {
  ActionButton,
  InfoList,
  MetricTile,
  SearchShell,
  SectionTitle,
  SidebarNav,
  StatusPill,
  SurfacePanel
} from "./ui/primitives";

const metrics = [
  { label: "Active routes", value: "24", meta: "+3" },
  { label: "Critical alerts", value: "5", meta: "-2" },
  { label: "On-time rate", value: "96.2%", meta: "+1.8%" },
  { label: "Open dwell risk", value: "23m", meta: "-4m" }
];

const alerts = [
  { title: "Trailer 204 temperature drift", meta: "Phoenix cold-chain lane", note: "8 min ago", action: "Investigate" },
  { title: "Port pickup delayed", meta: "Long Beach appointment moved", note: "22 min ago", action: "Reschedule" },
  { title: "Driver break window approaching", meta: "Unit 18 requires handoff", note: "41 min ago", action: "Plan coverage" }
];

export default function App() {
  return (
    <main className="page-shell product-shell product-dashboard-shell">
      <SidebarNav
        brand="Northline"
        subtitle="Operations scaffold"
        items={[
          { label: "Overview", href: "#overview" },
          { label: "Routes", href: "#routes" },
          { label: "Metrics", href: "#metrics" },
          { label: "Alerts", href: "#exceptions" },
          { label: "Teams", href: "#teams" }
        ]}
      />

      <section className="workspace">
        <header className="workspace-header dashboard-header">
          <SectionTitle
            eyebrow="Operations scaffold"
            title="Replace this with a dense, preview-faithful logistics dashboard."
          />
          <div className="header-actions">
            <SearchShell>Search routes, shipments, or partners</SearchShell>
            <ActionButton href="#exceptions">Review alerts</ActionButton>
          </div>
        </header>

        <section className="stats-row dashboard-metrics" id="overview">
          {metrics.map((metric) => (
            <MetricTile key={metric.label} label={metric.label} value={metric.value} meta={metric.meta} />
          ))}
        </section>

        <section className="workspace-grid dashboard-grid">
          <SurfacePanel className="main-panel dashboard-main-panel" id="routes">
            <div className="panel-header">
              <SectionTitle
                className="panel-title"
                eyebrow="Route board"
                title="Keep the main operational surface dense and specific."
              />
              <div className="panel-actions">
                <StatusPill>Network stable</StatusPill>
                <ActionButton tone="secondary" className="ghost-button">Export</ActionButton>
              </div>
            </div>

            <div className="dashboard-board">
              <div className="board-map-slot">map, checkpoints, or major route board</div>
              <div className="board-list">
                <article>
                  <h3>Phoenix to Houston</h3>
                  <p>Cross-dock in 2h</p>
                </article>
                <article>
                  <h3>Oakland to Long Beach</h3>
                  <p>Berth confirmed</p>
                </article>
                <article>
                  <h3>Seattle to Austin</h3>
                  <p>Weather delay</p>
                </article>
              </div>
            </div>
          </SurfacePanel>

          <SurfacePanel className="side-panel dashboard-side-panel" id="exceptions">
            <SectionTitle
              className="panel-title"
              eyebrow="Exception desk"
              title="Keep this rail active and operational."
            />
            <InfoList items={alerts} className="alert-stack" />
          </SurfacePanel>
        </section>
      </section>
    </main>
  );
}
`;
}

function buildMarketingApp() {
  return `import "./styles.css";

const highlights = [
  "Clear positioning",
  "Support content",
  "Proof or detail"
];

export default function App() {
  return (
    <main className="page-shell marketing-shell">
      <header className="topbar">
        <span className="brand-mark">Beacon</span>
        <nav className="nav-links" aria-label="Primary">
          <a href="#features">Features</a>
          <a href="#proof">Proof</a>
          <a href="#contact">Contact</a>
        </nav>
      </header>

      <section className="marketing-hero">
        <div className="hero-copy">
          <p className="eyebrow">Marketing scaffold</p>
          <h1>Replace this hero with a preview-faithful launch, booking, or campaign page.</h1>
          <p className="lead">
            Keep the preview's shell, not just the wording. This scaffold is meant to reduce the amount of code Codex
            has to invent from scratch.
          </p>
          <div className="hero-actions">
            <a className="primary-action" href="#contact">
              Primary action
            </a>
            <a className="secondary-action" href="#proof">
              See proof
            </a>
          </div>
        </div>
        <div className="hero-side-slot">hero visual or booking panel</div>
      </section>

      <section className="highlight-grid" id="features">
        {highlights.map((item) => (
          <article className="highlight-card" key={item}>
            <p className="kicker">Highlight</p>
            <h2>{item}</h2>
            <p>Translate the preview's support modules into this structure rather than rebuilding from zero.</p>
          </article>
        ))}
      </section>

      <section className="proof-band" id="proof">
        <div className="proof-copy">
          <p className="kicker">Proof</p>
          <h2>Use this zone for schedule, pricing, outcomes, or testimonials.</h2>
        </div>
        <div className="proof-slot">detail or proof slot</div>
      </section>

      <section className="footer-band" id="contact">
        <div>
          <p className="kicker">Final CTA</p>
          <h2>End with one decisive action.</h2>
        </div>
        <a className="primary-action" href="#features">
          Continue
        </a>
      </section>
    </main>
  );
}
`;
}

function buildSharedStyles(family: WebsiteScaffoldFamily) {
  const rootPalette =
    family === "product"
      ? `--page-bg: #07131f;
  --page-bg-2: #0d2235;
  --page-ink: #eef3ff;
  --page-muted: rgba(226, 235, 255, 0.72);
  --page-line: rgba(168, 197, 255, 0.18);
  --page-surface: rgba(10, 24, 38, 0.78);
  --page-surface-strong: rgba(13, 31, 48, 0.96);
  --page-accent: #f28b5b;
  --page-accent-soft: rgba(242, 139, 91, 0.18);
  --page-glow: rgba(60, 141, 255, 0.26);`
      : family === "marketing"
        ? `--page-bg: #120d16;
  --page-bg-2: #241629;
  --page-ink: #f8efe6;
  --page-muted: rgba(248, 239, 230, 0.76);
  --page-line: rgba(248, 239, 230, 0.12);
  --page-surface: rgba(28, 20, 32, 0.82);
  --page-surface-strong: rgba(36, 25, 40, 0.94);
  --page-accent: #ff9e63;
  --page-accent-soft: rgba(255, 158, 99, 0.18);
  --page-glow: rgba(255, 158, 99, 0.2);`
        : `--page-bg: #0a1119;
  --page-bg-2: #1a171e;
  --page-ink: #f4ecdf;
  --page-muted: rgba(244, 236, 223, 0.74);
  --page-line: rgba(244, 236, 223, 0.12);
  --page-surface: rgba(19, 17, 22, 0.82);
  --page-surface-strong: rgba(26, 23, 30, 0.94);
  --page-accent: #ee9c67;
  --page-accent-soft: rgba(238, 156, 103, 0.18);
  --page-glow: rgba(238, 156, 103, 0.18);`;

  return `:root {
  ${rootPalette}
  color: var(--page-ink);
  background:
    radial-gradient(circle at top left, var(--page-glow), transparent 32rem),
    linear-gradient(180deg, var(--page-bg) 0%, var(--page-bg-2) 100%);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  line-height: 1.5;
  font-weight: 400;
  color-scheme: dark;
}

* {
  box-sizing: border-box;
}

html,
body,
#root {
  margin: 0;
  min-height: 100%;
}

body {
  min-height: 100vh;
}

a,
button {
  color: inherit;
}

button {
  font: inherit;
}

.page-shell {
  min-height: 100vh;
  padding: clamp(18px, 2.4vw, 32px);
  background:
    radial-gradient(circle at 12% 12%, var(--page-glow), transparent 24rem),
    linear-gradient(180deg, rgba(255, 255, 255, 0.01), rgba(255, 255, 255, 0));
}

.topbar,
.workspace-header,
.footer-band,
.proof-band,
.content-grid,
.story-strip,
.workspace-grid,
.stats-row,
.highlight-grid,
.marketing-hero,
.editorial-hero {
  width: min(100%, 1240px);
  margin: 0 auto;
}

.topbar,
.workspace-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
}

.topbar {
  margin-bottom: 28px;
}

.brand-mark,
.eyebrow,
.kicker,
.pill {
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

.brand-mark,
.eyebrow,
.kicker {
  font-size: 12px;
  color: var(--page-muted);
}

.brand-lockup {
  display: flex;
  align-items: center;
  gap: 12px;
}

.brand-line {
  width: 80px;
  height: 1px;
  background: var(--page-line);
}

.nav-links,
.sidebar-nav {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}

.nav-links a,
.sidebar-nav a {
  text-decoration: none;
  color: var(--page-muted);
}

.nav-links a:hover,
.sidebar-nav a:hover,
.secondary-action:hover {
  color: var(--page-ink);
}

.editorial-shell h1,
.marketing-shell h1,
.workspace-header h1,
.footer-band h2,
.proof-band h2,
.feature-panel h2,
.highlight-card h2,
.main-panel h2 {
  font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Palatino, Georgia, serif;
}

.editorial-hero,
.marketing-hero,
.content-grid,
.proof-band,
.workspace-grid {
  display: grid;
  gap: clamp(22px, 3vw, 40px);
}

.editorial-hero,
.marketing-hero {
  grid-template-columns: minmax(0, 1.08fr) minmax(280px, 0.92fr);
  min-height: min(74vh, 820px);
  align-items: end;
  padding: clamp(28px, 5vw, 72px);
  border-radius: 34px;
  border: 1px solid var(--page-line);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.02));
  box-shadow: 0 34px 120px rgba(0, 0, 0, 0.28);
  margin-bottom: 28px;
}

.hero-copy {
  display: grid;
  gap: 18px;
  align-content: end;
}

.hero-copy h1,
.workspace-header h1 {
  margin: 0;
  max-width: 11ch;
  font-size: clamp(3rem, 6vw, 6.4rem);
  line-height: 0.92;
}

.lead {
  margin: 0;
  max-width: 42rem;
  color: var(--page-muted);
  font-size: clamp(1rem, 1.3vw, 1.18rem);
}

.hero-actions,
.footer-band,
.proof-band,
.panel-header {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}

.primary-action,
.secondary-action,
.settings-list button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 48px;
  padding: 0 20px;
  border-radius: 999px;
  border: 1px solid transparent;
  text-decoration: none;
  transition: transform 160ms ease, background-color 160ms ease, border-color 160ms ease;
}

.primary-action {
  background: var(--page-accent);
  color: #180d07;
  font-weight: 600;
}

.secondary-action,
.settings-list button {
  border-color: var(--page-line);
  background: rgba(255, 255, 255, 0.02);
  color: var(--page-ink);
}

.button-base {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 48px;
  padding: 0 20px;
  border-radius: 999px;
  border: 1px solid transparent;
  text-decoration: none;
  transition: transform 160ms ease, background-color 160ms ease, border-color 160ms ease;
}

.button-primary {
  background: var(--page-accent);
  color: #180d07;
  font-weight: 600;
}

.button-secondary {
  border-color: var(--page-line);
  background: rgba(255, 255, 255, 0.02);
  color: var(--page-ink);
}

.primary-action:hover,
.secondary-action:hover,
.settings-list button:hover,
.button-base:hover {
  transform: translateY(-1px);
}

.surface-panel {
  border-radius: 26px;
  border: 1px solid var(--page-line);
  background: var(--page-surface);
  backdrop-filter: blur(18px);
  padding: clamp(22px, 3vw, 34px);
}

.section-title {
  display: grid;
  gap: 10px;
}

.section-title h2 {
  margin: 0;
  font-size: clamp(1.8rem, 3vw, 3.3rem);
  line-height: 0.96;
}

.section-description {
  margin: 0;
  color: var(--page-muted);
}

.status-pill {
  display: inline-flex;
  align-items: center;
  min-height: 36px;
  padding: 0 12px;
  border-radius: 999px;
  background: var(--page-accent-soft);
  color: var(--page-ink);
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.metric-tile {
  border-radius: 24px;
  border: 1px solid var(--page-line);
  background: var(--page-surface);
  backdrop-filter: blur(18px);
  padding: 18px 20px;
}

.metric-tile h3 {
  margin: 8px 0 0;
  font-size: clamp(1.9rem, 2.2vw, 2.8rem);
}

.metric-tile span {
  display: inline-block;
  margin-top: 8px;
  color: var(--page-muted);
}

.sidebar-shell {
  position: sticky;
  top: 18px;
  align-self: start;
  min-height: calc(100vh - 36px);
  padding: 26px 20px;
  border-radius: 28px;
  border: 1px solid var(--page-line);
  background: var(--page-surface-strong);
}

.hero-visual-slot,
.hero-side-slot,
.chart-slot,
.proof-slot,
.story-image-slot,
.avatar-plate,
.board-inset {
  border-radius: 26px;
  border: 1px dashed rgba(255, 255, 255, 0.16);
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0.02)),
    rgba(255, 255, 255, 0.02);
  display: grid;
  place-items: center;
  color: var(--page-muted);
}

.hero-visual-slot,
.hero-side-slot {
  min-height: 520px;
}

.slot-hint,
.hero-side-slot,
.chart-slot,
.proof-slot,
.story-image-slot,
.avatar-fallback {
  font-size: 0.96rem;
}

.generated-image-fill {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  border-radius: inherit;
}

.content-grid,
.workspace-grid,
.proof-band {
  grid-template-columns: minmax(0, 1fr) minmax(240px, 340px);
  margin-bottom: 26px;
}

.feature-panel,
.note-panel,
.main-panel,
.side-panel,
.highlight-card,
.story-card,
.footer-band,
.proof-band,
.stats-row article {
  border-radius: 26px;
  border: 1px solid var(--page-line);
  background: var(--page-surface);
  backdrop-filter: blur(18px);
}

.feature-panel,
.note-panel,
.main-panel,
.side-panel,
.highlight-card,
.footer-band {
  padding: clamp(22px, 3vw, 34px);
}

.feature-panel h2,
.main-panel h2,
.footer-band h2,
.proof-band h2 {
  margin: 0 0 12px;
  font-size: clamp(2rem, 3vw, 3.5rem);
  line-height: 0.96;
}

.feature-panel p,
.note-panel p,
.main-panel p,
.side-panel p,
.highlight-card p,
.footer-band p,
.proof-band p,
.story-card p,
.stat-card p {
  margin: 0;
  color: var(--page-muted);
}

.story-strip,
.highlight-grid,
.stats-row {
  display: grid;
  gap: 16px;
  margin-bottom: 26px;
}

.story-strip {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.highlight-grid,
.stats-row {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.story-card {
  padding: 16px;
}

.story-image-slot {
  min-height: 140px;
  margin-bottom: 14px;
}

.story-card h3,
.highlight-card h2,
.side-panel h3 {
  margin: 0 0 10px;
  font-size: 1.35rem;
}

.product-shell {
  display: grid;
  grid-template-columns: 244px minmax(0, 1fr);
  gap: 20px;
}

.sidebar {
  position: sticky;
  top: 18px;
  align-self: start;
  min-height: calc(100vh - 36px);
  padding: 26px 20px;
  border-radius: 28px;
  border: 1px solid var(--page-line);
  background: var(--page-surface-strong);
}

.sidebar-brand {
  margin-bottom: 24px;
}

.brand-subtitle {
  margin: 8px 0 0;
  color: var(--page-muted);
}

.sidebar-nav {
  flex-direction: column;
  align-items: flex-start;
}

.workspace {
  display: grid;
  gap: 20px;
}

.settings-grid {
  grid-template-columns: minmax(0, 1.15fr) minmax(320px, 0.85fr);
}

.settings-card {
  display: grid;
  gap: 18px;
}

.settings-summary {
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr);
  gap: 18px;
  align-items: center;
}

.avatar-plate {
  min-height: 92px;
  overflow: hidden;
}

.avatar-fallback {
  display: grid;
  place-items: center;
  font-size: 1.5rem;
  color: var(--page-ink);
}

.settings-summary-copy {
  display: grid;
  gap: 8px;
}

.settings-summary-copy h3 {
  margin: 0;
  font-size: 1.2rem;
}

.settings-row-list {
  display: grid;
  gap: 12px;
}

.settings-row-list article {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px;
  border-radius: 18px;
  border: 1px solid var(--page-line);
  background: rgba(255, 255, 255, 0.03);
}

.settings-row-list strong {
  font-size: 0.95rem;
}

.settings-row-list span {
  color: var(--page-muted);
  text-align: right;
}

.dashboard-header {
  align-items: flex-start;
}

.header-actions,
.panel-actions,
.metric-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.header-actions {
  justify-content: flex-end;
}

.search-shell,
.ghost-button {
  min-height: 46px;
  border-radius: 999px;
  border: 1px solid var(--page-line);
  background: rgba(255, 255, 255, 0.02);
  color: var(--page-muted);
}

.search-shell {
  min-width: min(32rem, 100%);
  padding: 0 18px;
  display: inline-flex;
  align-items: center;
}

.info-list {
  display: grid;
  gap: 12px;
}

.info-list-item {
  border-radius: 20px;
  border: 1px solid var(--page-line);
  background: rgba(255, 255, 255, 0.03);
  padding: 16px;
  display: grid;
  gap: 8px;
}

.info-list-item h4 {
  margin: 0;
  font-size: 1rem;
}

.info-list-item p,
.info-list-item span {
  margin: 0;
  color: var(--page-muted);
}

.ghost-button {
  padding: 0 16px;
  display: inline-flex;
  align-items: center;
}

.stats-row article {
  padding: 18px 20px;
}

.stats-row h2 {
  margin: 8px 0 0;
  font-size: clamp(1.9rem, 2.2vw, 2.8rem);
}

.chart-slot {
  min-height: 360px;
  margin-top: 18px;
}

.dashboard-grid {
  grid-template-columns: minmax(0, 1.65fr) minmax(300px, 0.85fr);
}

.dashboard-main-panel h2 {
  max-width: 12ch;
}

.dashboard-board {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(220px, 0.8fr);
  gap: 18px;
  margin-top: 18px;
}

.board-map-slot {
  min-height: 420px;
  border-radius: 24px;
  border: 1px dashed rgba(255, 255, 255, 0.16);
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.02)),
    rgba(255, 255, 255, 0.02);
  display: grid;
  place-items: center;
  color: var(--page-muted);
  position: relative;
  overflow: hidden;
}

.board-inset {
  position: absolute;
  right: 18px;
  bottom: 18px;
  width: 120px;
  min-height: 88px;
  overflow: hidden;
}

.board-list,
.alert-stack {
  display: grid;
  gap: 12px;
}

.board-list article,
.alert-card {
  border-radius: 20px;
  border: 1px solid var(--page-line);
  background: rgba(255, 255, 255, 0.03);
  padding: 16px;
}

.board-list h3,
.alert-card h4 {
  margin: 0 0 6px;
  font-size: 1rem;
}

.alert-card button {
  margin-top: 12px;
  min-height: 40px;
  border-radius: 999px;
  border: 1px solid var(--page-line);
  background: transparent;
  color: var(--page-ink);
  padding: 0 14px;
}

.metric-delta {
  font-size: 0.9rem;
  color: var(--page-muted);
}

.settings-list {
  display: grid;
  gap: 12px;
  margin-top: 16px;
}

.pill {
  padding: 8px 12px;
  border-radius: 999px;
  background: var(--page-accent-soft);
  color: var(--page-ink);
  font-size: 11px;
}

.footer-band {
  justify-content: space-between;
  margin-bottom: 0;
}

@media (max-width: 980px) {
  .page-shell {
    padding: 16px;
  }

  .editorial-hero,
  .marketing-hero,
  .content-grid,
  .workspace-grid,
  .proof-band,
  .product-shell {
    grid-template-columns: 1fr;
  }

  .product-shell {
    display: block;
  }

  .sidebar {
    position: static;
    min-height: auto;
    margin-bottom: 18px;
  }

  .dashboard-grid,
  .dashboard-board {
    grid-template-columns: 1fr;
  }

  .header-actions {
    justify-content: flex-start;
  }

  .story-strip,
  .highlight-grid,
  .stats-row {
    grid-template-columns: 1fr;
  }

  .hero-visual-slot,
  .hero-side-slot {
    min-height: 320px;
  }
}
`;
}

function toAnchorId(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "section";
}

function toImportName(fileName: string) {
  const stem = fileName.replace(/\.[^.]+$/, "");
  const segments = stem.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const base =
    segments
      .map((segment, index) =>
        index === 0 ? segment.charAt(0).toLowerCase() + segment.slice(1) : segment.charAt(0).toUpperCase() + segment.slice(1)
      )
      .join("") || "asset";
  return `${base}Image`;
}

function getBlueprintSections(assetPlan: WebsiteAssetPlan, fallback: string[]) {
  const sections = assetPlan.primary_sections.length
    ? assetPlan.primary_sections
    : fallback.map((name, index) => ({
        name,
        purpose: "Blueprint section",
        emphasis: index === 0 ? ("primary" as const) : ("supporting" as const)
      }));

  return sections.slice(0, 6);
}

function findGeneratedAsset(
  generatedAssets: Array<{ component: WebsiteImageryComponent; fileName: string }>,
  matcher: RegExp
) {
  return generatedAssets.find((asset) => matcher.test(asset.component.role) || matcher.test(asset.component.name));
}

function buildPreviewProductSettingsBlueprintApp(params: {
  job: WebsiteJob;
  assetPlan: WebsiteAssetPlan;
  generatedAssets: Array<{ component: WebsiteImageryComponent; fileName: string }>;
}) {
  const sections = getBlueprintSections(params.assetPlan, ["Overview", "Identity", "Security", "Save note"]);
  const navItems = sections.map((section) => ({
    label: section.name,
    href: `#${toAnchorId(section.name)}`
  }));
  const mainSection = sections[1] ?? sections[0];
  const supportSection = sections[2] ?? sections[sections.length - 1];
  const footerSection = sections[3] ?? sections[sections.length - 1];
  const avatarAsset = findGeneratedAsset(params.generatedAssets, /avatar|portrait|profile/i);
  const avatarImport = avatarAsset
    ? `import ${toImportName(avatarAsset.fileName)} from "./generated-assets/${avatarAsset.fileName}";`
    : null;
  const avatarReference = avatarAsset ? toImportName(avatarAsset.fileName) : null;

  return `import "./styles.css";
import {
  ActionButton,
  InfoList,
  MetricTile,
  SectionTitle,
  SidebarNav,
  StatusPill,
  SurfacePanel
} from "./ui/primitives";
${avatarImport ?? ""}

const navItems = ${JSON.stringify(navItems, null, 2)};

const metrics = [
  { label: "Security score", value: "92", meta: "Protected" },
  { label: "Recovery windows", value: "14d", meta: "Available" },
  { label: "Trusted devices", value: "3", meta: "Active" }
];

const supportRows = [
  { title: "Password", meta: "Last changed 32 days ago", note: "Healthy", action: "Change" },
  { title: "Two-factor authentication", meta: "Protect your account with an extra layer", note: "Enabled", action: "Review" },
  { title: "Login alerts", meta: "Get notified about new sign-ins", note: "On", action: "Adjust" }
];

export default function App() {
  return (
    <main className="page-shell product-shell">
      <SidebarNav brand="Pulse" subtitle="${params.assetPlan.shell_style.replace(/"/g, '\\"')}" items={navItems} />

      <section className="workspace">
        <header className="workspace-header">
          <SectionTitle
            eyebrow="${sections[0]?.name ?? "Settings"}"
            title="${mainSection.name}"
            description="${mainSection.purpose.replace(/"/g, '\\"')}"
          />
          <ActionButton href="#${toAnchorId(footerSection.name)}">Save changes</ActionButton>
        </header>

        <section className="stats-row" id="${toAnchorId(sections[0]?.name ?? "overview")}">
          {metrics.map((metric) => (
            <MetricTile key={metric.label} label={metric.label} value={metric.value} meta={metric.meta} />
          ))}
        </section>

        <section className="workspace-grid settings-grid">
          <SurfacePanel className="main-panel settings-card settings-identity-card" id="${toAnchorId(mainSection.name)}">
            <div className="panel-header">
              <SectionTitle
                className="panel-title"
                eyebrow="${mainSection.name}"
                title="${mainSection.purpose.replace(/"/g, '\\"')}"
              />
              <StatusPill>Verified</StatusPill>
            </div>

            <div className="settings-summary">
              ${
                avatarReference
                  ? `<div className="avatar-plate"><img src={${avatarReference}} alt="Profile" className="generated-image-fill" /></div>`
                  : `<div className="avatar-plate avatar-fallback">JD</div>`
              }
              <div className="settings-summary-copy">
                <h3>Jessica Morgan</h3>
                <p>Personal information, account recovery, and identity details stay grouped here.</p>
              </div>
            </div>

            <div className="settings-row-list">
              <article><strong>Full name</strong><span>Jessica Morgan</span></article>
              <article><strong>Email address</strong><span>jessica.morgan@example.com</span></article>
              <article><strong>Recovery email</strong><span>backup@example.com</span></article>
              <article><strong>Phone number</strong><span>+1 (415) 555-0198</span></article>
            </div>
          </SurfacePanel>

          <SurfacePanel className="side-panel settings-card settings-support-card" id="${toAnchorId(supportSection.name)}">
            <SectionTitle
              className="panel-title"
              eyebrow="${supportSection.name}"
              title="${supportSection.purpose.replace(/"/g, '\\"')}"
            />
            <InfoList items={supportRows} />
          </SurfacePanel>
        </section>
      </section>
    </main>
  );
}
`;
}

function buildPreviewProductDashboardBlueprintApp(params: {
  job: WebsiteJob;
  assetPlan: WebsiteAssetPlan;
  generatedAssets: Array<{ component: WebsiteImageryComponent; fileName: string }>;
}) {
  const sections = getBlueprintSections(params.assetPlan, ["Overview", "Routes", "Metrics", "Alerts"]);
  const navItems = sections.map((section) => ({
    label: section.name,
    href: `#${toAnchorId(section.name)}`
  }));
  const mainSection = sections.find((section) => /route|map|board/i.test(section.name)) ?? sections[1] ?? sections[0];
  const alertSection = sections.find((section) => /alert|shipment|exception|watch/i.test(section.name)) ?? sections[2] ?? sections[sections.length - 1];
  const mapAsset = findGeneratedAsset(params.generatedAssets, /map|route|board/i);
  const insetAsset = findGeneratedAsset(params.generatedAssets, /inset|mini|world/i);
  const brandAsset = findGeneratedAsset(params.generatedAssets, /brand|mark|logo/i);
  const imports = [mapAsset, insetAsset, brandAsset]
    .filter((asset): asset is NonNullable<typeof asset> => Boolean(asset))
    .map((asset) => `import ${toImportName(asset.fileName)} from "./generated-assets/${asset.fileName}";`)
    .join("\n");

  return `import "./styles.css";
import {
  ActionButton,
  InfoList,
  MetricTile,
  SearchShell,
  SectionTitle,
  SidebarNav,
  StatusPill,
  SurfacePanel
} from "./ui/primitives";
${imports}

const navItems = ${JSON.stringify(navItems, null, 2)};

const metrics = [
  { label: "Active routes", value: "24", meta: "+3" },
  { label: "Critical alerts", value: "5", meta: "-2" },
  { label: "On-time rate", value: "96.2%", meta: "+1.8%" },
  { label: "Open dwell risk", value: "23m", meta: "-4m" }
];

const alerts = [
  { title: "Shipment delayed", meta: "Weather hold on Phoenix lane", note: "15m ago", action: "Investigate" },
  { title: "Driver ETA moved", meta: "Memphis handoff shifted", note: "41m ago", action: "Reassign" },
  { title: "Port exception", meta: "Long Beach berth updated", note: "1h ago", action: "Review" }
];

export default function App() {
  return (
    <main className="page-shell product-shell product-dashboard-shell">
      <SidebarNav
        brand="Northline"
        subtitle="${params.assetPlan.shell_style.replace(/"/g, '\\"')}"
        items={navItems}
        className="dashboard-sidebar"
      />

      <section className="workspace">
        <header className="workspace-header dashboard-header">
          <SectionTitle
            eyebrow="${sections[0]?.name ?? "Overview"}"
            title="${mainSection.name}"
            description="${mainSection.purpose.replace(/"/g, '\\"')}"
          />
          <div className="header-actions">
            <SearchShell>Search shipments, locations, or partners</SearchShell>
            <ActionButton href="#${toAnchorId(alertSection.name)}">New shipment</ActionButton>
          </div>
        </header>

        <section className="stats-row dashboard-metrics" id="${toAnchorId(sections[0]?.name ?? "overview")}">
          {metrics.map((metric) => (
            <MetricTile key={metric.label} label={metric.label} value={metric.value} meta={metric.meta} />
          ))}
        </section>

        <section className="workspace-grid dashboard-grid">
          <SurfacePanel className="main-panel dashboard-main-panel" id="${toAnchorId(mainSection.name)}">
            <div className="panel-header">
              <SectionTitle
                className="panel-title"
                eyebrow="${mainSection.name}"
                title="${mainSection.purpose.replace(/"/g, '\\"')}"
              />
              <div className="panel-actions">
                <StatusPill>Network stable</StatusPill>
                <ActionButton tone="secondary" className="ghost-button">Export</ActionButton>
              </div>
            </div>

            <div className="dashboard-board">
              <div className="board-map-slot board-map-slot--image">
                ${
                  mapAsset
                    ? `<img src={${toImportName(mapAsset.fileName)}} alt="Route map" className="generated-image-fill" />`
                    : `map, checkpoints, or major route board`
                }
                ${
                  insetAsset
                    ? `<div className="board-inset"><img src={${toImportName(insetAsset.fileName)}} alt="Inset map" className="generated-image-fill" /></div>`
                    : ""
                }
              </div>
              <div className="board-list">
                <article><h3>Seattle</h3><p>Route board and waypoints stay visible here.</p></article>
                <article><h3>Denver</h3><p>Transit lines, status markers, and checkpoints.</p></article>
                <article><h3>Chicago</h3><p>Operational annotations and lane context.</p></article>
              </div>
            </div>
          </SurfacePanel>

          <SurfacePanel className="side-panel dashboard-side-panel" id="${toAnchorId(alertSection.name)}">
            <SectionTitle
              className="panel-title"
              eyebrow="${alertSection.name}"
              title="${alertSection.purpose.replace(/"/g, '\\"')}"
            />
            <InfoList items={alerts} className="alert-stack" />
          </SurfacePanel>
        </section>
      </section>
    </main>
  );
}
`;
}

export function buildWebsiteBlueprintOverrides(params: {
  job: WebsiteJob;
  assetPlan: WebsiteAssetPlan;
  generatedAssets: Array<{ component: WebsiteImageryComponent; fileName: string }>;
}) {
  const variant = inferWebsiteScaffoldVariant(params.job.transcriptText);
  if (variant !== "product-dashboard" && variant !== "product-settings") {
    return null;
  }

  const appSource =
    variant === "product-dashboard"
      ? buildPreviewProductDashboardBlueprintApp(params)
      : buildPreviewProductSettingsBlueprintApp(params);

  return {
    variant,
    files: [
      {
        relativePath: "src/App.tsx",
        buffer: Buffer.from(appSource, "utf8")
      }
    ] satisfies WebsiteScaffoldFile[]
  };
}

export function inferWebsiteScaffoldVariant(transcriptText: string): WebsiteScaffoldVariant {
  const family = inferWebsiteScaffoldFamily(transcriptText);
  if (family === "product") {
    return inferProductScaffoldVariant(transcriptText);
  }
  return family;
}

export function buildWebsiteScaffoldOverrides(job: WebsiteJob) {
  const family = inferWebsiteScaffoldFamily(job.transcriptText);
  const variant = inferWebsiteScaffoldVariant(job.transcriptText);
  const appSource =
    variant === "product-dashboard"
      ? buildProductDashboardApp()
      : variant === "product-settings"
        ? buildProductApp()
        : family === "marketing"
          ? buildMarketingApp()
          : buildEditorialApp();

  return {
    family,
    variant,
    files: [
      {
        relativePath: "src/App.tsx",
        buffer: Buffer.from(appSource, "utf8")
      },
      {
        relativePath: "src/styles.css",
        buffer: Buffer.from(buildSharedStyles(family), "utf8")
      }
    ]
  };
}
