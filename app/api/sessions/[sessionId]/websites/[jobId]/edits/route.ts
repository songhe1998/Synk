import { requireApiViewer } from "@/lib/auth-route";
import { getSessionDetail } from "@/lib/session-store";
import { startWebsiteEditJob } from "@/lib/website-pipeline";
import { getWebsiteJob } from "@/lib/website-store";
import { TranscriptToken, WebsiteEditAnnotation, WebsiteEditDomCandidate } from "@/lib/types";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function getWebsiteEditErrorStatus(message: string) {
  if (/not configured/i.test(message)) {
    return 503;
  }

  if (/not found/i.test(message)) {
    return 404;
  }

  if (/required|ready|identify|annotation/i.test(message)) {
    return 409;
  }

  return 500;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseAnnotation(value: unknown): WebsiteEditAnnotation | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const annotation = value as WebsiteEditAnnotation;
  if (
    !isFiniteNumber(annotation.viewportWidth) ||
    !isFiniteNumber(annotation.viewportHeight) ||
    !isFiniteNumber(annotation.devicePixelRatio) ||
    typeof annotation.path !== "string" ||
    !isFiniteNumber(annotation.scrollX) ||
    !isFiniteNumber(annotation.scrollY) ||
    !annotation.bbox ||
    !isFiniteNumber(annotation.bbox.x) ||
    !isFiniteNumber(annotation.bbox.y) ||
    !isFiniteNumber(annotation.bbox.width) ||
    !isFiniteNumber(annotation.bbox.height) ||
    !Array.isArray(annotation.strokes)
  ) {
    return null;
  }

  return {
    viewportWidth: annotation.viewportWidth,
    viewportHeight: annotation.viewportHeight,
    devicePixelRatio: annotation.devicePixelRatio,
    path: annotation.path,
    scrollX: annotation.scrollX,
    scrollY: annotation.scrollY,
    bbox: annotation.bbox,
    strokes: annotation.strokes
      .map((stroke) => ({
        id: typeof stroke.id === "string" ? stroke.id : crypto.randomUUID(),
        ...(isFiniteNumber(stroke.startMs) ? { startMs: stroke.startMs } : {}),
        ...(isFiniteNumber(stroke.endMs) ? { endMs: stroke.endMs } : {}),
        points: Array.isArray(stroke.points)
          ? stroke.points
              .filter((point) => isFiniteNumber(point.x) && isFiniteNumber(point.y))
              .map((point) => ({
                x: point.x,
                y: point.y,
                ...(isFiniteNumber(point.tMs) ? { tMs: point.tMs } : {})
              }))
          : []
      }))
      .filter((stroke) => stroke.points.length > 0)
  };
}

function parseTranscriptTokens(value: unknown): TranscriptToken[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const tokens = value
    .map((token, index) => {
      if (!token || typeof token !== "object") {
        return null;
      }
      const entry = token as TranscriptToken;
      if (
        typeof entry.text !== "string" ||
        !isFiniteNumber(entry.startMs) ||
        !isFiniteNumber(entry.endMs)
      ) {
        return null;
      }

      const parsed: TranscriptToken = {
        id: typeof entry.id === "string" && entry.id ? entry.id : `edit-token-${index + 1}`,
        text: entry.text.slice(0, 120),
        startMs: entry.startMs,
        endMs: Math.max(entry.startMs + 1, entry.endMs),
        granularity: entry.granularity === "char" || entry.granularity === "punctuation" ? entry.granularity : "word",
        lang: typeof entry.lang === "string" ? entry.lang.slice(0, 24) : "unknown",
        approximate: Boolean(entry.approximate)
      };
      if (isFiniteNumber(entry.confidence)) {
        parsed.confidence = entry.confidence;
      }
      return parsed;
    })
    .filter((token): token is TranscriptToken => Boolean(token));

  return tokens.length ? tokens.slice(0, 400) : null;
}

function parseDomCandidates(value: unknown): WebsiteEditDomCandidate[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((candidate, index) => {
      if (!candidate || typeof candidate !== "object") {
        return null;
      }
      const entry = candidate as WebsiteEditDomCandidate;
      if (
        typeof entry.selector !== "string" ||
        typeof entry.tagName !== "string" ||
        !entry.rect ||
        !isFiniteNumber(entry.rect.x) ||
        !isFiniteNumber(entry.rect.y) ||
        !isFiniteNumber(entry.rect.width) ||
        !isFiniteNumber(entry.rect.height)
      ) {
        return null;
      }

      const imageSrcs = Array.isArray(entry.imageSrcs)
        ? entry.imageSrcs.filter((src): src is string => typeof src === "string" && src.length > 0).slice(0, 4)
        : [];
      const imageAlts = Array.isArray(entry.imageAlts)
        ? entry.imageAlts.filter((alt): alt is string => typeof alt === "string" && alt.length > 0).slice(0, 4)
        : [];

      return {
        id: typeof entry.id === "string" && entry.id ? entry.id : `candidate-${index + 1}`,
        selector: entry.selector,
        tagName: entry.tagName,
        role: typeof entry.role === "string" ? entry.role : null,
        text: typeof entry.text === "string" ? entry.text.slice(0, 260) : null,
        ariaLabel: typeof entry.ariaLabel === "string" ? entry.ariaLabel.slice(0, 180) : null,
        className: typeof entry.className === "string" ? entry.className.slice(0, 240) : null,
        ...(imageSrcs.length ? { imageSrcs } : {}),
        ...(imageAlts.length ? { imageAlts } : {}),
        rect: entry.rect
      };
    })
    .filter((candidate): candidate is WebsiteEditDomCandidate => Boolean(candidate))
    .slice(0, 220);
}

function parseAnnotatedScreenshot(value: unknown) {
  if (typeof value !== "string" || !value) {
    return null;
  }

  const match = value.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    return null;
  }

  const mimeType = match[1];
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > 6 * 1024 * 1024) {
    return null;
  }

  return {
    buffer,
    mimeType,
    fileName: mimeType === "image/jpeg" ? "annotated-screenshot.jpg" : mimeType === "image/webp" ? "annotated-screenshot.webp" : "annotated-screenshot.png"
  };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string; jobId: string }> }
) {
  const { sessionId, jobId } = await params;
  const { viewer, response } = await requireApiViewer(`/sessions/${sessionId}/websites/${jobId}`);
  if (response) {
    return response;
  }

  const session = await getSessionDetail(sessionId, viewer?.id);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const parentJob = await getWebsiteJob(sessionId, jobId);
  if (!parentJob) {
    return NextResponse.json({ error: "Website job not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const annotation = parseAnnotation(body?.annotation);
  if (!annotation) {
    return NextResponse.json({ error: "Valid annotation is required." }, { status: 400 });
  }

  const instructionText = typeof body?.instructionText === "string" ? body.instructionText : "";
  const domCandidates = parseDomCandidates(body?.domCandidates);
  const transcriptTokens = parseTranscriptTokens(body?.transcriptTokens);
  const annotatedScreenshot = parseAnnotatedScreenshot(body?.annotatedScreenshotDataUrl);

  try {
    const job = await startWebsiteEditJob({
      sessionId,
      parentJobId: jobId,
      instructionText,
      annotation,
      domCandidates,
      transcriptTokens,
      visualReferenceImage: annotatedScreenshot
    });
    return NextResponse.json(job, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start website edit.";
    return NextResponse.json({ error: message }, { status: getWebsiteEditErrorStatus(message) });
  }
}
