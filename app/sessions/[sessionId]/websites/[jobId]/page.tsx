import { WebsiteJobShell } from "@/components/website-job-shell";
import { requireViewer } from "@/lib/auth";
import { getSessionDetail } from "@/lib/session-store";
import { syncWebsiteGenerationJob } from "@/lib/website-pipeline";
import { getWebsiteJob } from "@/lib/website-store";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function SessionWebsiteJobPage({
  params
}: {
  params: Promise<{ sessionId: string; jobId: string }>;
}) {
  const { sessionId, jobId } = await params;
  const viewer = await requireViewer(`/sessions/${sessionId}/websites/${jobId}`);
  const session = await getSessionDetail(sessionId, viewer?.id);
  const existingJob = await getWebsiteJob(sessionId, jobId);

  if (!session || !existingJob) {
    notFound();
  }

  const job =
    existingJob.status === "failed" || existingJob.status === "succeeded"
      ? existingJob
      : await syncWebsiteGenerationJob(sessionId, jobId).catch(() => existingJob);

  return <WebsiteJobShell session={session} initialJob={job} />;
}
