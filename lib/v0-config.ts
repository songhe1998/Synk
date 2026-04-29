export function getV0ApiKey() {
  return process.env.V0_API_KEY?.trim() || "";
}

export function getV0ApiKeySetupError() {
  const apiKey = getV0ApiKey();
  if (!apiKey) {
    return "V0_API_KEY is required for fast website generation.";
  }
  if (/^Bearer\s+/i.test(apiKey)) {
    return "V0_API_KEY should contain only the key value, without a Bearer prefix.";
  }
  if (apiKey.startsWith("v1:") && apiKey.split(":").length < 3) {
    return "V0_API_KEY appears truncated. Paste the full key from v0 settings, including the final vcp_ segment.";
  }
  return null;
}

export function hasV0ApiKeyConfig() {
  return getV0ApiKeySetupError() === null;
}
