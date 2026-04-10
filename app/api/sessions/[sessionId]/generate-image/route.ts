import {
  getSessionAsset,
  getSessionDetail,
  saveSessionAsset,
  updateSessionPreferences
} from "@/lib/session-store";
import { generateImageFromSketch } from "@/lib/scene-analysis";
import { ImageGenerationSource, ImageSizePreset } from "@/lib/types";
import { NextResponse } from "next/server";

function parseImageSizePreset(value: unknown): ImageSizePreset | undefined {
  return value === "small" || value === "medium" || value === "large" ? value : undefined;
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
  const requestedImageSize = parseImageSizePreset(body?.imageSizePreset);
  if (requestedImageSize) {
    await updateSessionPreferences(sessionId, {
      imageSizePreset: requestedImageSize
    });
  }
  const session = await getSessionDetail(sessionId);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  if (!session.analysis) {
    return NextResponse.json({ error: "Run analysis before image generation." }, { status: 409 });
  }

  const sourceAssetKind = source === "labeled" ? "annotatedSketch" : "sketch";
  const sourceSketch = await getSessionAsset(sessionId, sourceAssetKind);
  if (!sourceSketch) {
    return NextResponse.json(
      {
        error:
          source === "labeled"
            ? "Annotated sketch is missing."
            : "Plain sketch is missing."
      },
      { status: 409 }
    );
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "OPENAI_API_KEY is not configured." }, { status: 500 });
  }

  try {
    const image = await generateImageFromSketch({
      prompt: session.analysis.generationPrompt,
      sketchImage: sourceSketch.buffer,
      apiKey,
      width: session.canvasWidth,
      height: session.canvasHeight,
      source,
      imageSizePreset: session.imageSizePreset
    });

    await saveSessionAsset(
      sessionId,
      source === "labeled" ? "generatedImageLabeled" : "generatedImagePlain",
      image.buffer
    );
    const updatedSession = await getSessionDetail(sessionId);
    return NextResponse.json(updatedSession);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Image generation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
