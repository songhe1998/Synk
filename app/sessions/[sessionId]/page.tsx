import { PlaybackShell } from "@/components/playback-shell";
import { getSessionDetail } from "@/lib/session-store";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function SessionPage({
  params
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const session = await getSessionDetail(sessionId);

  if (!session) {
    notFound();
  }

  return <PlaybackShell session={session} />;
}
