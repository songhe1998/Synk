import { WorldJobShell } from "@/components/world-job-shell";
import { syncWorldGenerationJob } from "@/lib/world-pipeline";
import { getSessionDetail } from "@/lib/session-store";
import { getWorldJob } from "@/lib/world-store";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function SessionWorldJobPage({
  params
}: {
  params: Promise<{ sessionId: string; jobId: string }>;
}) {
  const { sessionId, jobId } = await params;
  const session = await getSessionDetail(sessionId);
  const existingJob = await getWorldJob(sessionId, jobId);

  if (!session || !existingJob) {
    notFound();
  }

  const job =
    existingJob.status === "failed" ||
    ((existingJob.status === "succeeded" || existingJob.status === "running") &&
      (existingJob.world?.spz100kUrl || existingJob.world?.spz500kUrl || existingJob.world?.spzFullResUrl))
      ? existingJob
      : await syncWorldGenerationJob(sessionId, jobId).catch(() => existingJob);

  return <WorldJobShell session={session} initialJob={job} />;
}
