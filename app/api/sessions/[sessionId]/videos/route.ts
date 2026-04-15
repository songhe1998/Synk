import { getSessionDetail } from "@/lib/session-store";
import { startVideoGenerationJob } from "@/lib/video-pipeline";
import { VideoModelPreset, VideoPipelineMode } from "@/lib/types";
import { listVideoJobs } from "@/lib/video-store";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function parseModelPreset(value: unknown): VideoModelPreset {
  return value === "lite" ? "lite" : "quality";
}

function parsePipelineMode(value: unknown): VideoPipelineMode {
  return value === "dynamic" ? "dynamic" : "normal";
}

function getVideoStartErrorStatus(message: string) {
  if (/not configured/i.test(message)) {
    return 503;
  }

  if (/required|missing|before creating|session not found/i.test(message)) {
    return /session not found/i.test(message) ? 404 : 409;
  }

  return 500;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const session = await getSessionDetail(sessionId);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  return NextResponse.json(await listVideoJobs(sessionId));
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const session = await getSessionDetail(sessionId);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));

  try {
    const job = await startVideoGenerationJob({
      sessionId,
      modelPreset: parseModelPreset(body?.modelPreset),
      pipelineMode: parsePipelineMode(body?.pipelineMode)
    });

    if (job.status === "failed") {
      return NextResponse.json(
        {
          error: job.errorMessage ?? "Failed to start video generation.",
          job
        },
        { status: 500 }
      );
    }

    return NextResponse.json(job, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start video generation.";
    return NextResponse.json({ error: message }, { status: getVideoStartErrorStatus(message) });
  }
}
