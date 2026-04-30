import { requireApiViewer } from "@/lib/auth-route";
import { getSessionDetail, markSessionFailed, saveSessionTranscript, saveSessionUpload } from "@/lib/session-store";
import { CanvasImageLayer, CanvasImageSourceAssetKind, DrawingEvent, TranscriptToken } from "@/lib/types";
import { NextResponse } from "next/server";

const CANVAS_IMAGE_SOURCE_ASSET_KINDS = new Set<CanvasImageSourceAssetKind>([
  "generatedImage",
  "generatedImageLabeled",
  "generatedImagePlain",
  "generatedVideoSourceImage",
  "editedImage"
]);

function finiteNumber(value: unknown, fallback = 0) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function parseCanvasImageLayers(value: FormDataEntryValue | null): CanvasImageLayer[] {
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .map((item, index) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const candidate = item as Partial<CanvasImageLayer>;
      const sourceAssetKind = candidate.sourceAssetKind;
      const sourceSessionId = typeof candidate.sourceSessionId === "string" ? candidate.sourceSessionId : "";
      const sourceUrl = typeof candidate.sourceUrl === "string" ? candidate.sourceUrl : "";
      if (!sourceSessionId || !sourceUrl || !CANVAS_IMAGE_SOURCE_ASSET_KINDS.has(sourceAssetKind as CanvasImageSourceAssetKind)) {
        return null;
      }

      const width = Math.max(1, finiteNumber(candidate.width));
      const height = Math.max(1, finiteNumber(candidate.height));
      return {
        id: typeof candidate.id === "string" && candidate.id ? candidate.id : `canvas-image-${index + 1}`,
        sourceSessionId,
        sourceAssetKind: sourceAssetKind as CanvasImageSourceAssetKind,
        sourceUrl,
        title: typeof candidate.title === "string" && candidate.title.trim() ? candidate.title.trim() : null,
        x: finiteNumber(candidate.x),
        y: finiteNumber(candidate.y),
        width,
        height,
        naturalWidth: Math.max(1, finiteNumber(candidate.naturalWidth, width)),
        naturalHeight: Math.max(1, finiteNumber(candidate.naturalHeight, height))
      } satisfies CanvasImageLayer;
    })
    .filter((layer): layer is CanvasImageLayer => Boolean(layer))
    .slice(0, 8);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const { viewer, response } = await requireApiViewer(`/sessions/${sessionId}`);
  if (response) {
    return response;
  }

  const ownedSession = await getSessionDetail(sessionId, viewer?.id);
  if (!ownedSession) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const formData = await request.formData();

  const audioFile = formData.get("audio");
  const sketchFile = formData.get("sketch");
  const rawEvents = formData.get("events");
  const rawCanvasImageLayers = formData.get("canvasImageLayers");
  const rawTranscript = formData.get("transcript");
  const rawTranscriptApproximate = formData.get("transcriptApproximate");
  const durationMs = Number.parseInt(String(formData.get("durationMs") ?? "0"), 10);
  const canvasWidth = Number.parseInt(String(formData.get("canvasWidth") ?? "0"), 10);
  const canvasHeight = Number.parseInt(String(formData.get("canvasHeight") ?? "0"), 10);

  if (!(audioFile instanceof File)) {
    return NextResponse.json({ error: "Missing audio file" }, { status: 400 });
  }

  if (typeof rawEvents !== "string") {
    return NextResponse.json({ error: "Missing drawing events" }, { status: 400 });
  }

  const events = JSON.parse(rawEvents) as DrawingEvent[];
  const canvasImageLayers = parseCanvasImageLayers(rawCanvasImageLayers);
  const audioBuffer = Buffer.from(await audioFile.arrayBuffer());
  const sketchBuffer =
    sketchFile instanceof File ? Buffer.from(await sketchFile.arrayBuffer()) : null;
  const audioMimeType = audioFile.type || "audio/wav";
  const extension = audioFile.name.includes(".") ? audioFile.name.split(".").pop() || "wav" : "wav";
  const transcriptTokens =
    typeof rawTranscript === "string" ? (JSON.parse(rawTranscript) as TranscriptToken[]) : null;
  const transcriptApproximate = String(rawTranscriptApproximate ?? "false") === "true";

  try {
    const uploadedSession = await saveSessionUpload(sessionId, {
      audioBuffer,
      audioMimeType,
      audioExtension: extension,
      events,
      canvasImageLayers,
      canvasWidth,
      canvasHeight,
      durationMs: Number.isFinite(durationMs) ? durationMs : 0,
      sketchBuffer
    });

    if (transcriptTokens) {
      const finalizedSession = await saveSessionTranscript(sessionId, transcriptTokens, transcriptApproximate);
      return NextResponse.json(finalizedSession);
    }

    return NextResponse.json(uploadedSession);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to upload the session.";
    await markSessionFailed(sessionId, `Session upload failed: ${message}`).catch(() => undefined);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
