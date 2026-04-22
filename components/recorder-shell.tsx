"use client";

import type { Route } from "next";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { DEMO_CANVAS, applyDrawingEvent, createEmptyDrawingState, drawDrawingState } from "@/lib/drawing";
import {
  buildGalleryItemFromSession,
  buildPendingGalleryItem,
  buildPlaceholderGalleryItem,
  mergeVideoJobIntoSession,
  mergeWebsiteJobIntoSession,
  mergeWorldJobIntoSession,
  RecorderGalleryItem,
  RecorderGalleryTarget
} from "@/lib/recorder-gallery";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import {
  AnalysisReasoningEffort,
  DrawingEvent,
  DrawingState,
  DrawingTool,
  ImageGenerationProfile,
  ImageSizePreset,
  SessionDetail,
  SessionSummary,
  VideoJob,
  VideoModelPreset,
  VideoPipelineMode,
  WebsiteJob,
  WorldJob
} from "@/lib/types";
import { concatPcmChunks, encodeMonoPcmWav } from "@/lib/wav";
import type { Viewer } from "@/lib/auth";

const DEFAULT_PEN_COLOR = "#20222b";
const PCM_BUFFER_SIZE = 1024;
const SKETCH_FLIGHT_REPLACE_DELAY_MS = 560;
const REASONING_EFFORTS: AnalysisReasoningEffort[] = ["low", "medium", "high"];
const IMAGE_SIZE_PRESETS: ImageSizePreset[] = ["small", "medium", "large"];
const IMAGE_GENERATION_PROFILES: ImageGenerationProfile[] = ["pro", "fast"];
const VIDEO_MODEL_PRESETS: VideoModelPreset[] = ["quality", "lite"];
const VIDEO_PIPELINE_MODES: VideoPipelineMode[] = ["normal", "dynamic"];
const GALLERY_CACHE_VERSION = "v1";

type OutputTarget = RecorderGalleryTarget;
type RecorderPhase = "idle" | "arming" | "listening" | "paused" | "handoff" | "error";

interface CompletedCapture {
  tempId: string;
  title: string;
  createdAt: string;
  events: DrawingEvent[];
  sketchBlob: Blob | null;
  sketchDataUrl: string | null;
  audioBlob: Blob;
  audioMimeType: string;
  durationMs: number;
}

interface ActiveTake {
  id: string;
  title: string;
  createdAt: string;
  startedAt: number;
  audioPcmChunks: Float32Array[];
  pausedAt: number | null;
}

interface VoiceMonitor {
  stream: MediaStream;
  audioContext: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  silenceGain: GainNode;
  sampleRate: number;
}

interface GalleryContextMenuState {
  sessionId: string;
  x: number;
  y: number;
}

interface FinalizeOptionsSnapshot {
  target: OutputTarget;
  reasoningEffort: AnalysisReasoningEffort;
  imageSizePreset: ImageSizePreset;
  imageGenerationProfile: ImageGenerationProfile;
  videoModelPreset: VideoModelPreset;
  videoPipelineMode: VideoPipelineMode;
}

interface FlightRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface SketchFlight {
  itemId: string;
  imageUrl: string;
  from: FlightRect;
  to: FlightRect | null;
  phase: "measuring" | "ready" | "animating";
}

type BrowserWindowWithWebkitAudioContext = Window &
  typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };

function makeTitle() {
  return `Live Demo ${new Date().toLocaleString()}`;
}

function outputTargetSummary(target: OutputTarget, websiteEnabled: boolean) {
  switch (target) {
    case "image":
      return "This take will render a final image.";
    case "world":
      return "This take will render an image, then build a 3D world.";
    case "video":
      return "This take will render an image, then build a video.";
    case "website":
      return websiteEnabled
        ? "This take will build a website directly from the labeled sketch and transcript."
        : "Website generation is disabled until Vercel Sandbox credentials are configured.";
  }
}

function sortGalleryItems(items: RecorderGalleryItem[]) {
  return [...items].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
}

function getGalleryCacheKey(viewerId: string | null) {
  return `synk:gallery:${GALLERY_CACHE_VERSION}:${viewerId ?? "guest"}`;
}

function cloneDrawingEvents(events: DrawingEvent[]) {
  return events.map((event) => ({ ...event })) as DrawingEvent[];
}

function clonePcmChunks(chunks: Float32Array[]) {
  return chunks.map((chunk) => new Float32Array(chunk));
}

function canReuseStream(stream: MediaStream | null | undefined) {
  return Boolean(stream?.getAudioTracks().some((track) => track.readyState === "live"));
}

function readRouteError(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string") {
    return payload.error;
  }

  return fallback;
}

function getGalleryCardClass(item: RecorderGalleryItem) {
  return `recorder-gallery-card recorder-gallery-card-${item.status}`;
}

function getFlightTargetRect(element: HTMLElement) {
  const thumbnail = element.querySelector<HTMLElement>(".recorder-gallery-card-thumb");
  const rect = (thumbnail ?? element).getBoundingClientRect();
  return {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height
  };
}

export function RecorderShell({
  initialSessions,
  viewer,
  authEnabled,
  signInHref,
  setupMessage,
  websiteEnabled
}: {
  initialSessions: SessionSummary[];
  viewer: Viewer | null;
  authEnabled: boolean;
  signInHref: string;
  setupMessage?: string | null;
  websiteEnabled: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasFrameRef = useRef<HTMLDivElement | null>(null);
  const drawingStateRef = useRef<DrawingState>(createEmptyDrawingState());
  const eventsRef = useRef<DrawingEvent[]>([]);
  const activeStrokeIdRef = useRef<string | null>(null);
  const takeRef = useRef<ActiveTake | null>(null);
  const voiceMonitorRef = useRef<VoiceMonitor | null>(null);
  const armingVoiceRef = useRef(false);
  const galleryItemsRef = useRef<RecorderGalleryItem[]>([]);
  const galleryCardRefs = useRef(new Map<string, HTMLElement>());
  const sessionDetailsRef = useRef(new Map<string, SessionDetail>());
  const pollingSessionsRef = useRef(new Set<string>());
  const submissionQueueRef = useRef(Promise.resolve());
  const lifecycleTransitionQueueRef = useRef(Promise.resolve());
  const windowFocusedRef = useRef(true);
  const createSessionConfigRef = useRef({
    analysisReasoningEffort: "medium" as AnalysisReasoningEffort,
    imageSizePreset: "medium" as ImageSizePreset,
    imageGenerationProfile: "pro" as ImageGenerationProfile
  });
  const canListenRef = useRef(!(authEnabled && !viewer));
  const galleryNoticeTimeoutRef = useRef<number | null>(null);

  const [phase, setPhase] = useState<RecorderPhase>("idle");
  const [analysisReasoningEffort, setAnalysisReasoningEffort] = useState<AnalysisReasoningEffort>("medium");
  const [imageSizePreset, setImageSizePreset] = useState<ImageSizePreset>("medium");
  const [imageGenerationProfile, setImageGenerationProfile] = useState<ImageGenerationProfile>("pro");
  const [videoModelPreset, setVideoModelPreset] = useState<VideoModelPreset>("quality");
  const [videoPipelineMode, setVideoPipelineMode] = useState<VideoPipelineMode>("normal");
  const [outputTarget, setOutputTarget] = useState<OutputTarget>("image");
  const [galleryItems, setGalleryItems] = useState<RecorderGalleryItem[]>(() =>
    sortGalleryItems(initialSessions.map((session) => buildPlaceholderGalleryItem(session)))
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [galleryNotice, setGalleryNotice] = useState<string | null>(null);
  const [activeViewer, setActiveViewer] = useState<Viewer | null>(viewer);
  const [galleryContextMenu, setGalleryContextMenu] = useState<GalleryContextMenuState | null>(null);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [authPromptVisible, setAuthPromptVisible] = useState(false);
  const [activeDrawer, setActiveDrawer] = useState<"settings" | null>(null);
  const [flight, setFlight] = useState<SketchFlight | null>(null);
  const [hasSketchContent, setHasSketchContent] = useState(false);
  const tool: DrawingTool = "pen";
  const color = DEFAULT_PEN_COLOR;
  const brushWidth = 6;

  useEffect(() => {
    galleryItemsRef.current = galleryItems;
  }, [galleryItems]);

  useEffect(() => {
    createSessionConfigRef.current = {
      analysisReasoningEffort,
      imageSizePreset,
      imageGenerationProfile
    };
  }, [analysisReasoningEffort, imageGenerationProfile, imageSizePreset]);

  useEffect(() => {
    setActiveViewer(viewer);
  }, [viewer]);

  useEffect(() => {
    if (!authEnabled) {
      return;
    }

    const supabase = getSupabaseBrowserClient();
    let cancelled = false;

    const syncViewer = async () => {
      const {
        data: { user }
      } = await supabase.auth.getUser();

      if (cancelled) {
        return;
      }

      setActiveViewer(
        user
          ? {
              id: user.id,
              email: user.email ?? null
            }
          : null
      );
    };

    void syncViewer();

    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (cancelled) {
        return;
      }

      const user = session?.user ?? null;
      setActiveViewer(
        user
          ? {
              id: user.id,
              email: user.email ?? null
            }
          : null
      );
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [authEnabled]);

  useEffect(() => {
    canListenRef.current = !(authEnabled && !activeViewer);
  }, [activeViewer, authEnabled]);

  useEffect(() => {
    if (activeViewer) {
      setAuthPromptVisible(false);
      setAuthNotice(null);
    }
  }, [activeViewer]);

  useEffect(() => {
    return () => {
      if (galleryNoticeTimeoutRef.current !== null) {
        window.clearTimeout(galleryNoticeTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!galleryContextMenu) {
      return;
    }

    const handlePointerDown = () => setGalleryContextMenu(null);
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setGalleryContextMenu(null);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [galleryContextMenu]);

  useEffect(() => {
    if (!websiteEnabled && outputTarget === "website") {
      setOutputTarget("image");
    }
  }, [outputTarget, websiteEnabled]);

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

  function resetBoard() {
    drawingStateRef.current = createEmptyDrawingState();
    eventsRef.current = [];
    activeStrokeIdRef.current = null;
    setHasSketchContent(false);
    redrawCanvas();
  }

  function createActiveTake(startedAt = performance.now()): ActiveTake {
    return {
      id: crypto.randomUUID(),
      title: makeTitle(),
      createdAt: new Date().toISOString(),
      startedAt,
      audioPcmChunks: [],
      pausedAt: null
    };
  }

  function resetActiveTake(startedAt = performance.now()) {
    takeRef.current = createActiveTake(startedAt);
  }

  function pauseActiveTake(now = performance.now()) {
    const activeTake = takeRef.current;
    if (!activeTake || activeTake.pausedAt !== null) {
      return;
    }

    activeTake.pausedAt = now;
  }

  function resumeActiveTake(now = performance.now()) {
    const activeTake = takeRef.current;
    if (!activeTake || activeTake.pausedAt === null) {
      return;
    }

    activeTake.startedAt += now - activeTake.pausedAt;
    activeTake.pausedAt = null;
  }

  function enqueueLifecycleTransition(task: () => Promise<void>) {
    const queued = lifecycleTransitionQueueRef.current.catch(() => undefined).then(task);
    lifecycleTransitionQueueRef.current = queued.catch(() => undefined);
    return queued;
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

  function getEventTime() {
    const take = takeRef.current;
    if (!take) {
      return 0;
    }

    return Math.max(0, Math.round(performance.now() - take.startedAt));
  }

  function pushEvent(event: DrawingEvent) {
    eventsRef.current.push(event);
    applyDrawingEvent(drawingStateRef.current, event);
    setHasSketchContent(drawingStateRef.current.strokes.length > 0);
    redrawCanvas();
  }

  function getFinalizeOptionsSnapshot(): FinalizeOptionsSnapshot {
    return {
      target: outputTarget,
      reasoningEffort: analysisReasoningEffort,
      imageSizePreset,
      imageGenerationProfile,
      videoModelPreset,
      videoPipelineMode
    };
  }

  function setGalleryCardRef(sessionId: string, node: HTMLElement | null) {
    if (node) {
      galleryCardRefs.current.set(sessionId, node);
      return;
    }

    galleryCardRefs.current.delete(sessionId);
  }

  function upsertGalleryItem(nextItem: RecorderGalleryItem) {
    setGalleryItems((current) => sortGalleryItems([nextItem, ...current.filter((item) => item.sessionId !== nextItem.sessionId)]));
  }

  function replaceGalleryItem(currentSessionId: string, nextItem: RecorderGalleryItem) {
    setGalleryItems((current) =>
      sortGalleryItems(
        [nextItem, ...current.filter((item) => item.sessionId !== currentSessionId && item.sessionId !== nextItem.sessionId)]
      )
    );
  }

  function removeGalleryItem(sessionId: string) {
    setGalleryItems((current) => current.filter((item) => item.sessionId !== sessionId));
    sessionDetailsRef.current.delete(sessionId);
    galleryCardRefs.current.delete(sessionId);
    pollingSessionsRef.current.delete(sessionId);
  }

  function patchGalleryItem(sessionId: string, updater: (item: RecorderGalleryItem) => RecorderGalleryItem) {
    setGalleryItems((current) =>
      sortGalleryItems(
        current.map((item) => {
          if (item.sessionId !== sessionId) {
            return item;
          }

          return updater(item);
        })
      )
    );
  }

  function showGalleryNotice(message: string) {
    if (galleryNoticeTimeoutRef.current !== null) {
      window.clearTimeout(galleryNoticeTimeoutRef.current);
    }

    setGalleryNotice(message);
    galleryNoticeTimeoutRef.current = window.setTimeout(() => {
      setGalleryNotice(null);
      galleryNoticeTimeoutRef.current = null;
    }, 2800);
  }

  function openGalleryContextMenu(event: React.MouseEvent, sessionId: string) {
    event.preventDefault();

    if (authEnabled && !activeViewer) {
      setErrorMessage(null);
      setAuthNotice("Sign in to manage and delete saved sessions.");
      setAuthPromptVisible(true);
      return;
    }

    setGalleryContextMenu({
      sessionId,
      x: event.clientX,
      y: event.clientY
    });
  }

  async function deleteGallerySession(sessionId: string) {
    setGalleryContextMenu(null);
    setDeletingSessionId(sessionId);
    setErrorMessage(null);

    try {
      const response = await fetch(`/api/sessions/${sessionId}`, {
        method: "DELETE"
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(readRouteError(payload, "Failed to delete the session."));
      }

      removeGalleryItem(sessionId);
      showGalleryNotice("Deleted from the gallery.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to delete the session.");
    } finally {
      setDeletingSessionId(null);
    }
  }

  function preserveQueuedSketchPreview(currentItem: RecorderGalleryItem, nextItem: RecorderGalleryItem) {
    const shouldKeepLocalSketch =
      currentItem.status === "pending" &&
      currentItem.previewKind === "sketch" &&
      Boolean(currentItem.sketchThumbnailUrl) &&
      !nextItem.sketchThumbnailUrl &&
      !nextItem.sourceImageUrl;

    if (!shouldKeepLocalSketch) {
      return nextItem;
    }

    return {
      ...nextItem,
      thumbnailUrl: currentItem.sketchThumbnailUrl,
      sketchThumbnailUrl: currentItem.sketchThumbnailUrl,
      previewKind: "sketch" as const
    };
  }

  function mergeGalleryItems(items: RecorderGalleryItem[]) {
    setGalleryItems((current) => {
      const bySessionId = new Map(current.map((item) => [item.sessionId, item]));
      for (const item of items) {
        bySessionId.set(item.sessionId, item);
      }

      return sortGalleryItems(Array.from(bySessionId.values()));
    });
  }

  function launchSketchFlight(itemId: string, imageUrl: string | null) {
    const frame = canvasFrameRef.current;
    if (!frame || !imageUrl) {
      return;
    }

    const rect = frame.getBoundingClientRect();
    setFlight({
      itemId,
      imageUrl,
      from: {
        top: rect.top + rect.height * 0.12,
        left: rect.left + rect.width * 0.12,
        width: rect.width * 0.76,
        height: rect.height * 0.76
      },
      to: null,
      phase: "measuring"
    });
  }

  useEffect(() => {
    if (!flight || flight.phase !== "measuring") {
      return;
    }

    const target = galleryCardRefs.current.get(flight.itemId);
    if (!target) {
      return;
    }

    setFlight((current) =>
      current && current.phase === "measuring"
        ? {
            ...current,
            to: getFlightTargetRect(target),
            phase: "ready"
          }
        : current
    );
  }, [flight, galleryItems]);

  useEffect(() => {
    if (!flight || flight.phase !== "ready" || !flight.to) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      setFlight((current) =>
        current && current.phase === "ready"
          ? {
              ...current,
              phase: "animating"
            }
          : current
      );
    });
    const timer = window.setTimeout(() => {
      setFlight(null);
    }, 520);

    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [flight]);

  async function getCanvasSnapshotBlob() {
    const canvas = canvasRef.current;
    if (!canvas) {
      return null;
    }

    return new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), "image/png");
    });
  }

  function getCanvasSnapshotDataUrl() {
    return canvasRef.current?.toDataURL("image/png") ?? null;
  }

  async function fetchSessionDetail(sessionId: string) {
    const response = await fetch(`/api/sessions/${sessionId}`, { cache: "no-store" });
    if (response.status === 404) {
      return null;
    }

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(readRouteError(payload, "Failed to load the session."));
    }

    return payload as SessionDetail;
  }

  async function createSessionOnServer(title: string) {
    const config = createSessionConfigRef.current;
    const response = await fetch("/api/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        title,
        analysisReasoningEffort: config.analysisReasoningEffort,
        imageSizePreset: config.imageSizePreset,
        imageGenerationProfile: config.imageGenerationProfile
      })
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(readRouteError(payload, "Failed to create a session."));
    }

    return payload as SessionSummary;
  }

  async function getOrCreateAudioStream(existingStream?: MediaStream | null) {
    if (canReuseStream(existingStream)) {
      return existingStream!;
    }

    return navigator.mediaDevices.getUserMedia({
      audio: true
    });
  }

  async function stopVoiceMonitoring(options?: { stopTracks?: boolean; keepalive?: boolean }) {
    const monitor = voiceMonitorRef.current;
    armingVoiceRef.current = false;
    if (!monitor) {
      return;
    }

    voiceMonitorRef.current = null;

    monitor.source.disconnect();
    monitor.processor.disconnect();
    monitor.silenceGain.disconnect();

    if (options?.stopTracks ?? true) {
      monitor.stream.getTracks().forEach((track) => track.stop());
    }

    await monitor.audioContext.close().catch((error) => {
      console.error("Failed to close the audio context.", error);
    });
  }

  async function ensureVoiceMonitoring() {
    if (!canListenRef.current || armingVoiceRef.current) {
      return;
    }

    if (document.hidden || !windowFocusedRef.current) {
      if (takeRef.current) {
        setPhase("paused");
      }
      return;
    }

    const existingMonitor = voiceMonitorRef.current;
    if (existingMonitor && canReuseStream(existingMonitor.stream)) {
      if (existingMonitor.audioContext.state === "suspended") {
        await existingMonitor.audioContext.resume().catch(() => null);
      }

      if (!takeRef.current) {
        resetActiveTake();
      }
      resumeActiveTake();

      setPhase("listening");
      return;
    }

    setErrorMessage(null);
    setPhase("arming");
    armingVoiceRef.current = true;

    const AudioContextCtor =
      window.AudioContext || (window as BrowserWindowWithWebkitAudioContext).webkitAudioContext;
    if (!AudioContextCtor) {
      armingVoiceRef.current = false;
      setPhase("error");
      setErrorMessage("This browser does not support microphone monitoring.");
      return;
    }

    try {
      const stream = await getOrCreateAudioStream(existingMonitor?.stream);
      const audioContext = new AudioContextCtor();
      await audioContext.resume().catch(() => null);
      const processor = audioContext.createScriptProcessor(PCM_BUFFER_SIZE, 1, 1);
      const silenceGain = audioContext.createGain();
      silenceGain.gain.value = 0;

      const source = audioContext.createMediaStreamSource(stream);
      source.connect(processor);
      processor.connect(silenceGain);
      silenceGain.connect(audioContext.destination);

      const monitor: VoiceMonitor = {
        stream,
        audioContext,
        source,
        processor,
        silenceGain,
        sampleRate: audioContext.sampleRate
      };

      if (!takeRef.current) {
        resetActiveTake();
      } else {
        resumeActiveTake();
      }

      processor.addEventListener("audioprocess", (event) => {
        if (voiceMonitorRef.current !== monitor) {
          return;
        }

        const audioEvent = event as AudioProcessingEvent;
        const input = new Float32Array(audioEvent.inputBuffer.getChannelData(0));
        const activeTake = takeRef.current;
        if (activeTake) {
          activeTake.audioPcmChunks.push(input);
        }
      });

      voiceMonitorRef.current = monitor;
      setPhase("listening");
    } catch (error) {
      setPhase("error");
      setErrorMessage(error instanceof Error ? error.message : "Unable to access the microphone.");
    } finally {
      armingVoiceRef.current = false;
    }
  }

  function mergeInitialGalleryPlaceholders(summaries: SessionSummary[]) {
    setGalleryItems((current) => {
      const bySessionId = new Map(current.map((item) => [item.sessionId, item]));
      for (const summary of summaries) {
        if (!bySessionId.has(summary.id)) {
          bySessionId.set(summary.id, buildPlaceholderGalleryItem(summary));
        }
      }

      return sortGalleryItems(Array.from(bySessionId.values()));
    });
  }

  async function markGalleryItemFailed(sessionId: string, target: OutputTarget, message: string) {
    try {
      const refreshedSession = await fetchSessionDetail(sessionId);
      if (refreshedSession) {
        sessionDetailsRef.current.set(sessionId, refreshedSession);
        const nextItem = buildGalleryItemFromSession(refreshedSession, target);
        upsertGalleryItem({
          ...nextItem,
          status: "failed",
          statusLabel: "Failed",
          detail: message
        });
        return;
      }
    } catch (error) {
      console.error("Failed to refresh the failed gallery item.", error);
    }

    patchGalleryItem(sessionId, (item) => ({
      ...item,
      status: "failed",
      statusLabel: "Failed",
      detail: message
    }));
  }

  function markTemporaryGalleryItemFailed(sessionId: string, message: string) {
    patchGalleryItem(sessionId, (item) => ({
      ...item,
      status: "failed",
      statusLabel: "Failed",
      detail: message
    }));
  }

  async function submitFinalizedCapture(capture: CompletedCapture, options: FinalizeOptionsSnapshot) {
    let session: SessionSummary | null = null;
    let gallerySessionId = capture.tempId;

    try {
      patchGalleryItem(capture.tempId, (item) => ({
        ...item,
        status: "pending",
        statusLabel: "Uploading",
        detail: "Sending the sketch, audio, transcript, and timeline into the pipeline."
      }));

      session = await createSessionOnServer(capture.title);
      gallerySessionId = session.id;

      const serverPendingItem = buildPendingGalleryItem({
        sessionId: session.id,
        title: session.title,
        createdAt: session.createdAt,
        target: options.target,
        sketchThumbnailUrl: capture.sketchDataUrl
      });

      await new Promise((resolve) => window.setTimeout(resolve, SKETCH_FLIGHT_REPLACE_DELAY_MS));
      replaceGalleryItem(capture.tempId, {
        ...serverPendingItem,
        status: "pending",
        statusLabel: "Uploading",
        detail: "Sending the sketch, audio, transcript, and timeline into the pipeline."
      });

      const uploadForm = new FormData();
      uploadForm.append(
        "audio",
        new File([capture.audioBlob], "audio.wav", {
          type: capture.audioMimeType
        })
      );
      if (capture.sketchBlob) {
        uploadForm.append(
          "sketch",
          new File([capture.sketchBlob], "sketch.png", {
            type: "image/png"
          })
        );
      }
      uploadForm.append("events", JSON.stringify(capture.events));
      uploadForm.append("durationMs", String(capture.durationMs));
      uploadForm.append("canvasWidth", String(DEMO_CANVAS.width));
      uploadForm.append("canvasHeight", String(DEMO_CANVAS.height));

      const uploadResponse = await fetch(`/api/sessions/${session.id}/upload`, {
        method: "POST",
        body: uploadForm
      });
      const uploadPayload = await uploadResponse.json().catch(() => null);
      if (!uploadResponse.ok) {
        throw new Error(readRouteError(uploadPayload, "Failed to upload the session."));
      }

      patchGalleryItem(gallerySessionId, (item) => ({
        ...item,
        status: "running",
        statusLabel: "Transcribing",
        detail: "Transcribing the take with gpt-4o-mini-transcribe."
      }));

      const processResponse = await fetch(`/api/sessions/${session.id}/process`, {
        method: "POST"
      });
      const processPayload = await processResponse.json().catch(() => null);
      if (!processResponse.ok) {
        throw new Error(readRouteError(processPayload, "Failed to transcribe the session."));
      }

      patchGalleryItem(gallerySessionId, (item) => ({
        ...item,
        status: "running",
        statusLabel: "Rendering",
        detail:
          options.target === "image"
            ? "Rendering the final image."
            : options.target === "world"
              ? "Rendering the source image for the 3D world."
              : options.target === "video"
                ? "Rendering the source image for the video."
                : "Preparing the labeled sketch for website generation."
      }));

      const createResponse = await fetch(`/api/sessions/${session.id}/create`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          target: options.target,
          reasoningEffort: options.reasoningEffort,
          imageSizePreset: options.imageSizePreset,
          imageGenerationProfile: options.imageGenerationProfile,
          videoModelPreset: options.videoModelPreset,
          videoPipelineMode: options.videoPipelineMode
        })
      });
      const createPayload = await createResponse.json().catch(() => null);
      if (!createResponse.ok) {
        throw new Error(
          readRouteError(
            createPayload,
            options.target === "world"
              ? "Failed to create the 3D world from this session."
              : options.target === "video"
                ? "Failed to create the video from this session."
                : options.target === "website"
                  ? "Failed to create the website from this session."
                  : "Failed to generate the image from this session."
          )
        );
      }

      let nextSession = createPayload?.session as SessionDetail;
      if (!nextSession) {
        throw new Error("Create route returned no session payload.");
      }

      if (options.target === "video" && createPayload?.job) {
        nextSession = mergeVideoJobIntoSession(nextSession, createPayload.job as VideoJob);
      }

      if (options.target === "world" && createPayload?.job) {
        nextSession = mergeWorldJobIntoSession(nextSession, createPayload.job as WorldJob);
      }

      if (options.target === "website" && createPayload?.job) {
        nextSession = mergeWebsiteJobIntoSession(nextSession, createPayload.job as WebsiteJob);
      }

      sessionDetailsRef.current.set(gallerySessionId, nextSession);
      upsertGalleryItem(buildGalleryItemFromSession(nextSession, options.target));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to finish the session.";
      if (session) {
        await markGalleryItemFailed(session.id, options.target, message);
        return;
      }

      markTemporaryGalleryItemFailed(capture.tempId, message);
    }
  }

  function enqueueFinalizedCapture(capture: CompletedCapture, options: FinalizeOptionsSnapshot) {
    const queuedSubmission = submissionQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        await submitFinalizedCapture(capture, options);
      });

    submissionQueueRef.current = queuedSubmission.catch(() => undefined);
    return queuedSubmission;
  }

  async function stopVoiceForInvisibility(
    _message: string,
    options?: {
      keepalive?: boolean;
      suppressUi?: boolean;
    }
  ) {
    pauseActiveTake();
    activeStrokeIdRef.current = null;
    await stopVoiceMonitoring({
      stopTracks: true,
      keepalive: options?.keepalive
    });

    if (!options?.suppressUi) {
      setPhase(takeRef.current ? "paused" : "idle");
      setErrorMessage(null);
    } else {
      setPhase(takeRef.current ? "paused" : "idle");
    }
  }

  async function handleGo() {
    const monitor = voiceMonitorRef.current;
    const activeTake = takeRef.current;
    if (phase !== "listening" || !hasSketchContent || !monitor || !activeTake) {
      return;
    }

    setActiveDrawer(null);
    setErrorMessage(null);
    setPhase("handoff");

    try {
      const options = getFinalizeOptionsSnapshot();
      const sketchBlob = await getCanvasSnapshotBlob();
      const sketchDataUrl = getCanvasSnapshotDataUrl();
      const takeSnapshot = {
        ...activeTake,
        audioPcmChunks: clonePcmChunks(activeTake.audioPcmChunks),
        events: cloneDrawingEvents(eventsRef.current),
        sketchBlob,
        sketchDataUrl
      };

      resetBoard();
      resetActiveTake();
      setPhase("listening");

      const previewId = crypto.randomUUID();
      const pendingItem = buildPendingGalleryItem({
        sessionId: previewId,
        title: takeSnapshot.title,
        createdAt: takeSnapshot.createdAt,
        target: options.target,
        sketchThumbnailUrl: takeSnapshot.sketchDataUrl
      });

      upsertGalleryItem(pendingItem);
      launchSketchFlight(previewId, takeSnapshot.sketchDataUrl);

      void (async () => {
        try {
          const audioSamples = concatPcmChunks(takeSnapshot.audioPcmChunks);
          const audioMimeType = "audio/wav";

          const completedCapture: CompletedCapture = {
            tempId: previewId,
            title: takeSnapshot.title,
            createdAt: takeSnapshot.createdAt,
            events: takeSnapshot.events,
            sketchBlob: takeSnapshot.sketchBlob,
            sketchDataUrl: takeSnapshot.sketchDataUrl,
            audioBlob: new Blob([encodeMonoPcmWav(audioSamples, monitor.sampleRate)], { type: audioMimeType }),
            audioMimeType,
            durationMs: Math.round((audioSamples.length / monitor.sampleRate) * 1000)
          };

          await enqueueFinalizedCapture(completedCapture, options);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Failed to move the current canvas into the gallery.";
          markTemporaryGalleryItemFailed(previewId, message);
          setErrorMessage(message);
        }
      })();
    } catch (error) {
      setPhase("error");
      setErrorMessage(error instanceof Error ? error.message : "Failed to move the current canvas into the gallery.");
    }
  }

  async function refreshGalleryItem(item: RecorderGalleryItem) {
    if (pollingSessionsRef.current.has(item.sessionId)) {
      return;
    }

    pollingSessionsRef.current.add(item.sessionId);

    try {
      const session = await fetchSessionDetail(item.sessionId);
      if (!session) {
        return;
      }

      let nextSession = session;
      if (item.target === "video" && item.jobId) {
        const response = await fetch(`/api/sessions/${item.sessionId}/videos/${item.jobId}`, {
          cache: "no-store"
        });
        const payload = await response.json().catch(() => null);
        const job = (response.ok ? payload : payload?.job) as VideoJob | null;
        if (job) {
          nextSession = mergeVideoJobIntoSession(nextSession, job);
        }
      }

      if (item.target === "world" && item.jobId) {
        const response = await fetch(`/api/sessions/${item.sessionId}/worlds/${item.jobId}`, {
          cache: "no-store"
        });
        const payload = await response.json().catch(() => null);
        const job = (response.ok ? payload : payload?.job) as WorldJob | null;
        if (job) {
          nextSession = mergeWorldJobIntoSession(nextSession, job);
        }
      }

      if (item.target === "website" && item.jobId) {
        const response = await fetch(`/api/sessions/${item.sessionId}/websites/${item.jobId}`, {
          cache: "no-store"
        });
        const payload = await response.json().catch(() => null);
        const job = (response.ok ? payload : payload?.job) as WebsiteJob | null;
        if (job) {
          nextSession = mergeWebsiteJobIntoSession(nextSession, job);
        }
      }

      sessionDetailsRef.current.set(item.sessionId, nextSession);
      const nextItem = buildGalleryItemFromSession(nextSession, item.target);
      upsertGalleryItem(preserveQueuedSketchPreview(item, nextItem));
    } catch (error) {
      console.error("Failed to refresh a gallery item.", error);
    } finally {
      pollingSessionsRef.current.delete(item.sessionId);
    }
  }

  useEffect(() => {
    mergeInitialGalleryPlaceholders(initialSessions);
  }, [initialSessions]);

  useLayoutEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      const cached = window.sessionStorage.getItem(getGalleryCacheKey(activeViewer?.id ?? null));
      if (!cached) {
        return;
      }

      const items = JSON.parse(cached) as RecorderGalleryItem[];
      if (!Array.isArray(items) || items.length === 0) {
        return;
      }

      mergeGalleryItems(items);
    } catch (error) {
      console.warn("Failed to restore gallery cache.", error);
    }
  }, [activeViewer?.id]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      window.sessionStorage.setItem(
        getGalleryCacheKey(activeViewer?.id ?? null),
        JSON.stringify(galleryItems.slice(0, 8))
      );
    } catch (error) {
      console.warn("Failed to persist gallery cache.", error);
    }
  }, [activeViewer?.id, galleryItems]);

  useEffect(() => {
    const controller = new AbortController();

    const loadGallerySessions = async () => {
      try {
        const response = await fetch("/api/sessions/recent", {
          cache: "no-store",
          signal: controller.signal
        });

        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          throw new Error(readRouteError(payload, "Failed to load recent sessions."));
        }

        const items = (await response.json()) as RecorderGalleryItem[];
        if (!Array.isArray(items)) {
          throw new Error("Recent sessions response was malformed.");
        }

        mergeGalleryItems(items);
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }

        console.error("Failed to load gallery sessions.", error);
      }
    };

    void loadGallerySessions();

    return () => controller.abort();
  }, [activeViewer?.id]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled || document.hidden) {
        return;
      }

      const pendingItems = galleryItemsRef.current.filter(
        (item) => item.status === "pending" || item.status === "running"
      );
      await Promise.allSettled(pendingItems.map((item) => refreshGalleryItem(item)));
    };

    const interval = window.setInterval(() => {
      void tick();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (authEnabled && !activeViewer) {
      takeRef.current = null;
      void stopVoiceMonitoring();
      setPhase("idle");
      return;
    }

    void ensureVoiceMonitoring();
  }, [activeViewer, authEnabled]);

  useEffect(() => {
    windowFocusedRef.current = document.hasFocus();

    const pauseForLifecycle = (reason: string, options?: { keepalive?: boolean; suppressUi?: boolean }) => {
      void enqueueLifecycleTransition(async () => {
        await stopVoiceForInvisibility(reason, options);
      });
    };

    const resumeAfterLifecycle = () => {
      if (document.hidden || !windowFocusedRef.current) {
        return;
      }

      void enqueueLifecycleTransition(async () => {
        await ensureVoiceMonitoring();
      });
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        pauseForLifecycle("Voice paused because this canvas was no longer visible.", {
          suppressUi: true
        });
      } else {
        resumeAfterLifecycle();
      }
    };

    const handleWindowBlur = () => {
      windowFocusedRef.current = false;
      pauseForLifecycle("Voice paused because this canvas lost focus.", {
        suppressUi: true
      });
    };

    const handleWindowFocus = () => {
      windowFocusedRef.current = true;
      resumeAfterLifecycle();
    };

    const handlePageHide = () => {
      pauseForLifecycle("Voice paused because this canvas was no longer visible.", {
        keepalive: true,
        suppressUi: true
      });
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("blur", handleWindowBlur);
    window.addEventListener("focus", handleWindowFocus);
    window.addEventListener("pagehide", handlePageHide);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("blur", handleWindowBlur);
      window.removeEventListener("focus", handleWindowFocus);
      window.removeEventListener("pagehide", handlePageHide);

      void enqueueLifecycleTransition(async () => {
        await stopVoiceMonitoring({
          stopTracks: true,
          keepalive: true
        });
      });
    };
  }, []);

  function handlePointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (authEnabled && !activeViewer) {
      setErrorMessage(null);
      setAuthNotice("Sign in to start sketching, recording, and saving sessions.");
      setAuthPromptVisible(true);
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
    if (!activeStrokeIdRef.current) {
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
    if (!activeStrokeIdRef.current) {
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

  const controlTransitioning = phase === "arming" || phase === "handoff";

  return (
    <main className="recorder-experience-page">
      <div className="recorder-experience-stage">
        <div className="recorder-experience-grid" />
        <div className="recorder-experience-glow" />

        <header className="recorder-experience-header">
          <div className="recorder-brandline">
            <div className="recorder-brand-mark">Synk</div>
            <p className="recorder-brand-copy-inline">
              Sketch and speak anything into existence
            </p>
          </div>

          <div className="recorder-header-actions">
            <Link href={(activeViewer ? "/dashboard" : signInHref) as Route} className="recorder-hud-button">
              {activeViewer ? "Dashboard" : "Sign in"}
            </Link>
            <button
              type="button"
              className="recorder-hud-button"
              onClick={() => setActiveDrawer(activeDrawer === "settings" ? null : "settings")}
            >
              Settings
            </button>
          </div>
        </header>

        {authNotice || errorMessage || galleryNotice || setupMessage ? (
          <div className="recorder-floating-alert">
            <p className="recorder-floating-alert-copy">{authNotice ?? errorMessage ?? galleryNotice ?? setupMessage}</p>
            {authPromptVisible && authEnabled && !activeViewer ? (
              <div className="recorder-floating-alert-actions">
                <Link href={signInHref as Route} className="recorder-hud-button recorder-hud-button-strong">
                  Log in / Sign up
                </Link>
                <button
                  type="button"
                  className="recorder-hud-button"
                  onClick={() => {
                    setAuthPromptVisible(false);
                    setAuthNotice(null);
                  }}
                >
                  Not now
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="recorder-workspace">
          <section className="recorder-canvas-pane">
            <div className="recorder-board-stage">
              <div ref={canvasFrameRef} className="canvas-frame recorder-board-frame">
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
            </div>

            <div className="recorder-bottom-controls recorder-bottom-controls-inline">
              <div className="recorder-bottom-dock">
                <div className="recorder-target-cluster">
                  <span className="recorder-dock-label">Destination</span>
                  <div className="segmented-control recorder-destination-control">
                    <button
                      type="button"
                      className={outputTarget === "image" ? "active" : ""}
                      onClick={() => setOutputTarget("image")}
                      disabled={controlTransitioning}
                    >
                      Image
                    </button>
                    <button
                      type="button"
                      className={outputTarget === "world" ? "active" : ""}
                      onClick={() => setOutputTarget("world")}
                      disabled={controlTransitioning}
                    >
                      3D world
                    </button>
                    <button
                      type="button"
                      className={outputTarget === "video" ? "active" : ""}
                      onClick={() => setOutputTarget("video")}
                      disabled={controlTransitioning}
                    >
                      Video
                    </button>
                    <button
                      type="button"
                      className={outputTarget === "website" ? "active" : ""}
                      onClick={() => setOutputTarget("website")}
                      disabled={controlTransitioning || !websiteEnabled}
                    >
                      Website
                    </button>
                  </div>
                </div>

                {phase === "listening" && hasSketchContent ? (
                  <button
                    type="button"
                    className="primary-button stop-button recorder-primary-button recorder-cta-button recorder-go-button"
                    onClick={handleGo}
                    disabled={controlTransitioning}
                    aria-label="Go generate this take"
                  >
                    Go
                  </button>
                ) : null}
              </div>
            </div>
          </section>

          <aside className="recorder-gallery-panel">
            <div className="recorder-gallery-body recorder-gallery-body-compact">
              {galleryItems.map((item) => {
                const thumb = (
                  <div className="recorder-gallery-card-thumb">
                    {item.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={item.thumbnailUrl} alt="" className="recorder-gallery-image" />
                    ) : (
                      <div className="recorder-gallery-placeholder" />
                    )}
                    {item.status === "pending" || item.status === "running" ? (
                      <span className="recorder-gallery-spinner" aria-hidden="true" />
                    ) : null}
                  </div>
                );

                return (
                  <article
                    key={item.sessionId}
                    ref={(node) => setGalleryCardRef(item.sessionId, node)}
                    className={getGalleryCardClass(item)}
                    onContextMenu={(event) => openGalleryContextMenu(event, item.sessionId)}
                  >
                    {item.href ? (
                      <Link
                        href={item.href as Route}
                        className="recorder-gallery-card-link recorder-gallery-card-link-compact"
                        aria-label={`Open ${item.title}`}
                        title={item.title}
                      >
                        {thumb}
                      </Link>
                    ) : (
                      <button
                        type="button"
                        className="recorder-gallery-card-link recorder-gallery-card-link-compact recorder-gallery-card-link-button"
                        title={item.title}
                        aria-label={`${item.title} is not ready yet`}
                        onClick={() =>
                          showGalleryNotice(
                            item.status === "failed"
                              ? item.detail || "This result failed."
                              : `${item.title} isn't ready yet. ${item.detail}`
                          )
                        }
                      >
                        {thumb}
                      </button>
                    )}
                  </article>
                );
              })}
            </div>
          </aside>

          {galleryContextMenu ? (
            <div
              className="recorder-gallery-context-menu"
              style={{ left: galleryContextMenu.x, top: galleryContextMenu.y }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                className="recorder-gallery-context-menu-item recorder-gallery-context-menu-item-danger"
                onClick={() => void deleteGallerySession(galleryContextMenu.sessionId)}
                disabled={deletingSessionId === galleryContextMenu.sessionId}
              >
                {deletingSessionId === galleryContextMenu.sessionId ? "Deleting..." : "Delete"}
              </button>
            </div>
          ) : null}
        </div>

        {activeDrawer ? <button type="button" className="recorder-drawer-scrim" onClick={() => setActiveDrawer(null)} /> : null}

        <aside className={`recorder-drawer ${activeDrawer ? "open" : ""}`}>
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
                      disabled={controlTransitioning}
                    >
                      Image
                    </button>
                    <button
                      type="button"
                      className={outputTarget === "world" ? "active" : ""}
                      onClick={() => setOutputTarget("world")}
                      disabled={controlTransitioning}
                    >
                      3D world
                    </button>
                    <button
                      type="button"
                      className={outputTarget === "video" ? "active" : ""}
                      onClick={() => setOutputTarget("video")}
                      disabled={controlTransitioning}
                    >
                      Video
                    </button>
                    <button
                      type="button"
                      className={outputTarget === "website" ? "active" : ""}
                      onClick={() => setOutputTarget("website")}
                      disabled={controlTransitioning || !websiteEnabled}
                    >
                      Website
                    </button>
                  </div>
                  <p className="recorder-settings-copy">{outputTargetSummary(outputTarget, websiteEnabled)}</p>
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
                        disabled={controlTransitioning}
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
                        disabled={controlTransitioning}
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
                        disabled={controlTransitioning}
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
                        disabled={controlTransitioning}
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
                        disabled={controlTransitioning || imageGenerationProfile === "fast"}
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
                    Chrome demo path: Web Audio PCM capture, OpenAI Realtime transcription with server VAD,
                    local drawing timeline, inline gallery tracking, and optional World Labs world build.
                  </p>
                </section>
              </div>
            </>
          ) : null}
        </aside>

        {flight ? (
          <div
            className={`recorder-flight-thumb ${flight.phase === "animating" ? "animating" : ""}`}
            style={
              flight.phase === "animating" && flight.to
                ? {
                    top: flight.to.top,
                    left: flight.to.left,
                    width: flight.to.width,
                    height: flight.to.height
                  }
                : {
                    top: flight.from.top,
                    left: flight.from.left,
                    width: flight.from.width,
                    height: flight.from.height
                  }
            }
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={flight.imageUrl} alt="" />
          </div>
        ) : null}
      </div>
    </main>
  );
}
