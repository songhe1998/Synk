import Link from "next/link";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { formatDuration } from "@/lib/drawing";
import { isAuthEnabled, requireViewer } from "@/lib/auth";
import { listRecentSessions } from "@/lib/session-store";
import { getSupabaseSchemaSetupMessage, isSupabaseSchemaMissingError } from "@/lib/supabase/errors";
import { SessionSummary } from "@/lib/types";

export const dynamic = "force-dynamic";

function statusLabel(status: SessionSummary["status"]) {
  switch (status) {
    case "created":
      return "Draft";
    case "uploaded":
      return "Uploaded";
    case "processing":
      return "Processing";
    case "ready":
      return "Ready";
    case "failed":
      return "Failed";
  }
}

function relativeDate(isoString: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(isoString));
}

export default async function DashboardPage() {
  if (!isAuthEnabled()) {
    redirect("/");
  }

  const viewer = await requireViewer("/dashboard");
  let sessions = [] as Awaited<ReturnType<typeof listRecentSessions>>;
  let setupMessage: string | null = null;

  try {
    sessions = await listRecentSessions(viewer!.id);
  } catch (error) {
    if (isSupabaseSchemaMissingError(error)) {
      setupMessage = getSupabaseSchemaSetupMessage();
    } else {
      throw error;
    }
  }

  return (
    <main className="page-shell">
      <section className="hero-card dashboard-hero">
        <div className="hero-copy">
          <p className="eyebrow">Dashboard</p>
          <h1>Your Skratch sessions</h1>
          <p className="hero-text">
            Your sketches, images, videos, and worlds stay tied to your account so you can come back from any device.
          </p>
        </div>

        <div className="hero-actions">
          <div className="meta-stack">
            <span>Signed in as</span>
            <strong>{viewer?.email ?? "Unknown account"}</strong>
          </div>
          <Link href="/" className="primary-button">
            New sketch
          </Link>
          <form action="/auth/sign-out" method="post">
            <button type="submit" className="ghost-button dashboard-signout-button">
              Sign out
            </button>
          </form>
        </div>
      </section>

      <section className="panel dashboard-panel">
        <div className="panel-header">
          <div>
            <p className="panel-kicker">Library</p>
            <h2>Recent sessions</h2>
          </div>
        </div>

        {setupMessage ? <p className="auth-error">{setupMessage}</p> : null}

        <div className="session-list">
          {sessions.length === 0 ? (
            <p className="empty-copy">No saved sessions yet. Start a sketch from the homepage to populate your dashboard.</p>
          ) : (
            sessions.map((session) => (
              session.preferredResultUrl ? (
                <Link
                  key={session.id}
                  href={session.preferredResultUrl as Route}
                  className="session-link"
                >
                  <div>
                    <p className="session-title">{session.title}</p>
                    <p className="session-meta">
                      {relativeDate(session.createdAt)} · {formatDuration(session.durationMs)}
                    </p>
                  </div>
                  <span className={`status-badge status-${session.status}`}>{statusLabel(session.status)}</span>
                </Link>
              ) : (
                <div key={session.id} className="session-link" aria-disabled="true">
                  <div>
                    <p className="session-title">{session.title}</p>
                    <p className="session-meta">
                      {relativeDate(session.createdAt)} · {formatDuration(session.durationMs)} · Not ready yet
                    </p>
                  </div>
                  <span className={`status-badge status-${session.status}`}>{statusLabel(session.status)}</span>
                </div>
              )
            ))
          )}
        </div>
      </section>
    </main>
  );
}
