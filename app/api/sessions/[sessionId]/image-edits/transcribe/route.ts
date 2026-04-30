import { requireApiViewer } from "@/lib/auth-route";
import { getSessionDetail } from "@/lib/session-store";
import { buildDisplayTranscript } from "@/lib/transcript-format";
import { transcribeAudio } from "@/lib/transcript";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function parseDurationMs(value: unknown) {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function extensionFromMimeType(mimeType: string) {
  if (mimeType.includes("mp4") || mimeType.includes("aac")) {
    return "m4a";
  }
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) {
    return "mp3";
  }
  if (mimeType.includes("wav")) {
    return "wav";
  }
  return "webm";
}

function getTranscriptionErrorStatus(message: string) {
  if (/not configured/i.test(message)) {
    return 503;
  }
  if (/not found/i.test(message)) {
    return 404;
  }
  if (/missing|audio/i.test(message)) {
    return 400;
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

  const session = await getSessionDetail(sessionId, viewer?.id);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const formData = await request.formData();
  const audioFile = formData.get("audio");
  if (!(audioFile instanceof File)) {
    return NextResponse.json({ error: "Missing audio file" }, { status: 400 });
  }

  const durationMs = parseDurationMs(formData.get("durationMs"));
  const mimeType = audioFile.type || "audio/webm";
  const fileName = audioFile.name || `image-edit-voice.${extensionFromMimeType(mimeType)}`;
  const audioBuffer = Buffer.from(await audioFile.arrayBuffer());

  if (!audioBuffer.length) {
    return NextResponse.json({ error: "Missing audio data" }, { status: 400 });
  }

  try {
    const transcript = await transcribeAudio({
      audioBuffer,
      mimeType,
      fileName,
      durationMs
    });

    return NextResponse.json({
      text: buildDisplayTranscript(transcript.tokens),
      transcriptTokens: transcript.tokens,
      transcriptApproximate: transcript.approximate
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to transcribe the image edit request.";
    return NextResponse.json({ error: message }, { status: getTranscriptionErrorStatus(message) });
  }
}
