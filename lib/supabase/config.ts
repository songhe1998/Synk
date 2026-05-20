const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabasePublishableKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

function envFlag(value: string | undefined) {
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function isDemoModeEnabled() {
  return envFlag((process.env.SKRATCH_DEMO_MODE ?? process.env.NEXT_PUBLIC_SKRATCH_DEMO_MODE ?? "").toLowerCase());
}

export function hasSupabaseAuthConfig() {
  return Boolean(supabaseUrl && supabasePublishableKey);
}

export function hasSupabaseAdminConfig() {
  return hasSupabaseAuthConfig() && Boolean(supabaseServiceRoleKey);
}

export function shouldUseSupabaseSessionStore() {
  return hasSupabaseAdminConfig() && !isDemoModeEnabled();
}

export function getSupabaseUrl() {
  if (!supabaseUrl) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL is not configured.");
  }

  return supabaseUrl;
}

export function getSupabasePublishableKey() {
  if (!supabasePublishableKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is not configured.");
  }

  return supabasePublishableKey;
}

export function getSupabaseServiceRoleKey() {
  if (!supabaseServiceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured.");
  }

  return supabaseServiceRoleKey;
}

export function getSupabaseStorageBucket() {
  return process.env.SUPABASE_STORAGE_BUCKET || "session-assets";
}
