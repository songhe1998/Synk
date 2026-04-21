import { requireApiViewer } from "@/lib/auth-route";
import { getSessionDetail } from "@/lib/session-store";
import { startWorldGenerationJob } from "@/lib/world-pipeline";
import { WorldModelPreset, WorldSourceAssetKind } from "@/lib/types";
import { listWorldJobs } from "@/lib/world-store";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function parseModelPreset(value: unknown): WorldModelPreset {
  return value === "draft" ? "draft" : "hd";
}

function parseSourceAssetKind(value: unknown): WorldSourceAssetKind | undefined {
  return value === "generatedImageLabeled" || value === "generatedImagePlain" ? value : undefined;
}

function getWorldStartErrorStatus(message: string) {
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
  const { viewer, response } = await requireApiViewer(`/sessions/${sessionId}`);
  if (response) {
    return response;
  }

  const session = await getSessionDetail(sessionId, viewer?.id);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  return NextResponse.json(await listWorldJobs(sessionId));
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

  const session = await getSessionDetail(sessionId, viewer?.id);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));

  try {
    const job = await startWorldGenerationJob({
      sessionId,
      modelPreset: parseModelPreset(body?.modelPreset),
      sourceAssetKind: parseSourceAssetKind(body?.sourceAssetKind)
    });

    if (job.status === "failed") {
      return NextResponse.json(
        {
          error: job.errorMessage ?? "Failed to start world generation.",
          job
        },
        { status: 500 }
      );
    }

    return NextResponse.json(job, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start world generation.";
    return NextResponse.json({ error: message }, { status: getWorldStartErrorStatus(message) });
  }
}
