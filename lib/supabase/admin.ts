import { createClient } from "@supabase/supabase-js";
import { getSupabaseServiceRoleKey, getSupabaseUrl, hasSupabaseAdminConfig } from "@/lib/supabase/config";

let adminClient: ReturnType<typeof createClient<any>> | null = null;

export function getSupabaseAdminClient() {
  if (!hasSupabaseAdminConfig()) {
    throw new Error("Supabase admin access is not configured.");
  }

  if (!adminClient) {
    adminClient = createClient(getSupabaseUrl(), getSupabaseServiceRoleKey(), {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });
  }

  return adminClient;
}
