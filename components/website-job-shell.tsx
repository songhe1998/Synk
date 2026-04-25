"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent } from "react";
import {
  SessionDetail,
  WebsiteEditAnnotation,
  WebsiteEditDomCandidate,
  WebsiteEditPoint,
  WebsiteEditRect,
  WebsiteEditStroke,
  WebsiteJob
} from "@/lib/types";

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

function strokePath(points: WebsiteEditPoint[]) {
  if (!points.length) {
    return "";
  }

  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(" ");
}

function computeStrokeBbox(strokes: WebsiteEditStroke[]): WebsiteEditRect {
  const points = strokes.flatMap((stroke) => stroke.points);
  if (!points.length) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY)
  };
}

function trimText(value: string | null | undefined, maxLength: number) {
  const trimmed = (value ?? "").replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
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
  const [editOpen, setEditOpen] = useState(false);
  const [editInstruction, setEditInstruction] = useState("");
  const [editStrokes, setEditStrokes] = useState<WebsiteEditStroke[]>([]);
  const [editError, setEditError] = useState<string | null>(null);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [overlaySize, setOverlaySize] = useState({ width: 1, height: 1 });
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const overlayRef = useRef<SVGSVGElement | null>(null);
  const activeStrokeIdRef = useRef<string | null>(null);

  const currentStrokeBbox = useMemo(() => computeStrokeBbox(editStrokes), [editStrokes]);

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
  const canEdit = isRenderable && !editSubmitting;

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) {
      return;
    }

    const updateSize = () => {
      const rect = overlay.getBoundingClientRect();
      setOverlaySize({
        width: Math.max(1, rect.width),
        height: Math.max(1, rect.height)
      });
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(overlay);
    return () => observer.disconnect();
  }, [editOpen]);

  function getOverlayPoint(event: PointerEvent<SVGSVGElement>) {
    const overlay = overlayRef.current;
    if (!overlay) {
      return null;
    }

    const rect = overlay.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, event.clientY - rect.top))
    };
  }

  function beginEditStroke(event: PointerEvent<SVGSVGElement>) {
    if (!canEdit || !editOpen) {
      return;
    }

    const point = getOverlayPoint(event);
    if (!point) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    const strokeId = crypto.randomUUID();
    activeStrokeIdRef.current = strokeId;
    setEditError(null);
    setEditStrokes((strokes) => [...strokes, { id: strokeId, points: [point] }]);
  }

  function appendEditStrokePoint(event: PointerEvent<SVGSVGElement>) {
    const strokeId = activeStrokeIdRef.current;
    if (!strokeId) {
      return;
    }

    const point = getOverlayPoint(event);
    if (!point) {
      return;
    }

    setEditStrokes((strokes) =>
      strokes.map((stroke) =>
        stroke.id === strokeId
          ? {
              ...stroke,
              points: [...stroke.points, point]
            }
          : stroke
      )
    );
  }

  function endEditStroke(event: PointerEvent<SVGSVGElement>) {
    if (activeStrokeIdRef.current) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    activeStrokeIdRef.current = null;
  }

  function getElementSelector(element: Element) {
    if (element.id) {
      return `#${CSS.escape(element.id)}`;
    }

    const parts: string[] = [];
    let current: Element | null = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && current.tagName.toLowerCase() !== "html") {
      const currentElement: Element = current;
      const tag = currentElement.tagName.toLowerCase();
      const classList = Array.from(currentElement.classList).slice(0, 2);
      const classSuffix = classList.length ? `.${classList.map((value) => CSS.escape(value)).join(".")}` : "";
      const parent: Element | null = currentElement.parentElement;
      const siblings = parent
        ? Array.from(parent.children).filter((child) => child.tagName === currentElement.tagName)
        : [];
      const nth = parent && siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(currentElement) + 1})` : "";
      parts.unshift(`${tag}${classSuffix}${nth}`);
      current = parent;
      if (parts.length >= 5) {
        break;
      }
    }

    return parts.join(" > ") || element.tagName.toLowerCase();
  }

  function collectDomCandidates(): WebsiteEditDomCandidate[] {
    const frame = iframeRef.current;
    const doc = frame?.contentDocument;
    if (!frame || !doc?.body) {
      return [];
    }

    const allElements = Array.from(doc.body.querySelectorAll("*"));
    const viewportWidth = frame.clientWidth;
    const viewportHeight = frame.clientHeight;
    const expandedBbox = {
      x: currentStrokeBbox.x - 48,
      y: currentStrokeBbox.y - 48,
      width: currentStrokeBbox.width + 96,
      height: currentStrokeBbox.height + 96
    };

    return allElements
      .map((element, index) => {
        const rect = element.getBoundingClientRect();
        if (rect.width < 3 || rect.height < 3) {
          return null;
        }

        if (rect.right < 0 || rect.bottom < 0 || rect.left > viewportWidth || rect.top > viewportHeight) {
          return null;
        }

        const style = doc.defaultView?.getComputedStyle(element);
        if (!style || style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
          return null;
        }

        const candidateRect = {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height
        };
        const overlapsAnnotation =
          candidateRect.x < expandedBbox.x + expandedBbox.width &&
          candidateRect.x + candidateRect.width > expandedBbox.x &&
          candidateRect.y < expandedBbox.y + expandedBbox.height &&
          candidateRect.y + candidateRect.height > expandedBbox.y;
        if (!overlapsAnnotation) {
          return null;
        }

        return {
          id: `dom-${index + 1}`,
          selector: getElementSelector(element),
          tagName: element.tagName.toLowerCase(),
          role: element.getAttribute("role"),
          text: trimText(element.textContent, 260),
          ariaLabel: trimText(element.getAttribute("aria-label"), 180),
          className:
            typeof element.className === "string"
              ? trimText(element.className, 240)
              : trimText(element.getAttribute("class"), 240),
          rect: candidateRect
        };
      })
      .filter((candidate): candidate is WebsiteEditDomCandidate => Boolean(candidate))
      .slice(0, 180);
  }

  async function submitWebsiteEdit() {
    if (!canEdit) {
      return;
    }

    const trimmedInstruction = editInstruction.trim();
    if (!trimmedInstruction) {
      setEditError("Add an edit request before submitting.");
      return;
    }

    if (!editStrokes.length) {
      setEditError("Draw on the website before submitting.");
      return;
    }

    const frame = iframeRef.current;
    const doc = frame?.contentDocument;
    const annotation: WebsiteEditAnnotation = {
      viewportWidth: overlaySize.width,
      viewportHeight: overlaySize.height,
      devicePixelRatio: window.devicePixelRatio || 1,
      path: doc?.location.pathname || "/",
      scrollX: doc?.defaultView?.scrollX ?? 0,
      scrollY: doc?.defaultView?.scrollY ?? 0,
      bbox: currentStrokeBbox,
      strokes: editStrokes
    };

    setEditSubmitting(true);
    setEditError(null);
    try {
      const response = await fetch(`/api/sessions/${session.id}/websites/${job.id}/edits`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          instructionText: trimmedInstruction,
          annotation,
          domCandidates: collectDomCandidates()
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Failed to start website edit.");
      }

      const nextJob = payload as WebsiteJob;
      window.location.assign(`/sessions/${session.id}/websites/${nextJob.id}`);
    } catch (error) {
      setEditError(error instanceof Error ? error.message : "Failed to start website edit.");
      setEditSubmitting(false);
    }
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
              {websiteStatusLabel(job.status)}
            </span>
            <h1>
              {job.status === "failed"
                ? job.jobKind === "edit"
                  ? "Website edit failed"
                  : "Website generation failed"
                : job.jobKind === "edit"
                  ? "Applying your website edit"
                  : "Generating your website"}
            </h1>
            <p className="world-loading-copy">
              {job.errorMessage ||
                job.statusDetail ||
                (job.jobKind === "edit"
                  ? "Codex is updating the selected part of your website."
                  : "Codex is still building the website from your sketch.")}
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
            <button
              type="button"
              className={`image-hud-button ${editOpen ? "website-edit-active" : ""}`}
              onClick={() => {
                setEditOpen((value) => !value);
                setEditError(null);
              }}
            >
              Edit
            </button>
            <button type="button" className="image-hud-button" onClick={() => setInfoOpen((value) => !value)}>
              {infoOpen ? "Close info" : "Info"}
            </button>
          </div>
        </header>

        <div className="website-preview-shell">
          <iframe
            ref={iframeRef}
            src={previewFrameUrl}
            title={job.displayName}
            className="website-preview-frame"
            loading="eager"
          />
          {editOpen ? (
            <svg
              ref={overlayRef}
              className="website-edit-overlay"
              viewBox={`0 0 ${overlaySize.width} ${overlaySize.height}`}
              onPointerDown={beginEditStroke}
              onPointerMove={appendEditStrokePoint}
              onPointerUp={endEditStroke}
              onPointerCancel={endEditStroke}
            >
              {editStrokes.map((stroke) => (
                <path key={stroke.id} d={strokePath(stroke.points)} className="website-edit-stroke" />
              ))}
            </svg>
          ) : null}
        </div>

        {pollError ? <div className="video-floating-alert">{pollError}</div> : null}
        {editOpen ? (
          <form
            className="website-edit-panel"
            onSubmit={(event) => {
              event.preventDefault();
              void submitWebsiteEdit();
            }}
          >
            <textarea
              value={editInstruction}
              onChange={(event) => setEditInstruction(event.target.value)}
              placeholder="Make this a little bigger"
              rows={3}
              disabled={editSubmitting}
            />
            <div className="website-edit-actions">
              <button
                type="button"
                className="image-hud-button"
                onClick={() => {
                  setEditStrokes([]);
                  setEditError(null);
                }}
                disabled={editSubmitting || !editStrokes.length}
              >
                Clear
              </button>
              <button type="submit" className="image-hud-button image-hud-button-strong" disabled={editSubmitting}>
                {editSubmitting ? "Starting" : "Apply"}
              </button>
            </div>
            {editError ? <p className="website-edit-error">{editError}</p> : null}
          </form>
        ) : null}

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
              <p className="image-info-label">Revision</p>
              <p className="image-info-copy">
                {job.jobKind === "edit" ? `Edit v${job.revisionNumber}` : `Initial v${job.revisionNumber}`}
              </p>
              {job.statusDetail ? (
                <>
                  <p className="image-info-label">Latest stage</p>
                  <p className="image-info-copy">{job.statusDetail}</p>
                </>
              ) : null}
            </section>

            {job.editInstructionText ? (
              <section className="image-info-section">
                <p className="image-info-label">Edit request</p>
                <p className="image-info-copy website-info-preformatted">{job.editInstructionText}</p>
                {job.editTarget ? (
                  <>
                    <p className="image-info-label">Resolved target</p>
                    <p className="image-info-copy website-info-preformatted">
                      {job.editTarget.targetDescription}
                      {"\n"}
                      Confidence: {job.editTarget.confidence.toFixed(2)}
                    </p>
                  </>
                ) : null}
              </section>
            ) : null}

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
