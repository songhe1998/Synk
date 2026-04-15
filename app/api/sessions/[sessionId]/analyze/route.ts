import { ensureSessionAnalysis } from "@/lib/session-pipeline";
import { AnalysisReasoningEffort, ImageGenerationProfile } from "@/lib/types";
import { NextResponse } from "next/server";

function parseReasoningEffort(value: unknown): AnalysisReasoningEffort | undefined {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function parseImageGenerationProfile(value: unknown): ImageGenerationProfile | undefined {
  if (value === "fast") {
    return "fast";
  }
  if (value === "pro" || value === "quality") {
    return "pro";
  }
  return undefined;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const body = await request.json().catch(() => ({}));

  try {
    const updatedSession = await ensureSessionAnalysis({
      sessionId,
      reasoningEffort: parseReasoningEffort(body?.reasoningEffort),
      imageGenerationProfile: parseImageGenerationProfile(body?.imageGenerationProfile)
    });
    return NextResponse.json(updatedSession);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Scene analysis failed";
    return NextResponse.json(
      { error: message },
      { status: /session not found/i.test(message) ? 404 : /required/i.test(message) ? 409 : 500 }
    );
  }
}
