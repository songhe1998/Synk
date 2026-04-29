import { getV0ApiKeySetupError } from "@/lib/v0-config";

const REQUIRED_WEBSITE_ENV_KEYS = [
  "OPENAI_API_KEY",
  "VERCEL_TEAM_ID",
  "VERCEL_PROJECT_ID",
  "VERCEL_TOKEN"
] as const;

export function getMissingWebsiteConfigKeys() {
  return REQUIRED_WEBSITE_ENV_KEYS.filter((key) => !process.env[key]?.trim());
}

export function hasWebsiteSandboxConfig() {
  return getMissingWebsiteConfigKeys().length === 0 && getV0ApiKeySetupError() === null;
}

export function getWebsiteSandboxSetupMessage() {
  const missingKeys = getMissingWebsiteConfigKeys();
  const v0SetupError = getV0ApiKeySetupError();
  if (missingKeys.length === 0 && !v0SetupError) {
    return null;
  }
  if (missingKeys.length === 0 && v0SetupError) {
    return v0SetupError;
  }
  const suffix = v0SetupError ? ` ${v0SetupError}` : "";
  return `Website generation is not configured yet. Missing ${missingKeys.join(
    ", "
  )}. Add the missing value${missingKeys.length === 1 ? "" : "s"}, then restart the dev server.${suffix}`;
}

export function requireWebsiteSandboxConfig() {
  const setupMessage = getWebsiteSandboxSetupMessage();
  if (setupMessage) {
    throw new Error(setupMessage);
  }
}
