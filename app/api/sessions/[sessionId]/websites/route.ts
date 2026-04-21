import { requireApiViewer } from "@/lib/auth-route";
import { getSessionDetail } from "@/lib/session-store";
import { startWebsiteGenerationJob, syncWebsiteGenerationJob } from "@/lib/website-pipeline";
import { getWebsiteJob, listWebsiteJobs } from "@/lib/website-store";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function getWebsiteStartErrorStatus(message: string) {
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
  const { viewer, response } = await requireApiViewer(`/sessions/${sessionId}`);
  if (response) {
    return response;
  }

  const session = await getSessionDetail(sessionId, viewer?.id);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const jobs = await listWebsiteJobs(sessionId);
  await Promise.allSettled(
    jobs
      .filter((job) => job.status !== "failed" && job.status !== "succeeded")
      .map((job) => syncWebsiteGenerationJob(sessionId, job.id))
  );

  return NextResponse.json(await listWebsiteJobs(sessionId));
}

export async function POST(
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

  try {
    const job = await startWebsiteGenerationJob({
      sessionId
    });

    if (job.status === "failed") {
      return NextResponse.json(
        {
          error: job.errorMessage ?? "Failed to start website generation.",
          job
        },
        { status: 500 }
      );
    }

    const nextJob = (await getWebsiteJob(sessionId, job.id)) ?? job;
    return NextResponse.json(nextJob, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start website generation.";
    return NextResponse.json({ error: message }, { status: getWebsiteStartErrorStatus(message) });
  }
}
