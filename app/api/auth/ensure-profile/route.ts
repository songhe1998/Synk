import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isAuthEnabled } from "@/lib/auth";
import { ensureUserProfile } from "@/lib/supabase-profiles";
import { normalizeSupabaseError } from "@/lib/supabase/errors";

export async function POST() {
  if (!isAuthEnabled()) {
    return NextResponse.json({ error: "Authentication is not configured." }, { status: 503 });
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  try {
    await ensureUserProfile(user);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const nextError = normalizeSupabaseError(error);
    return NextResponse.json({ error: nextError.message }, { status: 503 });
  }
}
