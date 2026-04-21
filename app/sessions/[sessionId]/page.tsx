import { PlaybackShell } from "@/components/playback-shell";
import { getOptionalViewer, isAuthEnabled, requireViewer } from "@/lib/auth";
import { getReadableSessionDetail } from "@/lib/session-store";
import { hasWebsiteSandboxConfig } from "@/lib/website-config";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function SessionPage({
  params
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const viewer = await getOptionalViewer();
  const websiteEnabled = hasWebsiteSandboxConfig();
  const session = await getReadableSessionDetail(sessionId, viewer?.id);

  if (!session) {
    if (isAuthEnabled() && !viewer) {
      await requireViewer(`/sessions/${sessionId}`);
    }
    notFound();
  }

  return <PlaybackShell session={session} websiteEnabled={websiteEnabled} />;
}
