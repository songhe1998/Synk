import type { User } from "@supabase/supabase-js";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { hasSupabaseAdminConfig } from "@/lib/supabase/config";
import { normalizeSupabaseError } from "@/lib/supabase/errors";

export async function ensureUserProfile(user: User) {
  if (!hasSupabaseAdminConfig()) {
    return;
  }

  const admin = getSupabaseAdminClient();
  const { error } = await admin.from("profiles").upsert(
    {
      id: user.id,
      email: user.email ?? null,
      display_name: user.user_metadata?.full_name ?? user.user_metadata?.name ?? null,
      avatar_url: user.user_metadata?.avatar_url ?? null
    },
    { onConflict: "id" }
  );

  if (error) {
    throw normalizeSupabaseError(error);
  }
}
