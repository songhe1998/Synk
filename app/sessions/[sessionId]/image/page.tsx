import { ImageExperienceShell } from "@/components/image-experience-shell";
import { getSessionDetail } from "@/lib/session-store";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function SessionImagePage({
  params
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const session = await getSessionDetail(sessionId);

  if (!session) {
    notFound();
  }

  return <ImageExperienceShell session={session} />;
}
