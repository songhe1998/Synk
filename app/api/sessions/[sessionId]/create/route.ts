import { createImageExperience } from "@/lib/session-pipeline";
import { startWorldGenerationJob } from "@/lib/world-pipeline";
import { AnalysisReasoningEffort, ImageSizePreset } from "@/lib/types";
import { NextResponse } from "next/server";

function parseReasoningEffort(value: unknown): AnalysisReasoningEffort | undefined {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function parseImageSizePreset(value: unknown): ImageSizePreset | undefined {
  return value === "small" || value === "medium" || value === "large" ? value : undefined;
}

function parseTarget(value: unknown) {
  return value === "world" ? "world" : "image";
}

function getStatusCode(message: string) {
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

  try {
    const session = await createImageExperience({
      sessionId,
      reasoningEffort,
      imageSizePreset
    });

    if (target === "image") {
      return NextResponse.json(
        {
          target,
          session
        },
        { status: 201 }
      );
    }

    const job = await startWorldGenerationJob({
      sessionId,
      modelPreset: "hd",
      sourceAssetKind: "generatedImageLabeled"
    });

    if (job.status === "failed") {
      return NextResponse.json(
        {
          error: job.errorMessage ?? "Failed to start 3D world generation.",
          job
        },
        { status: 500 }
      );
    }

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
