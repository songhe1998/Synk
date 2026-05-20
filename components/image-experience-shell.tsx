"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent } from "react";
import { assignAnnotationColors, DEFAULT_ANNOTATION_COLOR } from "@/lib/annotation-color";
import { AssetKind, ImageEditAnnotation, ImageEditPoint, ImageEditStroke, SessionDetail, TranscriptToken } from "@/lib/types";

const MAX_EDIT_STROKE_POINTS = 160;
const EDIT_STROKE_WIDTH = 4;
const EDIT_STROKE_ALPHA = 0.95;

type ColoredImageEditStroke = ImageEditStroke & {
  color?: string;
};

type ColoredImageEditAnnotation = Omit<ImageEditAnnotation, "strokes"> & {
  strokes: ColoredImageEditStroke[];
};

type EditableImageAssetKind = Extract<
  AssetKind,
  "editedImage" | "generatedImageLabeled" | "generatedImagePlain" | "generatedImage"
>;

function getPrimaryImage(session: SessionDetail): {
  url: string | null | undefined;
  label: string;
  assetKind: EditableImageAssetKind | null;
} {
  if (session.editedImageUrl) {
    return {
      url: session.editedImageUrl,
      label: "Edited image",
      assetKind: "editedImage"
    };
  }

  if (session.generatedImageLabeledUrl) {
    return {
      url: session.generatedImageLabeledUrl,
      label: "Generated image",
      assetKind: "generatedImageLabeled"
    };
  }

  if (session.generatedImagePlainUrl) {
    return {
      url: session.generatedImagePlainUrl,
      label: "Generated image",
      assetKind: "generatedImagePlain"
    };
  }

  if (session.generatedImageUrl) {
    return {
      url: session.generatedImageUrl,
      label: "Generated image",
      assetKind: "generatedImage"
    };
  }

  return {
    url: session.annotatedSketchUrl ?? session.sketchUrl,
    label: session.annotatedSketchUrl ? "Annotated sketch" : "Sketch",
    assetKind: null
  };
}

function strokePath(points: ImageEditPoint[]) {
  if (!points.length) {
    return "";
  }

  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(" ");
}

function computeStrokeBbox(strokes: ImageEditStroke[]) {
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

function shouldAppendStrokePoint(previous: ImageEditPoint, next: ImageEditPoint) {
  const distance = Math.hypot(next.x - previous.x, next.y - previous.y);
  const elapsedMs =
    typeof previous.tMs === "number" && typeof next.tMs === "number" ? Math.abs(next.tMs - previous.tMs) : 0;
  return distance >= 2 || elapsedMs >= 50;
}

function sampleStrokePoints(points: ImageEditPoint[]) {
  if (points.length <= MAX_EDIT_STROKE_POINTS) {
    return points;
  }

  const sampled: ImageEditPoint[] = [];
  const step = (points.length - 1) / (MAX_EDIT_STROKE_POINTS - 1);
  for (let index = 0; index < MAX_EDIT_STROKE_POINTS; index += 1) {
    const point = points[Math.round(index * step)];
    if (point && sampled[sampled.length - 1] !== point) {
      sampled.push(point);
    }
  }
  return sampled;
}

function prepareEditStrokesForSubmit(strokes: ColoredImageEditStroke[]): ColoredImageEditStroke[] {
  return strokes.map((stroke) => {
    const points = sampleStrokePoints(stroke.points);
    const pointTimes = points
      .map((point) => point.tMs)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    return {
      id: stroke.id,
      color: stroke.color,
      points,
      startMs:
        typeof stroke.startMs === "number" && Number.isFinite(stroke.startMs)
          ? stroke.startMs
          : pointTimes.length
            ? Math.min(...pointTimes)
            : null,
      endMs:
        typeof stroke.endMs === "number" && Number.isFinite(stroke.endMs)
          ? stroke.endMs
          : pointTimes.length
            ? Math.max(...pointTimes)
            : null
    };
  });
}

function readRouteError(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string") {
    return payload.error;
  }

  return fallback;
}

function getSupportedVoiceMimeType() {
  if (typeof MediaRecorder === "undefined") {
    return "";
  }

  return (
    ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((mimeType) =>
      MediaRecorder.isTypeSupported(mimeType)
    ) ?? ""
  );
}

function shiftTranscriptTokens(tokens: TranscriptToken[], offsetMs: number): TranscriptToken[] {
  return tokens.map((token, index) => {
    const startMs = Math.max(0, Math.round(token.startMs + offsetMs));
    return {
      ...token,
      id: token.id || `image-edit-voice-token-${index + 1}`,
      startMs,
      endMs: Math.max(startMs + 1, Math.round(token.endMs + offsetMs))
    };
  });
}

function formatInfoTimestamp(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }

  return `${new Date(timestamp).toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

function formatInfoBlock(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return trimmed;
  }
}

function formatAssetKindLabel(assetKind: AssetKind) {
  switch (assetKind) {
    case "editedImage":
      return "Edited image";
    case "generatedImageLabeled":
      return "Generated image";
    case "generatedImagePlain":
      return "Plain generated image";
    case "generatedImage":
      return "Generated image";
    case "generatedVideoSourceImage":
      return "Video source image";
    case "sketch":
      return "Sketch";
    case "annotatedSketch":
      return "Annotated sketch";
    case "videoAnnotatedSketch":
      return "Video annotated sketch";
  }
}

type VoiceTranscriptResult = {
  text: string;
  transcriptTokens: TranscriptToken[] | null;
};

interface ImageRestoreReferenceItem {
  id: string;
  revisionNumber: number;
  label: string;
  imageUrl: string;
}

export function ImageExperienceShell({
  session,
  canEditImage = true
}: {
  session: SessionDetail;
  canEditImage?: boolean;
}) {
  const [sessionData, setSessionData] = useState(session);
  const [infoOpen, setInfoOpen] = useState(false);
  const [editTranscript, setEditTranscript] = useState("");
  const [editTranscriptTokens, setEditTranscriptTokens] = useState<TranscriptToken[] | null>(null);
  const [editStrokes, setEditStrokes] = useState<ColoredImageEditStroke[]>([]);
  const [editError, setEditError] = useState<string | null>(null);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [restoreSubmitting, setRestoreSubmitting] = useState(false);
  const [selectedRestoreRevision, setSelectedRestoreRevision] = useState<number | null>(null);
  const [voiceRecording, setVoiceRecording] = useState(false);
  const [voiceTranscribing, setVoiceTranscribing] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<string | null>(null);
  const [overlaySize, setOverlaySize] = useState({ width: 1, height: 1 });
  const [imageRenderSize, setImageRenderSize] = useState<{ width: number; height: number } | null>(null);
  const imageShellRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const overlayRef = useRef<SVGSVGElement | null>(null);
  const colorSamplingCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const colorSamplingCacheRef = useRef<{
    key: string;
    imageData: ImageData;
  } | null>(null);
  const activeStrokeIdRef = useRef<string | null>(null);
  const editStartedAtRef = useRef<number | null>(null);
  const voiceRecorderRef = useRef<MediaRecorder | null>(null);
  const voiceStreamRef = useRef<MediaStream | null>(null);
  const voiceChunksRef = useRef<Blob[]>([]);
  const voiceStartedAtRef = useRef<number | null>(null);
  const voiceTimelineOffsetMsRef = useRef(0);
  const voiceAutoStartedRef = useRef(false);
  const voiceTranscriptionPromiseRef = useRef<Promise<VoiceTranscriptResult | null> | null>(null);
  const voiceStopWaitersRef = useRef<
    Array<{
      resolve: (result: VoiceTranscriptResult | null) => void;
      reject: (error: unknown) => void;
    }>
  >([]);

  const primaryImage = useMemo(() => getPrimaryImage(sessionData), [sessionData]);
  const editActive = canEditImage && Boolean(primaryImage.assetKind && primaryImage.url);
  const canEdit = editActive && !editSubmitting;
  const currentStrokeBbox = useMemo(() => computeStrokeBbox(editStrokes), [editStrokes]);
  const initialImageUrl =
    sessionData.generatedImageLabeledUrl ?? sessionData.generatedImagePlainUrl ?? sessionData.generatedImageUrl;
  const imageEditHistory = sessionData.imageEditHistory ?? [];
  const latestRevisionNumber = imageEditHistory.reduce((max, item) => Math.max(max, item.revisionNumber), 0);
  const restoreReferenceItems = useMemo<ImageRestoreReferenceItem[]>(() => {
    const items: ImageRestoreReferenceItem[] = [];
    if (initialImageUrl) {
      items.push({
        id: "initial",
        revisionNumber: 0,
        label: "Initial",
        imageUrl: initialImageUrl
      });
    }
    imageEditHistory.forEach((edit) => {
      items.push({
        id: edit.id,
        revisionNumber: edit.revisionNumber,
        label: `Edit ${edit.revisionNumber}`,
        imageUrl: edit.imageUrl
      });
    });
    return items;
  }, [imageEditHistory, initialImageUrl]);
  const selectedRestoreItem =
    selectedRestoreRevision === null
      ? null
      : restoreReferenceItems.find((item) => item.revisionNumber === selectedRestoreRevision) ?? null;
  const restoreSelectionAvailable =
    Boolean(selectedRestoreItem) &&
    selectedRestoreItem!.revisionNumber < latestRevisionNumber &&
    !editStrokes.length;
  const canRestoreFromSelection = restoreSelectionAvailable && !editSubmitting && !restoreSubmitting;

  function updateImageRenderSize() {
    const shell = imageShellRef.current;
    const image = imageRef.current;
    if (!shell || !image?.naturalWidth || !image.naturalHeight) {
      return;
    }

    const rect = shell.getBoundingClientRect();
    const style = window.getComputedStyle(shell);
    const horizontalPadding =
      Number.parseFloat(style.paddingLeft || "0") + Number.parseFloat(style.paddingRight || "0");
    const verticalPadding =
      Number.parseFloat(style.paddingTop || "0") + Number.parseFloat(style.paddingBottom || "0");
    const availableWidth = Math.max(1, rect.width - horizontalPadding);
    const availableHeight = Math.max(1, rect.height - verticalPadding);
    const imageAspect = image.naturalWidth / image.naturalHeight;
    const availableAspect = availableWidth / availableHeight;
    const nextSize =
      availableAspect > imageAspect
        ? {
            width: availableHeight * imageAspect,
            height: availableHeight
          }
        : {
            width: availableWidth,
            height: availableWidth / imageAspect
          };

    setImageRenderSize({
      width: Math.round(nextSize.width),
      height: Math.round(nextSize.height)
    });
  }

  useEffect(() => {
    setImageRenderSize(null);
    colorSamplingCacheRef.current = null;
    voiceAutoStartedRef.current = false;
    setEditStrokes([]);
    setEditTranscript("");
    setEditTranscriptTokens(null);
    setEditError(null);
    setVoiceStatus(null);
  }, [primaryImage.url]);

  useEffect(() => {
    const shell = imageShellRef.current;
    if (!shell) {
      return;
    }

    updateImageRenderSize();
    const observer = new ResizeObserver(updateImageRenderSize);
    observer.observe(shell);
    window.addEventListener("resize", updateImageRenderSize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateImageRenderSize);
    };
  }, [primaryImage.url]);

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
    window.addEventListener("resize", updateSize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateSize);
    };
  }, [editActive, primaryImage.url]);

  useEffect(() => {
    editStartedAtRef.current = editActive ? performance.now() : null;
    if (editActive) {
      setInfoOpen(false);
    }
  }, [editActive]);

  useEffect(() => {
    return () => {
      const recorder = voiceRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null;
        recorder.stop();
      }
      voiceTranscriptionPromiseRef.current = null;
      voiceStopWaitersRef.current.splice(0).forEach(({ resolve }) => resolve(null));
      stopVoiceStream();
    };
  }, []);

  useEffect(() => {
    if (!editActive) {
      voiceAutoStartedRef.current = false;
      return;
    }

    if (!canEdit || voiceAutoStartedRef.current || voiceRecording || voiceTranscribing || voiceRecorderRef.current) {
      return;
    }

    voiceAutoStartedRef.current = true;
    void startVoiceRecording();
  }, [canEdit, editActive, primaryImage.url, voiceRecording, voiceTranscribing]);

  function getEditTimeMs() {
    if (editStartedAtRef.current === null) {
      editStartedAtRef.current = performance.now();
    }
    return Math.max(0, Math.round(performance.now() - editStartedAtRef.current));
  }

  function stopVoiceStream() {
    voiceStreamRef.current?.getTracks().forEach((track) => track.stop());
    voiceStreamRef.current = null;
  }

  async function submitVoiceRecording(
    audioBlob: Blob,
    durationMs: number,
    timelineOffsetMs: number
  ): Promise<VoiceTranscriptResult | null> {
    if (!audioBlob.size) {
      setVoiceStatus(null);
      return null;
    }

    setVoiceTranscribing(true);
    setVoiceStatus("Transcribing voice request...");
    setEditError(null);

    try {
      const formData = new FormData();
      const extension = audioBlob.type.includes("mp4")
        ? "m4a"
        : audioBlob.type.includes("webm")
          ? "webm"
          : "wav";
      formData.append(
        "audio",
        new File([audioBlob], `image-edit-voice.${extension}`, {
          type: audioBlob.type || "audio/webm"
        })
      );
      formData.append("durationMs", String(Math.max(0, Math.round(durationMs))));

      const response = await fetch(`/api/sessions/${sessionData.id}/image-edits/transcribe`, {
        method: "POST",
        body: formData
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(readRouteError(payload, "Failed to transcribe the voice request."));
      }

      const transcriptTokens = Array.isArray(payload.transcriptTokens)
        ? (payload.transcriptTokens as TranscriptToken[])
        : [];
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!transcriptTokens.length || !text) {
        throw new Error("Voice transcription did not return usable text.");
      }

      const shiftedTranscriptTokens = shiftTranscriptTokens(transcriptTokens, timelineOffsetMs);
      setEditTranscript(text);
      setEditTranscriptTokens(shiftedTranscriptTokens);
      setVoiceStatus(
        payload.transcriptApproximate
          ? "Voice transcribed with approximate timing."
          : "Voice transcribed with timing."
      );
      return {
        text,
        transcriptTokens: shiftedTranscriptTokens
      };
    } catch (error) {
      setEditError(error instanceof Error ? error.message : "Failed to transcribe the voice request.");
      setVoiceStatus(null);
      return null;
    } finally {
      setVoiceTranscribing(false);
    }
  }

  async function startVoiceRecording() {
    if (!canEdit || voiceRecording || voiceTranscribing) {
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setEditError("Voice recording is not supported in this browser.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = getSupportedVoiceMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);

      voiceChunksRef.current = [];
      voiceStreamRef.current = stream;
      voiceStartedAtRef.current = performance.now();
      voiceTimelineOffsetMsRef.current = getEditTimeMs();

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          voiceChunksRef.current.push(event.data);
        }
      };
      recorder.onerror = () => {
        setEditError("Voice recording failed.");
        setVoiceStatus(null);
      };
      recorder.onstop = () => {
        const chunks = voiceChunksRef.current;
        const startedAt = voiceStartedAtRef.current;
        const durationMs = startedAt === null ? 0 : Math.max(0, Math.round(performance.now() - startedAt));
        const offsetMs = voiceTimelineOffsetMsRef.current;
        const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
        const waiters = voiceStopWaitersRef.current.splice(0);

        voiceRecorderRef.current = null;
        voiceStartedAtRef.current = null;
        voiceChunksRef.current = [];
        setVoiceRecording(false);
        stopVoiceStream();
        const transcriptionPromise = submitVoiceRecording(blob, durationMs, offsetMs);
        voiceTranscriptionPromiseRef.current = transcriptionPromise;
        transcriptionPromise
          .then((result) => waiters.forEach(({ resolve }) => resolve(result)))
          .catch((error) => waiters.forEach(({ reject }) => reject(error)))
          .finally(() => {
            if (voiceTranscriptionPromiseRef.current === transcriptionPromise) {
              voiceTranscriptionPromiseRef.current = null;
            }
          });
      };

      voiceRecorderRef.current = recorder;
      recorder.start();
      setVoiceRecording(true);
      setVoiceStatus("Recording voice request...");
      setEditError(null);
    } catch (error) {
      stopVoiceStream();
      setVoiceRecording(false);
      setVoiceStatus(null);
      setEditError(error instanceof Error ? error.message : "Failed to start voice recording.");
    }
  }

  function getExistingVoiceResult(): VoiceTranscriptResult | null {
    const text = editTranscript.trim();
    return text
      ? {
          text,
          transcriptTokens: editTranscriptTokens
        }
      : null;
  }

  function stopVoiceRecordingAndTranscribe() {
    if (voiceTranscriptionPromiseRef.current) {
      return voiceTranscriptionPromiseRef.current;
    }

    const recorder = voiceRecorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      return Promise.resolve(getExistingVoiceResult());
    }

    const stopPromise = new Promise<VoiceTranscriptResult | null>((resolve, reject) => {
      voiceStopWaitersRef.current.push({ resolve, reject });
    });
    recorder.stop();
    return stopPromise;
  }

  function getOverlayPoint(event: PointerEvent<SVGSVGElement>) {
    const overlay = overlayRef.current;
    if (!overlay) {
      return null;
    }

    const rect = overlay.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
      tMs: getEditTimeMs()
    };
  }

  function getCurrentColorSamplingImageData() {
    const image = imageRef.current;
    const width = Math.max(1, Math.round(overlaySize.width));
    const height = Math.max(1, Math.round(overlaySize.height));
    if (!image || !image.complete || !image.naturalWidth || !image.naturalHeight || !width || !height) {
      return null;
    }

    const key = `${primaryImage.url ?? ""}:${width}x${height}:${image.naturalWidth}x${image.naturalHeight}`;
    if (colorSamplingCacheRef.current?.key === key) {
      return colorSamplingCacheRef.current.imageData;
    }

    const canvas = colorSamplingCanvasRef.current ?? document.createElement("canvas");
    colorSamplingCanvasRef.current = canvas;
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      return null;
    }

    context.clearRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const imageData = context.getImageData(0, 0, width, height);
    colorSamplingCacheRef.current = { key, imageData };
    return imageData;
  }

  function assignStrokeColors(strokes: ColoredImageEditStroke[]) {
    const imageData = getCurrentColorSamplingImageData();
    if (!imageData) {
      return strokes.map((stroke) => ({
        ...stroke,
        color: stroke.color ?? DEFAULT_ANNOTATION_COLOR
      }));
    }

    try {
      const assignment = assignAnnotationColors(imageData, strokes, {
        alpha: EDIT_STROKE_ALPHA,
        strokeWidth: EDIT_STROKE_WIDTH
      });
      return strokes.map((stroke) => ({
        ...stroke,
        color: assignment.colorsByStrokeId[stroke.id] ?? stroke.color ?? DEFAULT_ANNOTATION_COLOR
      }));
    } catch {
      return strokes.map((stroke) => ({
        ...stroke,
        color: stroke.color ?? DEFAULT_ANNOTATION_COLOR
      }));
    }
  }

  function beginEditStroke(event: PointerEvent<SVGSVGElement>) {
    if (!canEdit) {
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
        stroke.id === strokeId && shouldAppendStrokePoint(stroke.points[stroke.points.length - 1] ?? point, point)
          ? {
              ...stroke,
              points: [...stroke.points, point]
            }
          : stroke
      )
    );
  }

  function endEditStroke(event: PointerEvent<SVGSVGElement>) {
    const strokeId = activeStrokeIdRef.current;
    if (strokeId) {
      event.currentTarget.releasePointerCapture(event.pointerId);
      setEditStrokes((strokes) => assignStrokeColors(strokes));
    }
    activeStrokeIdRef.current = null;
  }

  function drawAnnotationOnCanvas(
    context: CanvasRenderingContext2D,
    annotation: ColoredImageEditAnnotation,
    scaleX: number,
    scaleY: number
  ) {
    const strokeScale = (scaleX + scaleY) / 2;
    const lineWidth = Math.max(1.5, EDIT_STROKE_WIDTH * strokeScale);
    context.save();
    context.globalAlpha = EDIT_STROKE_ALPHA;
    context.lineWidth = lineWidth;
    context.lineCap = "round";
    context.lineJoin = "round";
    annotation.strokes.forEach((stroke) => {
      if (!stroke.points.length) {
        return;
      }
      context.strokeStyle = stroke.color ?? DEFAULT_ANNOTATION_COLOR;
      context.lineWidth = lineWidth;
      context.beginPath();
      stroke.points.forEach((point, index) => {
        const x = point.x * scaleX;
        const y = point.y * scaleY;
        if (index === 0) {
          context.moveTo(x, y);
        } else {
          context.lineTo(x, y);
        }
      });
      context.stroke();
    });
    context.restore();
  }

  async function buildAnnotatedImageDataUrl(annotation: ColoredImageEditAnnotation) {
    const image = imageRef.current;
    if (!image || !image.complete || !image.naturalWidth || !image.naturalHeight) {
      throw new Error("The image is still loading.");
    }

    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Failed to prepare the marked image.");
    }

    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    drawAnnotationOnCanvas(
      context,
      annotation,
      canvas.width / Math.max(1, annotation.viewportWidth),
      canvas.height / Math.max(1, annotation.viewportHeight)
    );
    return canvas.toDataURL("image/png");
  }

  async function submitImageEdit() {
    if (!canEdit || voiceTranscribing || !primaryImage.assetKind) {
      return;
    }

    if (!editStrokes.length) {
      setEditError("Draw on the image before submitting.");
      return;
    }

    setEditSubmitting(true);
    setEditError(null);
    try {
      const voiceResult =
        voiceRecording || voiceTranscriptionPromiseRef.current
          ? await stopVoiceRecordingAndTranscribe()
          : getExistingVoiceResult();
      const transcriptText = voiceResult?.text.trim() ?? "";
      if (!transcriptText) {
        throw new Error("Voice request was not captured.");
      }

      const submittedStrokes = prepareEditStrokesForSubmit(editStrokes);
      const annotation: ColoredImageEditAnnotation = {
        viewportWidth: overlaySize.width,
        viewportHeight: overlaySize.height,
        devicePixelRatio: window.devicePixelRatio || 1,
        bbox: computeStrokeBbox(submittedStrokes),
        strokes: submittedStrokes
      };
      const annotatedImageDataUrl = await buildAnnotatedImageDataUrl(annotation);
      const response = await fetch(`/api/sessions/${sessionData.id}/image-edits`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          sourceAssetKind: primaryImage.assetKind,
          transcriptText,
          transcriptTokens: voiceResult?.transcriptTokens ?? editTranscriptTokens,
          annotation,
          annotatedImageDataUrl
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(readRouteError(payload, "Image edit failed."));
      }

      const nextSession = payload.session as SessionDetail | undefined;
      if (!nextSession) {
        throw new Error("Image edit returned no session payload.");
      }

      setSessionData(nextSession);
      setEditStrokes([]);
      setEditTranscript("");
      setEditTranscriptTokens(null);
      setSelectedRestoreRevision(null);
      voiceAutoStartedRef.current = false;
      setVoiceStatus("Edit applied.");
    } catch (error) {
      setEditError(error instanceof Error ? error.message : "Image edit failed.");
      voiceAutoStartedRef.current = false;
    } finally {
      setEditSubmitting(false);
    }
  }

  async function submitReferenceRestore() {
    if (!selectedRestoreItem || !canRestoreFromSelection) {
      return;
    }

    setRestoreSubmitting(true);
    setEditError(null);
    try {
      const response = await fetch(`/api/sessions/${sessionData.id}/image-edits/restore`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          referenceRevisionNumber: selectedRestoreItem.revisionNumber
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(readRouteError(payload, "Reference restore failed."));
      }

      const nextSession = payload.session as SessionDetail | undefined;
      if (!nextSession) {
        throw new Error("Reference restore returned no session payload.");
      }

      setSessionData(nextSession);
      setSelectedRestoreRevision(null);
      setVoiceStatus("Reference restore applied.");
    } catch (error) {
      setEditError(error instanceof Error ? error.message : "Reference restore failed.");
    } finally {
      setRestoreSubmitting(false);
    }
  }

  return (
    <main className="image-experience-page">
      <section className="image-experience-stage">
        {primaryImage.url ? (
          <>
            <img src={primaryImage.url} alt={primaryImage.label} className="image-experience-background" />
            <div ref={imageShellRef} className="image-experience-image-shell">
              <div
                className={`image-edit-target ${editActive ? "editing" : ""}`}
                style={imageRenderSize ? { width: imageRenderSize.width, height: imageRenderSize.height } : undefined}
              >
                <img
                  ref={imageRef}
                  src={primaryImage.url}
                  alt={primaryImage.label}
                  className="image-experience-image"
                  onLoad={updateImageRenderSize}
                />
                {editActive ? (
                  <svg
                    ref={overlayRef}
                    className="image-edit-overlay"
                    viewBox={`0 0 ${overlaySize.width} ${overlaySize.height}`}
                    onPointerDown={beginEditStroke}
                    onPointerMove={appendEditStrokePoint}
                    onPointerUp={endEditStroke}
                    onPointerCancel={endEditStroke}
                  >
                    {editStrokes.map((stroke) => (
                      <path
                        key={stroke.id}
                        d={strokePath(stroke.points)}
                        className="image-edit-stroke"
                        style={{ stroke: stroke.color ?? DEFAULT_ANNOTATION_COLOR }}
                      />
                    ))}
                  </svg>
                ) : null}
              </div>
            </div>
          </>
        ) : (
          <div className="image-experience-empty">No generated image is available for this session yet.</div>
        )}

        <div className="image-experience-vignette" />

        <header className="image-experience-header">
          <Link href="/" className="image-hud-button image-hud-button-strong">
            Back home
          </Link>

          <div className="image-header-actions">
            <button type="button" className="image-hud-button" onClick={() => setInfoOpen((value) => !value)}>
              {infoOpen ? "Close info" : "Info"}
            </button>
          </div>
        </header>

        {restoreReferenceItems.length ? (
          <aside className="image-edit-history-rail" aria-label="Image edit history">
            <div className="image-edit-history-rail-body">
              {restoreReferenceItems.map((item) => {
                const selected = selectedRestoreRevision === item.revisionNumber;
                const current = item.revisionNumber === latestRevisionNumber;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`image-edit-history-thumb${selected ? " selected" : ""}${current ? " current" : ""}`}
                    title={
                      current
                        ? `${item.label} is the current image`
                        : selected
                          ? `${item.label} selected as restore reference`
                          : `Use ${item.label} as restore reference`
                    }
                    aria-label={
                      current
                        ? `${item.label}, current image`
                        : selected
                          ? `${item.label}, selected as restore reference`
                          : `Select ${item.label} as restore reference`
                    }
                    aria-pressed={selected}
                    onClick={() =>
                      setSelectedRestoreRevision((revision) =>
                        revision === item.revisionNumber ? null : item.revisionNumber
                      )
                    }
                    disabled={restoreSubmitting}
                  >
                    <img src={item.imageUrl} alt="" />
                    <span>{item.revisionNumber === 0 ? "0" : item.revisionNumber}</span>
                  </button>
                );
              })}
            </div>
          </aside>
        ) : null}

        {editActive && editStrokes.length ? (
          <button
            type="button"
            className="image-hud-button image-hud-button-strong image-edit-go-button image-edit-go-floating"
            onClick={submitImageEdit}
            disabled={!canEdit || editSubmitting || voiceTranscribing}
            aria-label="Apply image edit"
          >
            {editSubmitting ? "Editing..." : "Go"}
          </button>
        ) : null}

        {restoreSelectionAvailable ? (
          <button
            type="button"
            className="image-hud-button image-hud-button-strong image-restore-floating"
            onClick={submitReferenceRestore}
            disabled={!canRestoreFromSelection}
          >
            {restoreSubmitting ? "Restoring..." : "Restore"}
          </button>
        ) : null}

        {infoOpen ? (
          <button
            type="button"
            className="image-info-scrim"
            onClick={() => setInfoOpen(false)}
            aria-label="Close image details"
          />
        ) : null}

        <aside className={`image-info-drawer ${infoOpen ? "open" : ""}`}>
          <div className="image-info-header">
            <div>
              <p className="image-info-kicker">Image details</p>
              <h2>{sessionData.title}</h2>
            </div>
            <button type="button" className="image-hud-button" onClick={() => setInfoOpen(false)}>
              Close
            </button>
          </div>

          <div className="image-info-body">
            {sessionData.analysis?.generationPrompt ? (
              <section className="image-info-section">
                <p className="image-info-label">Final prompt</p>
                <p className="image-info-copy">{sessionData.analysis.generationPrompt}</p>
              </section>
            ) : null}

            {initialImageUrl || imageEditHistory.length ? (
              <section className="image-info-section">
                <div className="image-info-section-heading">
                  <p className="image-info-label">Image timeline</p>
                  <p className="image-info-copy image-info-muted">
                    {imageEditHistory.length === 1
                      ? "1 edit recorded"
                      : `${imageEditHistory.length} edits recorded`}
                  </p>
                </div>

                <div className="image-edit-history">
                  {initialImageUrl ? (
                    <article className="image-edit-history-card">
                      <div className="image-edit-history-card-header">
                        <div>
                          <h3 className="image-edit-history-title">Initial image</h3>
                          <p className="image-edit-history-meta">No edits applied</p>
                        </div>
                      </div>
                      <div className="image-edit-history-images single">
                        <figure className="image-edit-history-image-panel">
                          <img src={initialImageUrl} alt="Initial generated image" />
                          <figcaption>Generated image before edits</figcaption>
                        </figure>
                      </div>
                      {sessionData.analysis?.generationPrompt ? (
                        <div className="image-edit-history-detail">
                          <p className="image-info-label">Generation prompt</p>
                          <pre className="image-info-copy-pre">{sessionData.analysis.generationPrompt}</pre>
                        </div>
                      ) : null}
                    </article>
                  ) : null}

                  {imageEditHistory.map((edit) => (
                    <article key={edit.id} className="image-edit-history-card">
                      <div className="image-edit-history-card-header">
                        <div>
                          <h3 className="image-edit-history-title">Edit {edit.revisionNumber}</h3>
                          <p className="image-edit-history-meta">{formatInfoTimestamp(edit.createdAt)}</p>
                        </div>
                        <span className="image-edit-history-badge">{formatAssetKindLabel(edit.sourceAssetKind)}</span>
                      </div>

                      <div className="image-edit-history-images">
                        <figure className="image-edit-history-image-panel">
                          <img src={edit.imageUrl} alt={`Edited result ${edit.revisionNumber}`} />
                          <figcaption>Edited result</figcaption>
                        </figure>
                        <figure className="image-edit-history-image-panel">
                          <img src={edit.annotatedImageUrl} alt={`Marked image ${edit.revisionNumber}`} />
                          <figcaption>Marked input</figcaption>
                        </figure>
                      </div>

                      {edit.transcriptText ? (
                        <div className="image-edit-history-detail">
                          <p className="image-info-label">Voice request</p>
                          <p className="image-info-copy">{edit.transcriptText}</p>
                        </div>
                      ) : null}

                      {edit.targetDescription ? (
                        <div className="image-edit-history-detail">
                          <p className="image-info-label">Target summary</p>
                          <p className="image-info-copy">{edit.targetDescription}</p>
                        </div>
                      ) : null}

                      {edit.requestedChange ? (
                        <div className="image-edit-history-detail">
                          <p className="image-info-label">Color operations</p>
                          <pre className="image-info-copy-pre">{formatInfoBlock(edit.requestedChange)}</pre>
                        </div>
                      ) : null}

                      {edit.editPrompt ? (
                        <div className="image-edit-history-detail">
                          <p className="image-info-label">Generated edit prompt</p>
                          <pre className="image-info-copy-pre">{formatInfoBlock(edit.editPrompt)}</pre>
                        </div>
                      ) : null}
                    </article>
                  ))}
                </div>
              </section>
            ) : null}

            {sessionData.annotatedSketchUrl ? (
              <section className="image-info-section">
                <p className="image-info-label">Labeled sketch</p>
                <img src={sessionData.annotatedSketchUrl} alt="Labeled sketch" className="image-info-image" />
              </section>
            ) : null}
          </div>
        </aside>
      </section>
    </main>
  );
}
