import { RecorderShell } from "@/components/recorder-shell";
import { listRecentSessions } from "@/lib/session-store";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const sessions = await listRecentSessions();
  return <RecorderShell initialSessions={sessions} />;
}
