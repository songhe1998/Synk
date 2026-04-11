"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { SessionDetail, WorldJob } from "@/lib/types";

const WorldViewer = dynamic(
  () => import("@/components/world-viewer").then((module) => ({ default: module.WorldViewer })),
  {
    ssr: false,
    loading: () => <div className="world-viewer-placeholder">Preparing immersive viewer...</div>
  }
);

type WorldQuality = "100k" | "500k" | "full";

function hasRenderableWorld(job: WorldJob) {
  return Boolean(job.world?.spz100kUrl || job.world?.spz500kUrl || job.world?.spzFullResUrl);
}

function formatCreatedAt(isoString: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(isoString));
}

function worldStatusLabel(status: WorldJob["status"]) {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Generating";
    case "succeeded":
      return "Ready";
    case "failed":
      return "Failed";
  }
}

function defaultWorldQuality(job: WorldJob): WorldQuality {
  const prefersMobile = typeof window !== "undefined" ? window.innerWidth < 760 : false;

  if (prefersMobile && job.world?.spz100kUrl) {
    return "100k";
  }

  if (job.world?.spz500kUrl) {
    return "500k";
  }

  if (job.world?.spzFullResUrl) {
    return "full";
  }

  return job.world?.spz100kUrl ? "100k" : "500k";
}

function getWorldUrl(job: WorldJob, quality: WorldQuality) {
  if (!job.world) {
    return null;
  }

  switch (quality) {
    case "100k":
      return job.world.spz100kUrl ?? job.world.spz500kUrl ?? job.world.spzFullResUrl;
    case "500k":
      return job.world.spz500kUrl ?? job.world.spzFullResUrl ?? job.world.spz100kUrl;
    case "full":
      return job.world.spzFullResUrl ?? job.world.spz500kUrl ?? job.world.spz100kUrl;
  }
}

function worldStatusCopy(job: WorldJob) {
  if (job.status === "failed") {
    return {
      title: "World generation failed",
      body: job.errorMessage || "World Labs did not return a renderable world for this request."
    };
  }

  if (job.status === "running") {
    return {
      title: "Generating your 3D world",
      body: "World Labs is still assembling the explorable scene. This usually takes a few minutes."
    };
  }

  if (job.status === "queued") {
    return {
      title: "Queuing the world job",
      body: "The source image is uploaded and the generation request is in line."
    };
  }

  return {
    title: "Preparing the immersive viewer",
    body: "The world is ready, but the splat assets are still syncing into the viewer."
  };
}

export function WorldJobShell({
  session,
  initialJob
}: {
  session: SessionDetail;
  initialJob: WorldJob;
}) {
  const [job, setJob] = useState(initialJob);
  const [selectedQuality, setSelectedQuality] = useState<WorldQuality>(() => defaultWorldQuality(initialJob));
  const [pollError, setPollError] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);
  const [instructionCycle, setInstructionCycle] = useState(0);
  const [recenterSignal, setRecenterSignal] = useState(0);

  useEffect(() => {
    setSelectedQuality(defaultWorldQuality(job));
  }, [job.id]);

  useEffect(() => {
    const activeUrl = getWorldUrl(job, selectedQuality);
    if (activeUrl) {
      return;
    }

    setSelectedQuality(defaultWorldQuality(job));
  }, [job, selectedQuality]);

  useEffect(() => {
    if (job.status === "failed" || (job.status === "succeeded" && hasRenderableWorld(job))) {
      return;
    }

    const handle = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/sessions/${session.id}/worlds/${job.id}`, {
          cache: "no-store"
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          setPollError(payload.error || "Failed to refresh world status.");
          if (payload.job) {
            setJob(payload.job as WorldJob);
          }
          return;
        }

        setPollError(null);
        setJob(payload as WorldJob);
      } catch (error) {
        setPollError(error instanceof Error ? error.message : "Failed to refresh world status.");
      }
    }, 12000);

    return () => window.clearTimeout(handle);
  }, [job, session.id]);

  const activeWorldUrl = getWorldUrl(job, selectedQuality);
  const qualityOptions = useMemo(
    () =>
      [
        { key: "100k" as const, label: "100k", available: Boolean(job.world?.spz100kUrl) },
        { key: "500k" as const, label: "500k", available: Boolean(job.world?.spz500kUrl) },
        { key: "full" as const, label: "HD", available: Boolean(job.world?.spzFullResUrl) }
      ].filter((option) => option.available),
    [job.world]
  );
  const isRenderable = job.status === "succeeded" && Boolean(activeWorldUrl);
  const statusCopy = worldStatusCopy(job);

  useEffect(() => {
    if (!isRenderable) {
      setShowInstructions(false);
      return;
    }

    setShowInstructions(true);
    const handle = window.setTimeout(() => setShowInstructions(false), 6200);
    return () => window.clearTimeout(handle);
  }, [instructionCycle, isRenderable, job.id, selectedQuality]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setInfoOpen(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function revealInstructions() {
    setInstructionCycle((value) => value + 1);
  }

  function requestRecenter() {
    setRecenterSignal((value) => value + 1);
  }

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
              {worldStatusLabel(job.status)}
            </span>
            <h1>{statusCopy.title}</h1>
            <p className="world-loading-copy">{statusCopy.body}</p>
            {job.statusDetail ? <p className="world-loading-detail">{job.statusDetail}</p> : null}
            {pollError ? <p className="world-loading-error">{pollError}</p> : null}
            {job.errorMessage ? <p className="world-loading-error">{job.errorMessage}</p> : null}
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
    <main className="world-experience-page">
      <section className="world-experience-stage">
        {activeWorldUrl ? (
          <WorldViewer
            key={`${job.id}-${selectedQuality}-${activeWorldUrl}`}
            url={activeWorldUrl}
            displayName={job.displayName}
            thumbnailUrl={job.world?.thumbnailUrl ?? null}
            groundPlaneOffset={job.world?.groundPlaneOffset ?? null}
            metricScaleFactor={job.world?.metricScaleFactor ?? null}
            recenterSignal={recenterSignal}
          />
        ) : null}

        <div className="world-experience-vignette" />

        <header className="world-experience-header">
          <Link href="/" className="world-hud-button world-hud-button-strong">
            Back home
          </Link>

          <div className="world-title-card">
            <p className="world-title-kicker">3D world</p>
            <h1>{job.displayName}</h1>
            <div className="world-title-meta">
              <span className={`status-badge status-${job.status === "succeeded" ? "ready" : job.status}`}>
                {worldStatusLabel(job.status)}
              </span>
              <span>{formatCreatedAt(job.createdAt)}</span>
              <span>{selectedQuality === "full" ? "HD splats" : `${selectedQuality} splats`}</span>
            </div>
          </div>

          <div className="world-header-actions">
            {job.world?.worldMarbleUrl ? (
              <a
                href={job.world.worldMarbleUrl}
                target="_blank"
                rel="noreferrer"
                className="world-hud-button"
              >
                Open in Marble
              </a>
            ) : null}
            <button type="button" className="world-hud-button" onClick={() => setInfoOpen((value) => !value)}>
              {infoOpen ? "Close info" : "Info"}
            </button>
          </div>
        </header>

        {pollError ? <div className="world-floating-alert">{pollError}</div> : null}

        <div className={`world-instructions ${showInstructions ? "visible" : ""}`}>
          <strong>Move through the world</strong>
          <span>Drag to look around, scroll to glide, use WASD to move, and double-click or tap Recenter.</span>
        </div>

        <div className="world-bottom-dock">
          {qualityOptions.length > 1 ? (
            <div className="world-quality-switch">
              {qualityOptions.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  className={selectedQuality === option.key ? "active" : ""}
                  onClick={() => setSelectedQuality(option.key)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}

          <button type="button" className="world-dock-button" onClick={requestRecenter}>
            Recenter
          </button>

          <button type="button" className="world-dock-button" onClick={revealInstructions}>
            Controls
          </button>

          {job.world?.panoUrl ? (
            <a href={job.world.panoUrl} target="_blank" rel="noreferrer" className="world-dock-button">
              Panorama
            </a>
          ) : null}

          <button type="button" className="world-dock-button" onClick={() => setInfoOpen(true)}>
            Details
          </button>
        </div>

        {infoOpen ? (
          <button
            type="button"
            className="world-info-scrim"
            onClick={() => setInfoOpen(false)}
            aria-label="Close world details"
          />
        ) : null}

        <aside className={`world-info-drawer ${infoOpen ? "open" : ""}`}>
          <div className="world-info-header">
            <div>
              <p className="world-title-kicker">World details</p>
              <h2>{job.displayName}</h2>
            </div>
            <button type="button" className="world-hud-button" onClick={() => setInfoOpen(false)}>
              Close
            </button>
          </div>

          <div className="world-info-body">
            <section className="world-info-section">
              <p className="world-info-label">Final prompt</p>
              <p className="world-info-copy">{job.prompt}</p>
            </section>

            {session.annotatedSketchUrl ? (
              <section className="world-info-section">
                <p className="world-info-label">Labeled sketch</p>
                <img src={session.annotatedSketchUrl} alt="Labeled sketch" className="world-info-image" />
              </section>
            ) : null}

            {job.world?.caption ? (
              <section className="world-info-section">
                <p className="world-info-label">Caption</p>
                <p className="world-info-copy">{job.world.caption}</p>
              </section>
            ) : null}

            {job.world ? (
              <section className="world-info-section">
                <p className="world-info-label">Open</p>
                <div className="world-info-links">
                  {job.world.worldMarbleUrl ? (
                    <a href={job.world.worldMarbleUrl} target="_blank" rel="noreferrer" className="world-hud-button">
                      Open in Marble
                    </a>
                  ) : null}
                  {job.world.panoUrl ? (
                    <a href={job.world.panoUrl} target="_blank" rel="noreferrer" className="world-hud-button">
                      View panorama
                    </a>
                  ) : null}
                  {job.world.thumbnailUrl ? (
                    <a href={job.world.thumbnailUrl} target="_blank" rel="noreferrer" className="world-hud-button">
                      Open thumbnail
                    </a>
                  ) : null}
                </div>
              </section>
            ) : null}
          </div>
        </aside>
      </section>
    </main>
  );
}
