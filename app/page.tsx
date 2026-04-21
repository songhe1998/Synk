import { RecorderShell } from "@/components/recorder-shell";
import { getOptionalViewer, getSignInHref, isAuthEnabled } from "@/lib/auth";
import { listGallerySessions } from "@/lib/session-store";
import { isSupabaseSchemaMissingError, getSupabaseSchemaSetupMessage } from "@/lib/supabase/errors";
import { getWebsiteSandboxSetupMessage, hasWebsiteSandboxConfig } from "@/lib/website-config";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const authEnabled = isAuthEnabled();
  const viewer = authEnabled ? await getOptionalViewer() : null;
  const websiteEnabled = hasWebsiteSandboxConfig();
  let sessions = [] as Awaited<ReturnType<typeof listGallerySessions>>;
  let setupMessage: string | null = null;

  try {
    sessions = await listGallerySessions(viewer?.id);
  } catch (error) {
    if (isSupabaseSchemaMissingError(error)) {
      setupMessage = getSupabaseSchemaSetupMessage();
    } else {
      throw error;
    }
  }

  return (
    <RecorderShell
      initialSessions={sessions}
      viewer={viewer}
      authEnabled={authEnabled}
      signInHref={getSignInHref("/")}
      setupMessage={setupMessage ?? (!websiteEnabled ? getWebsiteSandboxSetupMessage() : null)}
      websiteEnabled={websiteEnabled}
    />
  );
}
