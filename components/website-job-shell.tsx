"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { SessionDetail, WebsiteJob } from "@/lib/types";

function websiteStatusLabel(status: WebsiteJob["status"]) {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Generating";
    case "building":
      return "Building";
    case "exporting":
      return "Exporting";
    case "succeeded":
      return "Ready";
    case "failed":
      return "Failed";
  }
}

function formatCreatedAt(isoString: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(isoString));
}

export function WebsiteJobShell({
  session,
  initialJob
}: {
  session: SessionDetail;
  initialJob: WebsiteJob;
}) {
  const [job, setJob] = useState(initialJob);
  const [pollError, setPollError] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);

  useEffect(() => {
    if (job.status === "failed" || job.status === "succeeded") {
      return;
    }

    const handle = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/sessions/${session.id}/websites/${job.id}`, {
          cache: "no-store"
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          setPollError(payload.error || "Failed to refresh website status.");
          if (payload.job) {
            setJob(payload.job as WebsiteJob);
          }
          return;
        }

        setPollError(null);
        setJob(payload as WebsiteJob);
      } catch (error) {
        setPollError(error instanceof Error ? error.message : "Failed to refresh website status.");
      }
    }, 8000);

    return () => window.clearTimeout(handle);
  }, [job, session.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setInfoOpen(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const previewFrameUrl = `/api/sessions/${session.id}/websites/${job.id}/preview/index.html`;
  const isRenderable = job.status === "succeeded" && Boolean(job.distArchiveUrl);

  if (!isRenderable) {
    return (
      <main className="world-loading-page">
        <section className="world-loading-stage">
          <div className="world-loading-grid" />
          <div className="world-loading-sweep" />
          <Link href="/" className="world-loading-back">
            Back home
          </Link>

          <div className="world-loading-card">
            <span className={`status-badge status-${job.status === "succeeded" ? "ready" : job.status}`}>
              {websiteStatusLabel(job.status)}
            </span>
            <h1>{job.status === "failed" ? "Website generation failed" : "Generating your website"}</h1>
            <p className="world-loading-copy">
              {job.errorMessage || job.statusDetail || "Codex is still building the website from your sketch."}
            </p>
            {pollError ? <p className="world-loading-error">{pollError}</p> : null}
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

  return (
    <main className="image-experience-page website-experience-page">
      <section className="website-experience-stage">
        <div className="image-experience-vignette" />

        <header className="image-experience-header">
          <Link href="/" className="image-hud-button image-hud-button-strong">
            Back home
          </Link>

          <div className="image-header-actions">
            <Link href={`/sessions/${session.id}`} className="image-hud-button">
              Session
            </Link>
            {job.codeArchiveUrl ? (
              <a href={job.codeArchiveUrl} className="image-hud-button">
                Source
              </a>
            ) : null}
            {job.distArchiveUrl ? (
              <a href={job.distArchiveUrl} className="image-hud-button">
                Dist
              </a>
            ) : null}
            <button type="button" className="image-hud-button" onClick={() => setInfoOpen((value) => !value)}>
              {infoOpen ? "Close info" : "Info"}
            </button>
          </div>
        </header>

        <div className="website-preview-shell">
          <iframe
            src={previewFrameUrl}
            title={job.displayName}
            className="website-preview-frame"
            loading="eager"
          />
        </div>

        {pollError ? <div className="video-floating-alert">{pollError}</div> : null}

        {infoOpen ? (
          <button
            type="button"
            className="image-info-scrim"
            onClick={() => setInfoOpen(false)}
            aria-label="Close website details"
          />
        ) : null}

        <aside className={`image-info-drawer ${infoOpen ? "open" : ""}`}>
          <div className="image-info-header">
            <div>
              <p className="image-info-kicker">Website details</p>
              <h2>{job.displayName}</h2>
            </div>
            <button type="button" className="image-hud-button" onClick={() => setInfoOpen(false)}>
              Close
            </button>
          </div>

          <div className="image-info-body">
            <section className="image-info-section">
              <p className="image-info-label">Framework</p>
              <p className="image-info-copy">Vite + React + TypeScript</p>
              <p className="image-info-label">Sandbox</p>
              <p className="image-info-copy">{job.sandboxProvider === "vercel" ? "Vercel Sandbox" : job.sandboxProvider}</p>
              <p className="image-info-label">Created</p>
              <p className="image-info-copy">{formatCreatedAt(job.createdAt)}</p>
              <p className="image-info-label">Status</p>
              <p className="image-info-copy">{websiteStatusLabel(job.status)}</p>
              {job.statusDetail ? (
                <>
                  <p className="image-info-label">Latest stage</p>
                  <p className="image-info-copy">{job.statusDetail}</p>
                </>
              ) : null}
            </section>

            <section className="image-info-section">
              <p className="image-info-label">Transcript</p>
              <p className="image-info-copy website-info-preformatted">{job.transcriptText}</p>
            </section>

            <section className="image-info-section">
              <p className="image-info-label">Prompt</p>
              <p className="image-info-copy website-info-preformatted">{job.prompt}</p>
            </section>
          </div>
        </aside>
      </section>
    </main>
  );
}
