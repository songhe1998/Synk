import { createSession } from "@/lib/session-store";
import { AnalysisReasoningEffort, ImageSizePreset } from "@/lib/types";
import { NextRequest, NextResponse } from "next/server";

function parseReasoningEffort(value: unknown): AnalysisReasoningEffort | undefined {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function parseImageSizePreset(value: unknown): ImageSizePreset | undefined {
  return value === "small" || value === "medium" || value === "large" ? value : undefined;
}

export async function POST(request: NextRequest) {
  const payload = await request.json().catch(() => ({}));
  const session = await createSession(typeof payload?.title === "string" ? payload.title : undefined, {
    analysisReasoningEffort: parseReasoningEffort(payload?.analysisReasoningEffort),
    imageSizePreset: parseImageSizePreset(payload?.imageSizePreset)
  });
  return NextResponse.json(session);
}
