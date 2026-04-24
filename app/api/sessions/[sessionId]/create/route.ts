import { requireApiViewer } from "@/lib/auth-route";
import { getSessionDetail } from "@/lib/session-store";
import { createImageExperience, refreshSessionDetail } from "@/lib/session-pipeline";
import { startVideoGenerationJob } from "@/lib/video-pipeline";
import { startWebsiteGenerationJob } from "@/lib/website-pipeline";
import { startWorldGenerationJob } from "@/lib/world-pipeline";
import {
  AnalysisReasoningEffort,
  ImageFollowMode,
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

function parseImageFollowMode(value: unknown): ImageFollowMode | undefined {
  return value === "auto" || value === "loose" || value === "close" ? value : undefined;
}

function parseTarget(value: unknown) {
  return value === "world" || value === "video" || value === "website" ? value : "image";
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
  const { viewer, response } = await requireApiViewer(`/sessions/${sessionId}`);
  if (response) {
    return response;
  }

  if (!(await getSessionDetail(sessionId, viewer?.id))) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const target = parseTarget(body?.target);
  const reasoningEffort = parseReasoningEffort(body?.reasoningEffort);
  const imageSizePreset = parseImageSizePreset(body?.imageSizePreset);
  const imageGenerationProfile = parseImageGenerationProfile(body?.imageGenerationProfile);
  const imageFollowMode = parseImageFollowMode(body?.imageFollowMode);
  const videoModelPreset = parseVideoModelPreset(body?.videoModelPreset);
  const videoPipelineMode = parseVideoPipelineMode(body?.videoPipelineMode);

  try {
    if (target === "image") {
      const session = await createImageExperience({
        sessionId,
        reasoningEffort,
        imageSizePreset,
        imageGenerationProfile,
        imageFollowMode
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
            imageGenerationProfile,
            imageFollowMode
          })
        : null;

    const job =
      target === "world"
        ? await startWorldGenerationJob({
            sessionId,
            modelPreset: "hd",
            sourceAssetKind: "generatedImageLabeled"
          })
        : target === "website"
          ? await startWebsiteGenerationJob({
              sessionId
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
            (target === "world"
              ? "Failed to start 3D world generation."
              : target === "website"
                ? "Failed to start website generation."
                : "Failed to start video generation."),
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
