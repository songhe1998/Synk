import { getOptionalViewer } from "@/lib/auth";
import { buildGalleryItemFromSession, buildPlaceholderGalleryItem } from "@/lib/recorder-gallery";
import { getReadableSessionDetail, listGallerySessions } from "@/lib/session-store";
import { normalizeSupabaseError } from "@/lib/supabase/errors";
import { NextResponse } from "next/server";

export async function GET() {
  const viewer = await getOptionalViewer();

  try {
    const sessions = await listGallerySessions(viewer?.id);
    const galleryItems = await Promise.all(
      sessions.map(async (summary) => {
        const detail = await getReadableSessionDetail(summary.id, viewer?.id);
        if (!detail) {
          return buildPlaceholderGalleryItem(summary);
        }

        return buildGalleryItemFromSession(detail, buildPlaceholderGalleryItem(summary).target);
      })
    );
    return NextResponse.json(galleryItems);
  } catch (error) {
    const nextError = normalizeSupabaseError(error);
    return NextResponse.json({ error: nextError.message }, { status: 503 });
  }
}
