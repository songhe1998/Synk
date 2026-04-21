const WEBSITE_SANDBOX_SETUP_MESSAGE =
  "Website sandbox is not configured yet. Add VERCEL_TEAM_ID, VERCEL_PROJECT_ID, and VERCEL_TOKEN, then restart the dev server.";

export function hasWebsiteSandboxConfig() {
  return Boolean(
    process.env.VERCEL_TEAM_ID &&
      process.env.VERCEL_PROJECT_ID &&
      process.env.VERCEL_TOKEN
  );
}

export function getWebsiteSandboxSetupMessage() {
  return WEBSITE_SANDBOX_SETUP_MESSAGE;
}

export function requireWebsiteSandboxConfig() {
  if (!hasWebsiteSandboxConfig()) {
    throw new Error(WEBSITE_SANDBOX_SETUP_MESSAGE);
  }
}
