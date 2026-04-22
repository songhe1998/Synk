import { requireApiViewer } from "@/lib/auth-route";
import { getSessionDetail, markSessionFailed, saveSessionTranscript, saveSessionUpload } from "@/lib/session-store";
import { DrawingEvent, TranscriptToken } from "@/lib/types";
import { NextResponse } from "next/server";

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
