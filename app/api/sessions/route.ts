import { requireApiViewer } from "@/lib/auth-route";
import { createSession } from "@/lib/session-store";
import { normalizeSupabaseError } from "@/lib/supabase/errors";
import { AnalysisReasoningEffort, ImageGenerationProfile, ImageSizePreset } from "@/lib/types";
import { NextRequest, NextResponse } from "next/server";

function parseReasoningEffort(value: unknown): AnalysisReasoningEffort | undefined {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function parseImageSizePreset(value: unknown): ImageSizePreset | undefined {
  return value === "small" || value === "medium" || value === "large" ? value : undefined;
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

export async function POST(request: NextRequest) {
  const { viewer, response } = await requireApiViewer("/");
  if (response) {
    return response;
  }

  const payload = await request.json().catch(() => ({}));

  try {
    const session = await createSession(
      typeof payload?.title === "string" ? payload.title : undefined,
      {
        analysisReasoningEffort: parseReasoningEffort(payload?.analysisReasoningEffort),
        imageSizePreset: parseImageSizePreset(payload?.imageSizePreset),
        imageGenerationProfile: parseImageGenerationProfile(payload?.imageGenerationProfile)
      },
      viewer?.id
    );
    return NextResponse.json(session);
  } catch (error) {
    const nextError = normalizeSupabaseError(error);
    return NextResponse.json({ error: nextError.message }, { status: 503 });
  }
}
