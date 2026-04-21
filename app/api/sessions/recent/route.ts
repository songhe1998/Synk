import { getOptionalViewer } from "@/lib/auth";
import { listGallerySessions } from "@/lib/session-store";
import { normalizeSupabaseError } from "@/lib/supabase/errors";
import { NextResponse } from "next/server";

export async function GET() {
  const viewer = await getOptionalViewer();

  try {
    const sessions = await listGallerySessions(viewer?.id);
    return NextResponse.json(sessions);
  } catch (error) {
    const nextError = normalizeSupabaseError(error);
    return NextResponse.json({ error: nextError.message }, { status: 503 });
  }
}
