import { RecorderShell } from "@/components/recorder-shell";
import { getSignInHref, isAuthEnabled } from "@/lib/auth";
import { getWebsiteSandboxSetupMessage, hasWebsiteSandboxConfig } from "@/lib/website-config";

export const dynamic = "force-static";

export default async function HomePage() {
  const authEnabled = isAuthEnabled();
  const websiteEnabled = hasWebsiteSandboxConfig();

  return (
    <RecorderShell
      initialSessions={[]}
      viewer={null}
      authEnabled={authEnabled}
      signInHref={getSignInHref("/")}
      setupMessage={!websiteEnabled ? getWebsiteSandboxSetupMessage() : null}
      websiteEnabled={websiteEnabled}
    />
  );
}
