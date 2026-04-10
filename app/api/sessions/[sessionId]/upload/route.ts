import { saveSessionUpload } from "@/lib/session-store";
import { DrawingEvent } from "@/lib/types";
import { NextResponse } from "next/server";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const formData = await request.formData();

  const audioFile = formData.get("audio");
  const sketchFile = formData.get("sketch");
  const rawEvents = formData.get("events");
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
  const audioMimeType = audioFile.type || "audio/webm";
  const extension = audioFile.name.includes(".") ? audioFile.name.split(".").pop() || "webm" : "webm";

  const session = await saveSessionUpload(sessionId, {
    audioBuffer,
    audioMimeType,
    audioExtension: extension,
    events,
    canvasWidth,
    canvasHeight,
    durationMs: Number.isFinite(durationMs) ? durationMs : 0,
    sketchBuffer
  });

  return NextResponse.json(session);
}
