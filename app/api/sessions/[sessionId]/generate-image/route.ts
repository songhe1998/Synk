import { requireApiViewer } from "@/lib/auth-route";
import { getSessionDetail } from "@/lib/session-store";
import { ensureSessionGeneratedImage } from "@/lib/session-pipeline";
import {
  ImageFollowMode,
  ImageGenerationProfile,
  ImageGenerationSource,
  ImageSizePreset
} from "@/lib/types";
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

function parseImageFollowMode(value: unknown): ImageFollowMode | undefined {
  return value === "auto" || value === "loose" || value === "close" ? value : undefined;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const { viewer, response } = await requireApiViewer(`/sessions/${sessionId}`);
  if (response) {
    return response;
  }

  if (!(await getSessionDetail(sessionId, viewer?.id))) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

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
      imageGenerationProfile: parseImageGenerationProfile(body?.imageGenerationProfile),
      imageFollowMode: parseImageFollowMode(body?.imageFollowMode),
      force: true
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
