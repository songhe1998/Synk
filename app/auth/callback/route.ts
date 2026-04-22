import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isAuthEnabled } from "@/lib/auth";
import { ensureUserProfile } from "@/lib/supabase-profiles";
import { isSupabaseSchemaMissingError } from "@/lib/supabase/errors";
import { getPublicRequestOrigin } from "@/lib/request-origin";

function resolveNextPath(value: string | null) {
  return value && value.startsWith("/") ? value : "/dashboard";
}

export async function GET(request: Request) {
  const nextUrl = new URL(request.url);
  const requestOrigin = getPublicRequestOrigin(request);
  const nextPath = resolveNextPath(nextUrl.searchParams.get("next"));

  if (!isAuthEnabled()) {
    return NextResponse.redirect(new URL(nextPath, requestOrigin));
  }

  const code = nextUrl.searchParams.get("code");
  if (code) {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.exchangeCodeForSession(code);
    const {
      data: { user }
    } = await supabase.auth.getUser();
    if (user) {
      try {
        await ensureUserProfile(user);
      } catch (error) {
        if (!isSupabaseSchemaMissingError(error)) {
          throw error;
        }
      }
    }
  }

  return NextResponse.redirect(new URL(nextPath, requestOrigin));
}
