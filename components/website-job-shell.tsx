"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent } from "react";
import {
  SessionDetail,
  TranscriptToken,
  WebsiteEditAnnotation,
  WebsiteEditDomCandidate,
  WebsiteEditPoint,
  WebsiteEditRect,
  WebsiteEditStroke,
  WebsiteJob
} from "@/lib/types";

const MAX_EDIT_STROKE_POINTS = 160;

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

function websiteFrameworkLabel(framework: WebsiteJob["framework"]) {
  return framework === "next-react" ? "Next.js + React + TypeScript" : "Vite + React + TypeScript";
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

function shouldAppendStrokePoint(previous: WebsiteEditPoint, next: WebsiteEditPoint) {
  const distance = Math.hypot(next.x - previous.x, next.y - previous.y);
  const elapsedMs =
    typeof previous.tMs === "number" && typeof next.tMs === "number" ? Math.abs(next.tMs - previous.tMs) : 0;
  return distance >= 2 || elapsedMs >= 50;
}

function sampleStrokePoints(points: WebsiteEditPoint[]) {
  if (points.length <= MAX_EDIT_STROKE_POINTS) {
    return points;
  }

  const sampled: WebsiteEditPoint[] = [];
  const step = (points.length - 1) / (MAX_EDIT_STROKE_POINTS - 1);
  for (let index = 0; index < MAX_EDIT_STROKE_POINTS; index += 1) {
    const point = points[Math.round(index * step)];
    if (point && sampled[sampled.length - 1] !== point) {
      sampled.push(point);
    }
  }
  return sampled;
}

function prepareEditStrokesForSubmit(strokes: WebsiteEditStroke[]): WebsiteEditStroke[] {
  return strokes.map((stroke) => {
    const points = sampleStrokePoints(stroke.points);
    const pointTimes = points
      .map((point) => point.tMs)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    return {
      ...stroke,
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

function trimText(value: string | null | undefined, maxLength: number) {
  const trimmed = (value ?? "").replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
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
      id: token.id || `edit-voice-token-${index + 1}`,
      startMs,
      endMs: Math.max(startMs + 1, Math.round(token.endMs + offsetMs))
    };
  });
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
  const [editTranscriptTokens, setEditTranscriptTokens] = useState<TranscriptToken[] | null>(null);
  const [editStrokes, setEditStrokes] = useState<WebsiteEditStroke[]>([]);
  const [editError, setEditError] = useState<string | null>(null);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [voiceRecording, setVoiceRecording] = useState(false);
  const [voiceTranscribing, setVoiceTranscribing] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<string | null>(null);
  const [overlaySize, setOverlaySize] = useState({ width: 1, height: 1 });
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const overlayRef = useRef<SVGSVGElement | null>(null);
  const activeStrokeIdRef = useRef<string | null>(null);
  const editStartedAtRef = useRef<number | null>(null);
  const voiceRecorderRef = useRef<MediaRecorder | null>(null);
  const voiceStreamRef = useRef<MediaStream | null>(null);
  const voiceChunksRef = useRef<Blob[]>([]);
  const voiceStartedAtRef = useRef<number | null>(null);
  const voiceTimelineOffsetMsRef = useRef(0);

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

  useEffect(() => {
    editStartedAtRef.current = editOpen ? performance.now() : null;
  }, [editOpen]);

  useEffect(() => {
    return () => {
      const recorder = voiceRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null;
        recorder.stop();
      }
      stopVoiceStream();
    };
  }, []);

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

  async function submitVoiceRecording(audioBlob: Blob, durationMs: number, timelineOffsetMs: number) {
    if (!audioBlob.size) {
      setVoiceStatus(null);
      return;
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
        new File([audioBlob], `website-edit-voice.${extension}`, {
          type: audioBlob.type || "audio/webm"
        })
      );
      formData.append("durationMs", String(Math.max(0, Math.round(durationMs))));

      const response = await fetch(`/api/sessions/${session.id}/websites/${job.id}/edits/transcribe`, {
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

      setEditInstruction(text);
      setEditTranscriptTokens(shiftTranscriptTokens(transcriptTokens, timelineOffsetMs));
      setVoiceStatus(
        payload.transcriptApproximate
          ? "Voice transcribed with approximate timing."
          : "Voice transcribed with timing."
      );
    } catch (error) {
      setEditError(error instanceof Error ? error.message : "Failed to transcribe the voice request.");
      setVoiceStatus(null);
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

        voiceRecorderRef.current = null;
        voiceStartedAtRef.current = null;
        voiceChunksRef.current = [];
        setVoiceRecording(false);
        stopVoiceStream();
        void submitVoiceRecording(blob, durationMs, offsetMs);
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

  function stopVoiceRecording() {
    const recorder = voiceRecorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      return;
    }

    recorder.stop();
  }

  function cancelVoiceRecording() {
    const recorder = voiceRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = null;
      recorder.stop();
    }
    voiceRecorderRef.current = null;
    voiceStartedAtRef.current = null;
    voiceChunksRef.current = [];
    setVoiceRecording(false);
    stopVoiceStream();
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
    if (activeStrokeIdRef.current) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    activeStrokeIdRef.current = null;
  }

  async function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error ?? new Error("Failed to read image data."));
      reader.readAsDataURL(blob);
    });
  }

  async function inlineIframeImages(sourceDoc: Document, clonedRoot: Element) {
    const sourceImages = Array.from(sourceDoc.images);
    const clonedImages = Array.from(clonedRoot.querySelectorAll("img"));
    await Promise.all(
      clonedImages.map(async (image, index) => {
        const sourceImage = sourceImages[index];
        const rawSrc = sourceImage?.currentSrc || sourceImage?.src || image.getAttribute("src");
        const src = rawSrc ? new URL(rawSrc, sourceDoc.location.href).toString() : "";
        if (!src || src.startsWith("data:")) {
          return;
        }

        try {
          const response = await fetch(src, { cache: "no-store" });
          if (!response.ok) {
            return;
          }
          image.setAttribute("src", await blobToDataUrl(await response.blob()));
          image.removeAttribute("srcset");
        } catch {
          // Keep the original src. The SVG render path may still handle same-origin images.
        }
      })
    );
  }

  function inlineComputedStyles(sourceRoot: Element, clonedRoot: Element) {
    const sourceElements = [sourceRoot, ...Array.from(sourceRoot.querySelectorAll("*"))];
    const clonedElements = [clonedRoot, ...Array.from(clonedRoot.querySelectorAll("*"))];

    sourceElements.forEach((sourceElement, index) => {
      const clonedElement = clonedElements[index];
      const view = sourceElement.ownerDocument.defaultView;
      if (!clonedElement || !view) {
        return;
      }

      const computed = view.getComputedStyle(sourceElement);
      const styleText = Array.from(computed)
        .map((property) => `${property}:${computed.getPropertyValue(property)};`)
        .join("");
      clonedElement.setAttribute("style", styleText);

      if (sourceElement.tagName === "INPUT" && clonedElement.tagName === "INPUT") {
        clonedElement.setAttribute("value", (sourceElement as HTMLInputElement).value);
      }
      if (sourceElement.tagName === "TEXTAREA" && clonedElement.tagName === "TEXTAREA") {
        clonedElement.textContent = (sourceElement as HTMLTextAreaElement).value;
      }
    });
  }

  async function buildActualAnnotatedScreenshotDataUrl(annotation: WebsiteEditAnnotation) {
    const frame = iframeRef.current;
    const doc = frame?.contentDocument;
    const view = doc?.defaultView;
    if (!frame || !doc?.body || !view) {
      return null;
    }

    const viewportWidth = Math.max(1, Math.round(overlaySize.width));
    const viewportHeight = Math.max(1, Math.round(overlaySize.height));
    const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const scrollX = doc.defaultView?.scrollX ?? 0;
    const scrollY = doc.defaultView?.scrollY ?? 0;
    const documentWidth = Math.max(
      viewportWidth,
      doc.documentElement.scrollWidth,
      doc.body.scrollWidth,
      doc.documentElement.clientWidth
    );
    const documentHeight = Math.max(
      viewportHeight,
      doc.documentElement.scrollHeight,
      doc.body.scrollHeight,
      doc.documentElement.clientHeight
    );

    const clonedBody = doc.body.cloneNode(true) as HTMLElement;
    inlineComputedStyles(doc.body, clonedBody);
    clonedBody.querySelectorAll("script, style, link").forEach((element) => element.remove());
    await inlineIframeImages(doc, clonedBody);

    const bodyBackground = view.getComputedStyle(doc.body).backgroundColor || "#ffffff";
    const serializedBody = new XMLSerializer().serializeToString(clonedBody);
    const svg = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${viewportWidth}" height="${viewportHeight}" viewBox="0 0 ${viewportWidth} ${viewportHeight}">`,
      `<foreignObject x="0" y="0" width="${viewportWidth}" height="${viewportHeight}">`,
      `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${viewportWidth}px;height:${viewportHeight}px;overflow:hidden;background:${bodyBackground};">`,
      `<div style="width:${documentWidth}px;height:${documentHeight}px;transform:translate(${-scrollX}px, ${-scrollY}px);transform-origin:top left;">`,
      serializedBody,
      "</div></div></foreignObject></svg>"
    ].join("");

    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const nextImage = new Image();
      const svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
      const objectUrl = URL.createObjectURL(svgBlob);
      nextImage.onload = () => {
        URL.revokeObjectURL(objectUrl);
        resolve(nextImage);
      };
      nextImage.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error("Failed to render current website screenshot."));
      };
      nextImage.src = objectUrl;
    });

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewportWidth * scale);
    canvas.height = Math.round(viewportHeight * scale);
    const context = canvas.getContext("2d");
    if (!context) {
      return null;
    }

    context.scale(scale, scale);
    context.drawImage(image, 0, 0, viewportWidth, viewportHeight);
    drawAnnotationOnCanvas(context, annotation, 1, 1);
    return canvas.toDataURL("image/png");
  }

  function drawAnnotationOnCanvas(
    context: CanvasRenderingContext2D,
    annotation: WebsiteEditAnnotation,
    scaleX: number,
    scaleY: number
  ) {
    const strokeScale = (scaleX + scaleY) / 2;
    context.save();
    context.strokeStyle = "#ff4f38";
    context.fillStyle = "rgba(255, 79, 56, 0.12)";
    context.lineWidth = Math.max(5, 8 * strokeScale);
    context.lineCap = "round";
    context.lineJoin = "round";
    annotation.strokes.forEach((stroke) => {
      if (!stroke.points.length) {
        return;
      }
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
      context.closePath();
      context.fill();
      context.stroke();
    });
    context.restore();
  }

  async function buildFallbackAnnotatedScreenshotDataUrl(annotation: WebsiteEditAnnotation) {
    if (!job.previewImageUrl) {
      return null;
    }

    try {
      const response = await fetch(job.previewImageUrl, { cache: "no-store" });
      if (!response.ok) {
        return null;
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      try {
        const image = await new Promise<HTMLImageElement>((resolve, reject) => {
          const nextImage = new Image();
          nextImage.onload = () => resolve(nextImage);
          nextImage.onerror = () => reject(new Error("Failed to load website preview image."));
          nextImage.src = objectUrl;
        });

        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth || image.width;
        canvas.height = image.naturalHeight || image.height;
        if (!canvas.width || !canvas.height) {
          return null;
        }

        const context = canvas.getContext("2d");
        if (!context) {
          return null;
        }

        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const scaleX = canvas.width / Math.max(1, annotation.viewportWidth);
        const scaleY = canvas.height / Math.max(1, annotation.viewportHeight);
        drawAnnotationOnCanvas(context, annotation, scaleX, scaleY);
        return canvas.toDataURL("image/png");
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    } catch {
      return null;
    }
  }

  async function buildAnnotatedScreenshotDataUrl(annotation: WebsiteEditAnnotation) {
    let actualScreenshot: string | null = null;
    try {
      actualScreenshot = await buildActualAnnotatedScreenshotDataUrl(annotation);
    } catch {
      actualScreenshot = null;
    }

    return actualScreenshot ?? buildFallbackAnnotatedScreenshotDataUrl(annotation);
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

    function collectImageMetadata(element: Element) {
      const images = [
        ...(element.tagName.toLowerCase() === "img" ? [element] : []),
        ...Array.from(element.querySelectorAll("img"))
      ]
        .map((image) => {
          const img = image as HTMLImageElement;
          return {
            src: img.currentSrc || img.src || img.getAttribute("src") || "",
            alt: img.alt || img.getAttribute("aria-label") || ""
          };
        })
        .filter((image) => image.src)
        .slice(0, 4);

      return {
        imageSrcs: Array.from(new Set(images.map((image) => image.src))).slice(0, 4),
        imageAlts: Array.from(new Set(images.map((image) => trimText(image.alt, 120)).filter(Boolean) as string[])).slice(0, 4)
      };
    }

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

        const imageMetadata = collectImageMetadata(element);

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
          ...(imageMetadata.imageSrcs.length ? { imageSrcs: imageMetadata.imageSrcs } : {}),
          ...(imageMetadata.imageAlts.length ? { imageAlts: imageMetadata.imageAlts } : {}),
          rect: candidateRect
        };
      })
      .filter((candidate): candidate is WebsiteEditDomCandidate => Boolean(candidate))
      .slice(0, 180);
  }

  async function submitWebsiteEdit() {
    if (!canEdit || voiceRecording || voiceTranscribing) {
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

    const submittedStrokes = prepareEditStrokesForSubmit(editStrokes);
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
      strokes: submittedStrokes
    };

    setEditSubmitting(true);
    setEditError(null);
    try {
      const annotatedScreenshotDataUrl = await buildAnnotatedScreenshotDataUrl(annotation);
      const response = await fetch(`/api/sessions/${session.id}/websites/${job.id}/edits`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          instructionText: trimmedInstruction,
          annotation,
          domCandidates: collectDomCandidates(),
          transcriptTokens: editTranscriptTokens,
          annotatedScreenshotDataUrl
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
                if (editOpen) {
                  cancelVoiceRecording();
                }
                setEditOpen((value) => !value);
                setEditError(null);
                setVoiceStatus(null);
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
              onChange={(event) => {
                setEditInstruction(event.target.value);
                setEditTranscriptTokens(null);
                setVoiceStatus(null);
              }}
              placeholder="Make this a little bigger"
              rows={3}
              disabled={editSubmitting || voiceRecording || voiceTranscribing}
            />
            <div className="website-edit-actions">
              <button
                type="button"
                className={`image-hud-button website-voice-button ${voiceRecording ? "recording" : ""}`}
                onClick={() => {
                  if (voiceRecording) {
                    stopVoiceRecording();
                  } else {
                    void startVoiceRecording();
                  }
                }}
                disabled={editSubmitting || voiceTranscribing}
              >
                {voiceRecording ? "Stop voice" : voiceTranscribing ? "Transcribing" : "Voice"}
              </button>
              <button
                type="button"
                className="image-hud-button"
                onClick={() => {
                  setEditStrokes([]);
                  setEditInstruction("");
                  setEditTranscriptTokens(null);
                  setEditError(null);
                  setVoiceStatus(null);
                }}
                disabled={
                  editSubmitting || voiceRecording || (!editStrokes.length && !editInstruction && !editTranscriptTokens)
                }
              >
                Clear
              </button>
              <button
                type="submit"
                className="image-hud-button image-hud-button-strong"
                disabled={editSubmitting || voiceRecording || voiceTranscribing}
              >
                {editSubmitting ? "Starting" : "Apply"}
              </button>
            </div>
            {voiceStatus ? <p className="website-edit-voice-status">{voiceStatus}</p> : null}
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
              <p className="image-info-copy">{websiteFrameworkLabel(job.framework)}</p>
              <p className="image-info-label">Website model</p>
              <p className="image-info-copy">
                {job.generationProfile === "fast" ? "Fast (v0)" : "Econ (Codex)"}
              </p>
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
