import { requireApiViewer } from "@/lib/auth-route";
import { getSessionDetail } from "@/lib/session-store";
import { syncWorldGenerationJob } from "@/lib/world-pipeline";
import { getWorldJob } from "@/lib/world-store";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string; jobId: string }> }
) {
  const { sessionId, jobId } = await params;
  const { viewer, response } = await requireApiViewer(`/sessions/${sessionId}/worlds/${jobId}`);
  if (response) {
    return response;
  }

  const session = await getSessionDetail(sessionId, viewer?.id);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const existingJob = await getWorldJob(sessionId, jobId);
  if (!existingJob) {
    return NextResponse.json({ error: "World job not found" }, { status: 404 });
  }

  try {
    const job = await syncWorldGenerationJob(sessionId, jobId);
    return NextResponse.json(job);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to refresh world job.",
        job: existingJob
      },
      { status: 502 }
    );
  }
}
