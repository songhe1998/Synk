import { createImageExperience, refreshSessionDetail } from "@/lib/session-pipeline";
import { startVideoGenerationJob } from "@/lib/video-pipeline";
import { startWorldGenerationJob } from "@/lib/world-pipeline";
import {
  AnalysisReasoningEffort,
  ImageGenerationProfile,
  ImageSizePreset,
  VideoModelPreset,
  VideoPipelineMode
} from "@/lib/types";
import { NextResponse } from "next/server";

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

function parseTarget(value: unknown) {
  return value === "world" || value === "video" ? value : "image";
}

function parseVideoModelPreset(value: unknown): VideoModelPreset {
  return value === "lite" ? "lite" : "quality";
}

function parseVideoPipelineMode(value: unknown): VideoPipelineMode {
  return value === "dynamic" ? "dynamic" : "normal";
}

function getStatusCode(message: string) {
  if (/not configured/i.test(message)) {
    return 503;
  }

  if (/session not found/i.test(message)) {
    return 404;
  }

  if (/required|missing|before/i.test(message)) {
    return 409;
  }

  return 500;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const body = await request.json().catch(() => ({}));
  const target = parseTarget(body?.target);
  const reasoningEffort = parseReasoningEffort(body?.reasoningEffort);
  const imageSizePreset = parseImageSizePreset(body?.imageSizePreset);
  const imageGenerationProfile = parseImageGenerationProfile(body?.imageGenerationProfile);
  const videoModelPreset = parseVideoModelPreset(body?.videoModelPreset);
  const videoPipelineMode = parseVideoPipelineMode(body?.videoPipelineMode);

  try {
    if (target === "image") {
      const session = await createImageExperience({
        sessionId,
        reasoningEffort,
        imageSizePreset,
        imageGenerationProfile
      });

      return NextResponse.json(
        {
          target,
          session
        },
        { status: 201 }
      );
    }

    const sessionForTarget =
      target === "world"
        ? await createImageExperience({
            sessionId,
            reasoningEffort,
            imageSizePreset,
            imageGenerationProfile
          })
        : null;

    const job =
      target === "world"
        ? await startWorldGenerationJob({
            sessionId,
            modelPreset: "hd",
            sourceAssetKind: "generatedImageLabeled"
          })
        : await startVideoGenerationJob({
            sessionId,
            modelPreset: videoModelPreset,
            pipelineMode: videoPipelineMode
          });

    if (job.status === "failed") {
      return NextResponse.json(
        {
          error:
            job.errorMessage ??
            (target === "world" ? "Failed to start 3D world generation." : "Failed to start video generation."),
          job
        },
        { status: 500 }
      );
    }

    const session = target === "world" ? sessionForTarget! : await refreshSessionDetail(sessionId);

    return NextResponse.json(
      {
        target,
        session,
        job
      },
      { status: 201 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create session output.";
    return NextResponse.json({ error: message }, { status: getStatusCode(message) });
  }
}
