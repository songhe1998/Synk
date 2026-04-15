import { VideoJobShell } from "@/components/video-job-shell";
import { syncVideoGenerationJob } from "@/lib/video-pipeline";
import { getSessionDetail } from "@/lib/session-store";
import { getVideoJob } from "@/lib/video-store";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function SessionVideoJobPage({
  params
}: {
  params: Promise<{ sessionId: string; jobId: string }>;
}) {
  const { sessionId, jobId } = await params;
  const session = await getSessionDetail(sessionId);
  const existingJob = await getVideoJob(sessionId, jobId);

  if (!session || !existingJob) {
    notFound();
  }

  const job =
    existingJob.status === "failed" || (existingJob.status === "succeeded" && existingJob.videoUrl)
      ? existingJob
      : await syncVideoGenerationJob(sessionId, jobId).catch(() => existingJob);

  return <VideoJobShell session={session} initialJob={job} />;
}
