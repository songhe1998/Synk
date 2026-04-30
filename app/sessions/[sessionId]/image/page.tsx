import { ImageExperienceShell } from "@/components/image-experience-shell";
import { getOptionalViewer, isAuthEnabled, requireViewer } from "@/lib/auth";
import { getReadableSessionDetail, getSessionDetail } from "@/lib/session-store";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function SessionImagePage({
  params
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const viewer = await getOptionalViewer();
  const authEnabled = isAuthEnabled();
  const session = await getReadableSessionDetail(sessionId, viewer?.id);

  if (!session) {
    if (authEnabled && !viewer) {
      await requireViewer(`/sessions/${sessionId}/image`);
    }
    notFound();
  }

  const editableSession = authEnabled ? (viewer ? await getSessionDetail(sessionId, viewer.id) : null) : session;

  return <ImageExperienceShell session={session} canEditImage={Boolean(editableSession)} />;
}
