"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { DEMO_CANVAS, applyDrawingEvent, createEmptyDrawingState, drawDrawingState, formatDuration } from "@/lib/drawing";
import { DrawingEvent, DrawingState, DrawingTool, SessionSummary } from "@/lib/types";

const PEN_COLORS = ["#20222b", "#f05a28", "#1f7a8c", "#208d64", "#c13c6f"];

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

function makeTitle() {
  return `Live Demo ${new Date().toLocaleString()}`;
}

export function RecorderShell({ initialSessions }: { initialSessions: SessionSummary[] }) {
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingStateRef = useRef<DrawingState>(createEmptyDrawingState());
  const eventsRef = useRef<DrawingEvent[]>([]);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const activeStrokeIdRef = useRef<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const startedAtRef = useRef<number | null>(null);

  const [phase, setPhase] = useState<"idle" | "recording" | "uploading" | "processing" | "error">("idle");
  const [tool, setTool] = useState<DrawingTool>("pen");
  const [color, setColor] = useState(PEN_COLORS[0]);
  const [brushWidth, setBrushWidth] = useState(6);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [liveStrokeCount, setLiveStrokeCount] = useState(0);
  const [canRedo, setCanRedo] = useState(false);
  const [sessions, setSessions] = useState(initialSessions);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    drawDrawingState(context, drawingStateRef.current, DEMO_CANVAS.width, DEMO_CANVAS.height);
  }, []);

  useEffect(() => {
    if (phase !== "recording") {
      return;
    }

    const handle = window.setInterval(() => {
      if (!startedAtRef.current) {
        return;
      }
      setElapsedMs(Math.round(performance.now() - startedAtRef.current));
    }, 120);

    return () => window.clearInterval(handle);
  }, [phase]);

  function redrawCanvas() {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    drawDrawingState(context, drawingStateRef.current, DEMO_CANVAS.width, DEMO_CANVAS.height);
    setLiveStrokeCount(drawingStateRef.current.strokes.length);
    setCanRedo(drawingStateRef.current.undoneStrokes.length > 0);
  }

  function getEventTime() {
    if (!startedAtRef.current) {
      return 0;
    }
    return Math.max(0, Math.round(performance.now() - startedAtRef.current));
  }

  function getCanvasPoint(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const scaleX = DEMO_CANVAS.width / rect.width;
    const scaleY = DEMO_CANVAS.height / rect.height;
    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY,
      pressure: event.pressure > 0 ? event.pressure : 0.5
    };
  }

  function pushEvent(event: DrawingEvent) {
    eventsRef.current.push(event);
    applyDrawingEvent(drawingStateRef.current, event);
    redrawCanvas();
  }

  async function refreshRecentSessions() {
    const response = await fetch("/api/sessions/recent", { cache: "no-store" });
    if (!response.ok) {
      return;
    }
    const payload = (await response.json()) as SessionSummary[];
    setSessions(payload);
  }

  async function startRecording() {
    setErrorMessage(null);

    try {
      const sessionResponse = await fetch("/api/sessions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          title: makeTitle()
        })
      });

      if (!sessionResponse.ok) {
        throw new Error("Failed to create a session.");
      }

      const session = (await sessionResponse.json()) as SessionSummary;
      sessionIdRef.current = session.id;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true
      });
      mediaStreamRef.current = stream;

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];

      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      });

      recorder.addEventListener("stop", async () => {
        const activeSessionId = sessionIdRef.current;
        if (!activeSessionId) {
          return;
        }

        setPhase("uploading");

        try {
          const durationMs = getEventTime();
          const audioType = recorder.mimeType || "audio/webm";
          const audioBlob = new Blob(audioChunksRef.current, { type: audioType });
          const sketchBlob = await new Promise<Blob | null>((resolve) => {
            const canvas = canvasRef.current;
            if (!canvas) {
              resolve(null);
              return;
            }
            canvas.toBlob((blob) => resolve(blob), "image/png");
          });
          const uploadForm = new FormData();
          uploadForm.append("audio", new File([audioBlob], "audio.webm", { type: audioType }));
          if (sketchBlob) {
            uploadForm.append("sketch", new File([sketchBlob], "sketch.png", { type: "image/png" }));
          }
          uploadForm.append("events", JSON.stringify(eventsRef.current));
          uploadForm.append("durationMs", String(durationMs));
          uploadForm.append("canvasWidth", String(DEMO_CANVAS.width));
          uploadForm.append("canvasHeight", String(DEMO_CANVAS.height));

          const uploadResponse = await fetch(`/api/sessions/${activeSessionId}/upload`, {
            method: "POST",
            body: uploadForm
          });

          if (!uploadResponse.ok) {
            const payload = await uploadResponse.json().catch(() => ({}));
            throw new Error(payload.error || "Failed to upload session.");
          }

          setPhase("processing");

          const processResponse = await fetch(`/api/sessions/${activeSessionId}/process`, {
            method: "POST"
          });

          if (!processResponse.ok) {
            const payload = await processResponse.json().catch(() => ({}));
            throw new Error(payload.error || "Failed to transcribe the recording.");
          }

          await refreshRecentSessions();
          router.push(`/sessions/${activeSessionId}`);
        } catch (error) {
          setPhase("error");
          setErrorMessage(error instanceof Error ? error.message : "Failed to finish the session.");
          await refreshRecentSessions();
        }
      });

      drawingStateRef.current = createEmptyDrawingState();
      eventsRef.current = [];
      activeStrokeIdRef.current = null;
      startedAtRef.current = performance.now();
      setElapsedMs(0);
      setLiveStrokeCount(0);
      setCanRedo(false);
      redrawCanvas();

      recorder.start();
      setPhase("recording");
      await refreshRecentSessions();
    } catch (error) {
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
      }
      setPhase("error");
      setErrorMessage(error instanceof Error ? error.message : "Unable to start recording.");
    }
  }

  function stopRecording() {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      return;
    }

    recorder.stop();
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
  }

  function handlePointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (phase !== "recording") {
      return;
    }

    const point = getCanvasPoint(event);
    const strokeId = crypto.randomUUID();
    activeStrokeIdRef.current = strokeId;
    event.currentTarget.setPointerCapture(event.pointerId);

    pushEvent({
      type: "stroke_begin",
      strokeId,
      tool,
      color,
      width: brushWidth,
      x: point.x,
      y: point.y,
      pressure: point.pressure,
      tMs: getEventTime()
    });
  }

  function handlePointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (phase !== "recording" || !activeStrokeIdRef.current) {
      return;
    }

    const point = getCanvasPoint(event);
    pushEvent({
      type: "stroke_point",
      strokeId: activeStrokeIdRef.current,
      x: point.x,
      y: point.y,
      pressure: point.pressure,
      tMs: getEventTime()
    });
  }

  function finishStroke(event: React.PointerEvent<HTMLCanvasElement>) {
    if (phase !== "recording" || !activeStrokeIdRef.current) {
      return;
    }

    const point = getCanvasPoint(event);
    pushEvent({
      type: "stroke_end",
      strokeId: activeStrokeIdRef.current,
      x: point.x,
      y: point.y,
      pressure: point.pressure,
      tMs: getEventTime()
    });
    activeStrokeIdRef.current = null;
  }

  function handleUndo() {
    if (phase !== "recording" || drawingStateRef.current.strokes.length === 0) {
      return;
    }

    pushEvent({
      type: "undo",
      tMs: getEventTime()
    });
  }

  function handleRedo() {
    if (phase !== "recording" || drawingStateRef.current.undoneStrokes.length === 0) {
      return;
    }

    pushEvent({
      type: "redo",
      tMs: getEventTime()
    });
  }

  function handleClear() {
    if (phase !== "recording") {
      return;
    }

    pushEvent({
      type: "clear",
      tMs: getEventTime()
    });
  }

  const isBusy = phase === "uploading" || phase === "processing";

  return (
    <main className="page-shell">
      <section className="hero-card">
        <div className="hero-copy">
          <p className="eyebrow">Synk Demo</p>
          <h1>Record the board and the voice on one timeline.</h1>
          <p className="hero-text">
            Start a live session, sketch while speaking, then jump straight into replay with synced audio,
            tokens, and strokes.
          </p>
        </div>
        <div className="hero-metrics">
          <div className="metric-panel">
            <span>Timer</span>
            <strong>{formatDuration(elapsedMs)}</strong>
          </div>
          <div className="metric-panel">
            <span>Strokes</span>
            <strong>{liveStrokeCount}</strong>
          </div>
          <div className="metric-panel">
            <span>Status</span>
            <strong>{phase}</strong>
          </div>
        </div>
      </section>

      <section className="workspace-grid">
        <div className="panel canvas-panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Recorder</p>
              <h2>Live whiteboard</h2>
            </div>
            <div className="status-chip">{phase === "idle" ? "Ready to record" : phase}</div>
          </div>

          <div className="toolbar-row">
            <div className="segmented-control">
              <button
                type="button"
                className={tool === "pen" ? "active" : ""}
                onClick={() => setTool("pen")}
                disabled={isBusy}
              >
                Pen
              </button>
              <button
                type="button"
                className={tool === "eraser" ? "active" : ""}
                onClick={() => setTool("eraser")}
                disabled={isBusy}
              >
                Eraser
              </button>
            </div>

            <div className="color-row">
              {PEN_COLORS.map((penColor) => (
                <button
                  key={penColor}
                  type="button"
                  className={`color-swatch ${color === penColor ? "selected" : ""}`}
                  style={{ backgroundColor: penColor }}
                  onClick={() => setColor(penColor)}
                  disabled={tool === "eraser" || isBusy}
                  aria-label={`Select ${penColor}`}
                />
              ))}
            </div>

            <label className="range-control">
              <span>Brush</span>
              <input
                type="range"
                min={2}
                max={24}
                step={1}
                value={brushWidth}
                onChange={(event) => setBrushWidth(Number.parseInt(event.target.value, 10))}
                disabled={isBusy}
              />
              <strong>{brushWidth}px</strong>
            </label>
          </div>

          <div className="action-row">
            {phase === "idle" || phase === "error" ? (
              <button type="button" className="primary-button" onClick={startRecording}>
                Start session
              </button>
            ) : (
              <button
                type="button"
                className="primary-button stop-button"
                onClick={stopRecording}
                disabled={isBusy}
              >
                Stop and process
              </button>
            )}

            <button type="button" className="ghost-button" onClick={handleUndo} disabled={phase !== "recording"}>
              Undo
            </button>
            <button type="button" className="ghost-button" onClick={handleRedo} disabled={phase !== "recording" || !canRedo}>
              Redo
            </button>
            <button type="button" className="ghost-button" onClick={handleClear} disabled={phase !== "recording"}>
              Clear
            </button>
          </div>

          <div className="canvas-frame">
            <canvas
              ref={canvasRef}
              width={DEMO_CANVAS.width}
              height={DEMO_CANVAS.height}
              className="recording-canvas"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={finishStroke}
              onPointerCancel={finishStroke}
            />
          </div>

          <div className="footnote-row">
            <span>Chrome demo path: MediaRecorder + local event timeline + server transcription.</span>
            <span>No live subtitles while recording.</span>
          </div>

          {errorMessage ? <p className="error-banner">{errorMessage}</p> : null}
        </div>

        <aside className="panel session-panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Recent</p>
              <h2>Saved sessions</h2>
            </div>
            <button type="button" className="ghost-button" onClick={refreshRecentSessions}>
              Refresh
            </button>
          </div>

          <div className="session-list">
            {sessions.length === 0 ? (
              <p className="empty-copy">No sessions yet. Record one to populate the replay list.</p>
            ) : (
              sessions.map((session) => (
                <Link key={session.id} href={`/sessions/${session.id}`} className="session-link">
                  <div>
                    <p className="session-title">{session.title}</p>
                    <p className="session-meta">
                      {relativeDate(session.createdAt)} · {formatDuration(session.durationMs)}
                    </p>
                  </div>
                  <span className={`status-badge status-${session.status}`}>{statusLabel(session.status)}</span>
                </Link>
              ))
            )}
          </div>
        </aside>
      </section>
    </main>
  );
}
