"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { SessionDetail, VideoJob } from "@/lib/types";

function videoStatusLabel(status: VideoJob["status"]) {
  switch (status) {
    case "queued":
      return "Queued";
    case "uploading":
      return "Uploading";
    case "running":
      return "Generating";
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

export function VideoJobShell({
  session,
  initialJob
}: {
  session: SessionDetail;
  initialJob: VideoJob;
}) {
  const [job, setJob] = useState(initialJob);
  const [pollError, setPollError] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const sketchReferenceUrl =
    job.pipelineMode === "dynamic" ? session.videoAnnotatedSketchUrl || session.annotatedSketchUrl : session.annotatedSketchUrl;
  const referenceAssets = [
    sketchReferenceUrl
      ? {
          id: "labeled-sketch",
          label: job.pipelineMode === "dynamic" && session.videoAnnotatedSketchUrl ? "Video labeled sketch" : "Labeled sketch",
          note: job.pipelineMode === "dynamic" && session.videoAnnotatedSketchUrl
            ? "Video-specific grounded sketch with labels and callouts"
            : "Grounded sketch with labels and callouts",
          url: sketchReferenceUrl
        }
      : null,
    job.sourceImageUrl
      ? {
          id: "generated-image",
          label: "Video source image",
          note: "The generated source frame used as the video input",
          url: job.sourceImageUrl
        }
      : null
  ].filter((asset): asset is { id: string; label: string; note: string; url: string } => Boolean(asset));

  useEffect(() => {
    if (job.status === "failed" || (job.status === "succeeded" && job.videoUrl)) {
      return;
    }

    const handle = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/sessions/${session.id}/videos/${job.id}`, {
          cache: "no-store"
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          setPollError(payload.error || "Failed to refresh video status.");
          if (payload.job) {
            setJob(payload.job as VideoJob);
          }
          return;
        }

        setPollError(null);
        setJob(payload as VideoJob);
      } catch (error) {
        setPollError(error instanceof Error ? error.message : "Failed to refresh video status.");
      }
    }, 10000);

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

  const isRenderable = job.status === "succeeded" && Boolean(job.videoUrl);

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
              {videoStatusLabel(job.status)}
            </span>
            <h1>
              {job.status === "failed"
                ? "Video generation failed"
                : job.status === "uploading"
                  ? "Uploading the source image"
                  : "Generating your video"}
            </h1>
            <p className="world-loading-copy">
              {job.errorMessage || job.statusDetail || "MuAPI is still processing the generated video."}
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
    <main className="image-experience-page">
      <section className="image-experience-stage">
        {job.sourceImageUrl ? (
          <img src={job.sourceImageUrl} alt={`${job.displayName} source`} className="image-experience-background" />
        ) : null}

        {job.videoUrl ? (
          <video
            src={job.videoUrl}
            className="video-experience-player"
            controls
            autoPlay
            loop
            playsInline
            muted
          />
        ) : (
          <div className="image-experience-empty">No generated video is available for this job yet.</div>
        )}

        <div className="image-experience-vignette" />

        <header className="image-experience-header">
          <Link href="/" className="image-hud-button image-hud-button-strong">
            Back home
          </Link>

          <div className="image-header-actions">
            <Link href={`/sessions/${session.id}`} className="image-hud-button">
              Session
            </Link>
            <button type="button" className="image-hud-button" onClick={() => setInfoOpen((value) => !value)}>
              {infoOpen ? "Close info" : "Info"}
            </button>
          </div>
        </header>

        {referenceAssets.length > 0 ? (
          <aside className="video-reference-rail" aria-label="Video references">
            {referenceAssets.map((asset) => (
              <a
                key={asset.id}
                href={asset.url}
                target="_blank"
                rel="noreferrer"
                className="video-reference-card"
              >
                <div className="video-reference-copy">
                  <span className="video-reference-kicker">{asset.label}</span>
                  <span className="video-reference-note">{asset.note}</span>
                </div>
                <img src={asset.url} alt={asset.label} className="video-reference-image" />
              </a>
            ))}
          </aside>
        ) : null}

        {pollError ? <div className="video-floating-alert">{pollError}</div> : null}

        {infoOpen ? (
          <button
            type="button"
            className="image-info-scrim"
            onClick={() => setInfoOpen(false)}
            aria-label="Close video details"
          />
        ) : null}

        <aside className={`image-info-drawer ${infoOpen ? "open" : ""}`}>
          <div className="image-info-header">
            <div>
              <p className="image-info-kicker">Video details</p>
              <h2>{job.displayName}</h2>
            </div>
            <button type="button" className="image-hud-button" onClick={() => setInfoOpen(false)}>
              Close
            </button>
          </div>

          <div className="image-info-body">
            <section className="image-info-section">
              <p className="image-info-label">Model</p>
              <p className="image-info-copy">
                {job.requestedModel} · {job.pipelineMode === "dynamic" ? "Dynamic" : "Normal"} ·{" "}
                {job.modelPreset === "quality" ? "Quality" : "Lite"}
              </p>
              {job.sourceImagePromptModel ? (
                <>
                  <p className="image-info-label">Source planner</p>
                  <p className="image-info-copy">{job.sourceImagePromptModel}</p>
                </>
              ) : null}
              {job.promptModel ? (
                <>
                  <p className="image-info-label">Prompt writer</p>
                  <p className="image-info-copy">{job.promptModel}</p>
                </>
              ) : null}
              <p className="image-info-label">Created</p>
              <p className="image-info-copy">{formatCreatedAt(job.createdAt)}</p>
              <p className="image-info-label">Duration</p>
              <p className="image-info-copy">{job.durationSeconds}s</p>
              {job.aspectRatio ? (
                <>
                  <p className="image-info-label">Aspect ratio</p>
                  <p className="image-info-copy">{job.aspectRatio}</p>
                </>
              ) : null}
              {job.resolution ? (
                <>
                  <p className="image-info-label">Resolution</p>
                  <p className="image-info-copy">{job.resolution}</p>
                </>
              ) : null}
            </section>

            {job.sourceImagePrompt ? (
              <section className="image-info-section">
                <p className="image-info-label">Video source image prompt</p>
                <p className="image-info-copy">{job.sourceImagePrompt}</p>
              </section>
            ) : null}

            <section className="image-info-section">
              <p className="image-info-label">Optimized prompt</p>
              <p className="image-info-copy">{job.prompt}</p>
            </section>

            {job.transcriptText ? (
              <section className="image-info-section">
                <p className="image-info-label">Transcript</p>
                <p className="image-info-copy">{job.transcriptText}</p>
              </section>
            ) : null}

            {sketchReferenceUrl ? (
              <section className="image-info-section">
                <p className="image-info-label">
                  {job.pipelineMode === "dynamic" && session.videoAnnotatedSketchUrl
                    ? "Video labeled sketch"
                    : "Labeled sketch"}
                </p>
                <img
                  src={sketchReferenceUrl}
                  alt={job.pipelineMode === "dynamic" && session.videoAnnotatedSketchUrl ? "Video labeled sketch" : "Labeled sketch"}
                  className="image-info-image"
                />
              </section>
            ) : null}

            {job.sourceImageUrl ? (
              <section className="image-info-section">
                <p className="image-info-label">Video source image</p>
                <img src={job.sourceImageUrl} alt="Generated image used for the video" className="image-info-image" />
              </section>
            ) : null}
          </div>
        </aside>
      </section>
    </main>
  );
}
