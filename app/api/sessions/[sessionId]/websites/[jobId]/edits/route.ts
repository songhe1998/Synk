import { requireApiViewer } from "@/lib/auth-route";
import { getSessionDetail } from "@/lib/session-store";
import { startWebsiteEditJob } from "@/lib/website-pipeline";
import { getWebsiteJob } from "@/lib/website-store";
import { WebsiteEditAnnotation, WebsiteEditDomCandidate } from "@/lib/types";
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
        points: Array.isArray(stroke.points)
          ? stroke.points
              .filter((point) => isFiniteNumber(point.x) && isFiniteNumber(point.y))
              .map((point) => ({ x: point.x, y: point.y }))
          : []
      }))
      .filter((stroke) => stroke.points.length > 0)
  };
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

      return {
        id: typeof entry.id === "string" && entry.id ? entry.id : `candidate-${index + 1}`,
        selector: entry.selector,
        tagName: entry.tagName,
        role: typeof entry.role === "string" ? entry.role : null,
        text: typeof entry.text === "string" ? entry.text.slice(0, 260) : null,
        ariaLabel: typeof entry.ariaLabel === "string" ? entry.ariaLabel.slice(0, 180) : null,
        className: typeof entry.className === "string" ? entry.className.slice(0, 240) : null,
        rect: entry.rect
      };
    })
    .filter((candidate): candidate is WebsiteEditDomCandidate => Boolean(candidate))
    .slice(0, 220);
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

  try {
    const job = await startWebsiteEditJob({
      sessionId,
      parentJobId: jobId,
      instructionText,
      annotation,
      domCandidates
    });
    return NextResponse.json(job, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start website edit.";
    return NextResponse.json({ error: message }, { status: getWebsiteEditErrorStatus(message) });
  }
}
