import { requireApiViewer } from "@/lib/auth-route";
import { getSessionDetail } from "@/lib/session-store";
import { editSessionGeneratedImage } from "@/lib/session-pipeline";
import { AssetKind, ImageEditAnnotation, TranscriptToken } from "@/lib/types";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type EditableImageAssetKind = Extract<
  AssetKind,
  "editedImage" | "generatedImageLabeled" | "generatedImagePlain" | "generatedImage"
>;

function parseSourceAssetKind(value: unknown): EditableImageAssetKind | undefined {
  return value === "editedImage" ||
    value === "generatedImageLabeled" ||
    value === "generatedImagePlain" ||
    value === "generatedImage"
    ? value
    : undefined;
}

function parseDataUrl(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/i.exec(value.trim());
  if (!match) {
    return null;
  }

  return Buffer.from(match[1], "base64");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseAnnotation(value: unknown): ImageEditAnnotation | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const annotation = value as ImageEditAnnotation;
  if (
    !isFiniteNumber(annotation.viewportWidth) ||
    !isFiniteNumber(annotation.viewportHeight) ||
    !annotation.bbox ||
    typeof annotation.bbox !== "object" ||
    !Array.isArray(annotation.strokes)
  ) {
    return null;
  }

  const strokes = annotation.strokes
    .map((stroke) => ({
      id: typeof stroke.id === "string" && stroke.id ? stroke.id : crypto.randomUUID(),
      startMs: isFiniteNumber(stroke.startMs) ? stroke.startMs : null,
      endMs: isFiniteNumber(stroke.endMs) ? stroke.endMs : null,
      points: Array.isArray(stroke.points)
        ? stroke.points
            .map((point) => ({
              x: Number(point.x),
              y: Number(point.y),
              tMs: isFiniteNumber(point.tMs) ? point.tMs : undefined
            }))
            .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
            .slice(0, 180)
        : []
    }))
    .filter((stroke) => stroke.points.length > 0)
    .slice(0, 24);

  if (!strokes.length) {
    return null;
  }

  return {
    viewportWidth: Math.max(1, Math.round(annotation.viewportWidth)),
    viewportHeight: Math.max(1, Math.round(annotation.viewportHeight)),
    devicePixelRatio: isFiniteNumber(annotation.devicePixelRatio) ? annotation.devicePixelRatio : 1,
    bbox: {
      x: Number(annotation.bbox.x) || 0,
      y: Number(annotation.bbox.y) || 0,
      width: Math.max(1, Number(annotation.bbox.width) || 1),
      height: Math.max(1, Number(annotation.bbox.height) || 1)
    },
    strokes
  };
}

function parseTranscriptTokens(value: unknown): TranscriptToken[] | null {
  return Array.isArray(value) ? (value as TranscriptToken[]) : null;
}

function getErrorStatus(message: string) {
  if (/not configured/i.test(message)) {
    return 503;
  }
  if (/not found/i.test(message)) {
    return 404;
  }
  if (/required|missing|before|generated image/i.test(message)) {
    return 409;
  }
  return 500;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const { viewer, response } = await requireApiViewer(`/sessions/${sessionId}/image`);
  if (response) {
    return response;
  }

  if (!(await getSessionDetail(sessionId, viewer?.id))) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const transcriptText = typeof body?.transcriptText === "string" ? body.transcriptText.trim() : "";
  const annotation = parseAnnotation(body?.annotation);
  const annotatedImage = parseDataUrl(body?.annotatedImageDataUrl);

  if (!transcriptText) {
    return NextResponse.json({ error: "Record a voice edit request before submitting." }, { status: 400 });
  }
  if (!annotation) {
    return NextResponse.json({ error: "Draw on the image before submitting." }, { status: 400 });
  }
  if (!annotatedImage) {
    return NextResponse.json({ error: "Missing annotated image." }, { status: 400 });
  }

  try {
    const result = await editSessionGeneratedImage({
      sessionId,
      transcriptText,
      transcriptTokens: parseTranscriptTokens(body?.transcriptTokens),
      annotation,
      annotatedImage,
      sourceAssetKind: parseSourceAssetKind(body?.sourceAssetKind)
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Image edit failed.";
    return NextResponse.json({ error: message }, { status: getErrorStatus(message) });
  }
}
