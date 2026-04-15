import { ensureSessionGeneratedImage } from "@/lib/session-pipeline";
import { ImageGenerationProfile, ImageGenerationSource, ImageSizePreset } from "@/lib/types";
import { NextResponse } from "next/server";

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

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const body = await request.json().catch(() => ({}));
  const source =
    body?.source === "plain" || body?.source === "labeled"
      ? (body.source as ImageGenerationSource)
      : "labeled";

  try {
    const updatedSession = await ensureSessionGeneratedImage({
      sessionId,
      source,
      imageSizePreset: parseImageSizePreset(body?.imageSizePreset),
      imageGenerationProfile: parseImageGenerationProfile(body?.imageGenerationProfile)
    });
    return NextResponse.json(updatedSession);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Image generation failed";
    return NextResponse.json(
      { error: message },
      { status: /session not found/i.test(message) ? 404 : /required|missing/i.test(message) ? 409 : 500 }
    );
  }
}
