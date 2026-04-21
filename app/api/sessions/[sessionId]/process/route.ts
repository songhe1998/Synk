import { requireApiViewer } from "@/lib/auth-route";
import {
  getSessionAudio,
  getSessionDetail,
  markSessionFailed,
  markSessionProcessing,
  saveSessionTranscript
} from "@/lib/session-store";
import { transcribeAudio } from "@/lib/transcript";
import { NextResponse } from "next/server";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const { viewer, response } = await requireApiViewer(`/sessions/${sessionId}`);
  if (response) {
    return response;
  }

  const session = await getSessionDetail(sessionId, viewer?.id);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  if (session.status === "created") {
    return NextResponse.json({ error: "Upload the session before processing it." }, { status: 409 });
  }

  const audio = await getSessionAudio(sessionId);
  if (!audio) {
    return NextResponse.json({ error: "Audio not found" }, { status: 400 });
  }

  await markSessionProcessing(sessionId);

  try {
    const transcript = await transcribeAudio({
      audioBuffer: audio.buffer,
      mimeType: audio.mimeType,
      fileName: audio.fileName,
      durationMs: session.durationMs
    });

    const saved = await saveSessionTranscript(sessionId, transcript.tokens, transcript.approximate);
    return NextResponse.json(saved);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Processing failed";
    await markSessionFailed(sessionId, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
