import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isAuthEnabled } from "@/lib/auth";
import { getPublicRequestOrigin } from "@/lib/request-origin";

export async function POST(request: Request) {
  const requestOrigin = getPublicRequestOrigin(request);

  if (isAuthEnabled()) {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut();
  }

  return NextResponse.redirect(new URL("/", requestOrigin));
}
