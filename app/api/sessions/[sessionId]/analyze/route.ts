import {
  getSessionAsset,
  getSessionDetail,
  saveSessionAnalysis,
  saveSessionAsset,
  updateSessionPreferences
} from "@/lib/session-store";
import {
  extractSceneFromTranscript,
  groundSceneExtraction,
  renderAnnotatedSketchPng,
  renderSketchPng
} from "@/lib/scene-analysis";
import { buildDisplayTranscript } from "@/lib/transcript-format";
import { AnalysisReasoningEffort } from "@/lib/types";
import { NextResponse } from "next/server";

function parseReasoningEffort(value: unknown): AnalysisReasoningEffort | undefined {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const body = await request.json().catch(() => ({}));
  const requestedEffort = parseReasoningEffort(body?.reasoningEffort);
  if (requestedEffort) {
    await updateSessionPreferences(sessionId, {
      analysisReasoningEffort: requestedEffort
    });
  }

  const session = await getSessionDetail(sessionId);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  if (session.transcript.length === 0) {
    return NextResponse.json({ error: "Transcript is required before analysis." }, { status: 409 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "OPENAI_API_KEY is not configured." }, { status: 500 });
  }

  try {
    const transcriptText = buildDisplayTranscript(session.transcript);
    const extraction = await extractSceneFromTranscript(
      transcriptText,
      apiKey,
      session.analysisReasoningEffort
    );

    const groundedAnalysis = groundSceneExtraction({
      transcript: session.transcript,
      events: session.events,
      extractionModel: extraction.model,
      extraction: extraction.parsed
    });

    const existingSketch = await getSessionAsset(sessionId, "sketch");
    const sketchBuffer =
      existingSketch?.buffer ??
      (await renderSketchPng({
        events: session.events,
        width: session.canvasWidth,
        height: session.canvasHeight
      }));

    if (!existingSketch) {
      await saveSessionAsset(sessionId, "sketch", sketchBuffer);
    }

    const annotatedSketch = await renderAnnotatedSketchPng({
      baseSketch: sketchBuffer,
      analysis: groundedAnalysis,
      canvasWidth: session.canvasWidth,
      canvasHeight: session.canvasHeight
    });

    await saveSessionAnalysis(sessionId, groundedAnalysis);
    await saveSessionAsset(sessionId, "annotatedSketch", annotatedSketch);

    const updatedSession = await getSessionDetail(sessionId);
    return NextResponse.json(updatedSession);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Scene analysis failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
