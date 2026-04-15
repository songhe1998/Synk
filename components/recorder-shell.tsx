"use client";

import type { Route } from "next";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { DEMO_CANVAS, applyDrawingEvent, createEmptyDrawingState, drawDrawingState, formatDuration } from "@/lib/drawing";
import {
  AnalysisReasoningEffort,
  DrawingEvent,
  DrawingState,
  DrawingTool,
  ImageGenerationProfile,
  ImageSizePreset,
  SessionSummary,
  VideoModelPreset,
  VideoPipelineMode
} from "@/lib/types";

const DEFAULT_PEN_COLOR = "#20222b";
const REASONING_EFFORTS: AnalysisReasoningEffort[] = ["low", "medium", "high"];
const IMAGE_SIZE_PRESETS: ImageSizePreset[] = ["small", "medium", "large"];
const IMAGE_GENERATION_PROFILES: ImageGenerationProfile[] = ["pro", "fast"];
const VIDEO_MODEL_PRESETS: VideoModelPreset[] = ["quality", "lite"];
const VIDEO_PIPELINE_MODES: VideoPipelineMode[] = ["normal", "dynamic"];
type OutputTarget = "image" | "world" | "video";
type RecorderPhase = "idle" | "recording" | "uploading" | "processing" | "creating" | "error";

function outputTargetResult(target: OutputTarget) {
  switch (target) {
    case "image":
      return "image";
    case "video":
      return "video";
    case "world":
      return "3D world";
  }
}

function getPhaseCopy(phase: RecorderPhase, outputTarget: OutputTarget, errorMessage: string | null) {
  const result = outputTargetResult(outputTarget);

  switch (phase) {
    case "idle":
      return {
        label: "Ready",
        title:
          outputTarget === "world"
            ? "Sketch to 3D world"
            : outputTarget === "video"
              ? "Sketch to video"
              : "Sketch to image",
        detail:
          outputTarget === "world"
            ? "Choose the destination, hit start, and stop when the sketch feels ready."
            : outputTarget === "video"
              ? "Choose the destination, hit start, and stop when the sketch feels ready."
            : "Choose the destination, hit start, and stop when the sketch feels ready."
      };
    case "recording":
      return {
        label: "Recording",
        title: "Sketch and speak freely",
        detail: "When it feels right, stop and let Synk make the final result."
      };
    case "uploading":
      return {
        label: "Preparing",
        title: `Getting your ${result} ready`,
        detail: "Give it a moment."
      };
    case "processing":
      return {
        label: "Creating",
        title: `Making your ${result}`,
        detail: "This can take a little longer on bigger ideas."
      };
    case "creating":
      return {
        label: "Finishing",
        title: outputTarget === "world" ? "Bringing your 3D world to life" : `Finishing your ${result}`,
        detail: outputTarget === "world" ? "This one can take a bit longer." : "Almost there."
      };
    case "error":
      return {
        label: "Error",
        title: "The session stopped early",
        detail: errorMessage || "Something went wrong while finishing the capture."
      };
  }
}

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

function outputTargetSummary(target: OutputTarget) {
  switch (target) {
    case "image":
      return "This take will render a final image.";
    case "world":
      return "This take will render an image, then build a 3D world.";
    case "video":
      return "This take will render an image, then build a video.";
  }
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

  const [phase, setPhase] = useState<RecorderPhase>("idle");
  const [analysisReasoningEffort, setAnalysisReasoningEffort] = useState<AnalysisReasoningEffort>("medium");
  const [imageSizePreset, setImageSizePreset] = useState<ImageSizePreset>("medium");
  const [imageGenerationProfile, setImageGenerationProfile] = useState<ImageGenerationProfile>("pro");
  const [videoModelPreset, setVideoModelPreset] = useState<VideoModelPreset>("quality");
  const [videoPipelineMode, setVideoPipelineMode] = useState<VideoPipelineMode>("normal");
  const [outputTarget, setOutputTarget] = useState<OutputTarget>("image");
  const [sessions, setSessions] = useState(initialSessions);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeDrawer, setActiveDrawer] = useState<"recent" | "settings" | null>(null);
  const tool: DrawingTool = "pen";
  const color = DEFAULT_PEN_COLOR;
  const brushWidth = 6;

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
    setActiveDrawer(null);

    try {
      const sessionResponse = await fetch("/api/sessions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          title: makeTitle(),
          analysisReasoningEffort,
          imageSizePreset,
          imageGenerationProfile
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

          setPhase("creating");

          const createResponse = await fetch(`/api/sessions/${activeSessionId}/create`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              target: outputTarget,
              reasoningEffort: analysisReasoningEffort,
              imageSizePreset,
              imageGenerationProfile,
              videoModelPreset,
              videoPipelineMode
            })
          });

          const createPayload = await createResponse.json().catch(() => ({}));
          if (!createResponse.ok) {
            throw new Error(
              createPayload.error ||
                (outputTarget === "world"
                  ? "Failed to create the 3D world from this session."
                  : outputTarget === "video"
                    ? "Failed to create the video from this session."
                  : "Failed to generate the image from this session.")
            );
          }

          await refreshRecentSessions();
          if (outputTarget === "world" && createPayload.job?.id) {
            router.push(`/sessions/${activeSessionId}/worlds/${createPayload.job.id}`);
            return;
          }

          if (outputTarget === "video" && createPayload.job?.id) {
            router.push(`/sessions/${activeSessionId}/videos/${createPayload.job.id}`);
            return;
          }

          router.push(`/sessions/${activeSessionId}/image`);
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
    setActiveDrawer(null);
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

  const isBusy = phase === "uploading" || phase === "processing" || phase === "creating";
  const phaseCopy = getPhaseCopy(phase, outputTarget, errorMessage);
  const isRecording = phase === "recording";
  const boardOverlayVisible = phase === "uploading" || phase === "processing" || phase === "creating" || phase === "error";

  return (
    <main className="recorder-experience-page">
      <div className="recorder-experience-stage">
        <div className="recorder-experience-grid" />
        <div className="recorder-experience-glow" />

        <header className="recorder-experience-header">
          <div className="recorder-brandline">
            <div className="recorder-brand-mark">Synk</div>
            <p className="recorder-brand-copy-inline">Sketch and speak into an image, video, or even a 3D world.</p>
          </div>

          <div className="recorder-header-actions">
            <button
              type="button"
              className="recorder-hud-button"
              onClick={() => setActiveDrawer(activeDrawer === "recent" ? null : "recent")}
            >
              Recent
            </button>
            <button
              type="button"
              className="recorder-hud-button"
              onClick={() => setActiveDrawer(activeDrawer === "settings" ? null : "settings")}
            >
              Settings
            </button>
          </div>
        </header>

        <section className="recorder-board-stage">
          <div className="canvas-frame recorder-board-frame">
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

            {boardOverlayVisible ? (
              <div className="recorder-board-overlay">
                <div className="recorder-board-overlay-card">
                  <p className="recorder-board-kicker">{phaseCopy.label}</p>
                  <h2>{phaseCopy.title}</h2>
                  <p>{phaseCopy.detail}</p>
                </div>
              </div>
            ) : null}
          </div>
        </section>

        {errorMessage ? <div className="recorder-floating-alert">{errorMessage}</div> : null}

        <div className="recorder-bottom-controls">
          <div className="recorder-bottom-dock">
            <div className="recorder-target-cluster">
              <span className="recorder-dock-label">Destination</span>
              <div className="segmented-control recorder-destination-control">
                <button
                  type="button"
                  className={outputTarget === "image" ? "active" : ""}
                  onClick={() => setOutputTarget("image")}
                  disabled={isRecording || isBusy}
                >
                  Image
                </button>
                <button
                  type="button"
                  className={outputTarget === "world" ? "active" : ""}
                  onClick={() => setOutputTarget("world")}
                  disabled={isRecording || isBusy}
                >
                  3D world
                </button>
                <button
                  type="button"
                  className={outputTarget === "video" ? "active" : ""}
                  onClick={() => setOutputTarget("video")}
                  disabled={isRecording || isBusy}
                >
                  Video
                </button>
              </div>
            </div>

            {phase === "idle" || phase === "error" ? (
              <button
                type="button"
                className="primary-button recorder-primary-button recorder-cta-button"
                onClick={startRecording}
              >
                Start sketching
              </button>
            ) : (
              <button
                type="button"
                className="primary-button stop-button recorder-primary-button recorder-cta-button"
                onClick={stopRecording}
                disabled={isBusy}
              >
                {outputTarget === "world"
                  ? "Finish and build 3D world"
                  : outputTarget === "video"
                    ? "Finish and build video"
                    : "Finish and generate image"}
              </button>
            )}
          </div>
        </div>

        {activeDrawer ? <button type="button" className="recorder-drawer-scrim" onClick={() => setActiveDrawer(null)} /> : null}

        <aside className={`recorder-drawer ${activeDrawer ? "open" : ""}`}>
          {activeDrawer === "recent" ? (
            <>
              <div className="recorder-drawer-header">
                <div>
                  <p className="recorder-drawer-kicker">Recent</p>
                  <h2>Saved sessions</h2>
                </div>
                <div className="recorder-drawer-actions">
                  <button type="button" className="recorder-hud-button" onClick={refreshRecentSessions}>
                    Refresh
                  </button>
                  <button type="button" className="recorder-hud-button" onClick={() => setActiveDrawer(null)}>
                    Close
                  </button>
                </div>
              </div>

              <div className="recorder-drawer-body">
                <div className="session-list">
                  {sessions.length === 0 ? (
                    <p className="empty-copy">No sessions yet. Record one to populate the replay list.</p>
                  ) : (
                    sessions.map((session) => (
                      <Link
                        key={session.id}
                        href={(session.preferredResultUrl ?? `/sessions/${session.id}`) as Route}
                        className="session-link"
                        onClick={() => setActiveDrawer(null)}
                      >
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
              </div>
            </>
          ) : null}

          {activeDrawer === "settings" ? (
            <>
              <div className="recorder-drawer-header">
                <div>
                  <p className="recorder-drawer-kicker">Settings</p>
                  <h2>Generation controls</h2>
                </div>
                <button type="button" className="recorder-hud-button" onClick={() => setActiveDrawer(null)}>
                  Close
                </button>
              </div>

              <div className="recorder-drawer-body recorder-settings-body">
                <section className="recorder-settings-section">
                  <span className="recorder-tool-label">Destination</span>
                  <div className="segmented-control">
                    <button
                      type="button"
                      className={outputTarget === "image" ? "active" : ""}
                      onClick={() => setOutputTarget("image")}
                      disabled={isRecording || isBusy}
                    >
                      Image
                    </button>
                    <button
                      type="button"
                      className={outputTarget === "world" ? "active" : ""}
                      onClick={() => setOutputTarget("world")}
                      disabled={isRecording || isBusy}
                    >
                      3D world
                    </button>
                    <button
                      type="button"
                      className={outputTarget === "video" ? "active" : ""}
                      onClick={() => setOutputTarget("video")}
                      disabled={isRecording || isBusy}
                    >
                      Video
                    </button>
                  </div>
                  <p className="recorder-settings-copy">{outputTargetSummary(outputTarget)}</p>
                </section>

                <section className="recorder-settings-section">
                  <span className="recorder-tool-label">Video pipeline</span>
                  <div className="segmented-control">
                    {VIDEO_PIPELINE_MODES.map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        className={videoPipelineMode === mode ? "active" : ""}
                        onClick={() => setVideoPipelineMode(mode)}
                        disabled={isRecording || isBusy}
                      >
                        {mode === "normal" ? "Normal" : "Dynamic"}
                      </button>
                    ))}
                  </div>
                  <p className="recorder-settings-copy">
                    {videoPipelineMode === "normal"
                      ? "Normal reuses the regular image pipeline, then writes a lightweight video prompt from the image scene prompt and transcript. This is the default path."
                      : "Dynamic uses the heavier motion-aware source-image planner and labeled video sketch path. Keep it for deeper experiments while the motion staging is still being tuned."}
                  </p>
                </section>

                <section className="recorder-settings-section">
                  <span className="recorder-tool-label">Video model</span>
                  <div className="segmented-control">
                    {VIDEO_MODEL_PRESETS.map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        className={videoModelPreset === preset ? "active" : ""}
                        onClick={() => setVideoModelPreset(preset)}
                        disabled={isRecording || isBusy}
                      >
                        {preset === "quality" ? "Quality" : "Lite"}
                      </button>
                    ))}
                  </div>
                  <p className="recorder-settings-copy">
                    {videoModelPreset === "quality"
                      ? "Quality uses Seedance 2 VIP Omni Reference Fast for the final pass. Keep this for the final effect check because it is materially more expensive."
                      : "Lite uses Seedance Lite I2V for low-cost validation while the rest of the pipeline is still being verified."}
                  </p>
                </section>

                <section className="recorder-settings-section">
                  <span className="recorder-tool-label">Profile</span>
                  <div className="segmented-control">
                    {IMAGE_GENERATION_PROFILES.map((profile) => (
                      <button
                        key={profile}
                        type="button"
                        className={imageGenerationProfile === profile ? "active" : ""}
                        onClick={() => setImageGenerationProfile(profile)}
                        disabled={isRecording || isBusy}
                      >
                        {profile === "pro" ? "Pro" : "Fast"}
                      </button>
                    ))}
                  </div>
                  <p className="recorder-settings-copy">
                    {imageGenerationProfile === "fast"
                      ? "Fast uses GPT-5.4 mini plus GPT Image 1 mini, with inferred style, low-fidelity editing, and a square 1024 pass to cut latency and cost."
                      : "Pro uses GPT-5.4 plus GPT Image 1.5, with the same inferred-style scene analysis and a higher-fidelity image pass for stronger final quality."}
                  </p>
                </section>

                <section className="recorder-settings-section">
                  <span className="recorder-tool-label">Reasoning effort</span>
                  <div className="segmented-control">
                    {REASONING_EFFORTS.map((effort) => (
                      <button
                        key={effort}
                        type="button"
                        className={analysisReasoningEffort === effort ? "active" : ""}
                        onClick={() => setAnalysisReasoningEffort(effort)}
                        disabled={isRecording || isBusy}
                      >
                        {effort}
                      </button>
                    ))}
                  </div>
                </section>

                <section className="recorder-settings-section">
                  <span className="recorder-tool-label">Image size</span>
                  <div className="segmented-control">
                    {IMAGE_SIZE_PRESETS.map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        className={imageSizePreset === preset ? "active" : ""}
                        onClick={() => setImageSizePreset(preset)}
                        disabled={isRecording || isBusy || imageGenerationProfile === "fast"}
                      >
                        {preset}
                      </button>
                    ))}
                  </div>
                  {imageGenerationProfile === "fast" ? (
                    <p className="recorder-settings-copy">
                      Fast uses a fixed 1024 square image pass to keep generation lean.
                    </p>
                  ) : null}
                </section>

                <section className="recorder-settings-section">
                  <span className="recorder-tool-label">Pipeline</span>
                  <p className="recorder-settings-copy">
                    Chrome demo path: MediaRecorder, local drawing timeline, server transcription, grounded image
                    generation, and optional World Labs world build.
                  </p>
                </section>
              </div>
            </>
          ) : null}
        </aside>
      </div>
    </main>
  );
}
