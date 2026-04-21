import { requireApiViewer } from "@/lib/auth-route";
import { getSessionDetail } from "@/lib/session-store";
import { getWebsiteJobArtifact } from "@/lib/website-store";
import { WebsiteArtifactKind } from "@/lib/types";

function parseArtifactKind(value: string | null): WebsiteArtifactKind | null {
  if (value === "previewImage" || value === "codeArchive" || value === "distArchive") {
    return value;
  }

  return null;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string; jobId: string }> }
) {
  const { sessionId, jobId } = await params;
  const { viewer, response } = await requireApiViewer(`/sessions/${sessionId}/websites/${jobId}`);
  if (response) {
    return response;
  }

  if (!(await getSessionDetail(sessionId, viewer?.id))) {
    return new Response("Session not found", { status: 404 });
  }

  const requestUrl = new URL(_request.url);
  const kind = parseArtifactKind(requestUrl.searchParams.get("kind"));
  if (!kind) {
    return new Response("Unknown website asset", { status: 404 });
  }

  const asset = await getWebsiteJobArtifact(sessionId, jobId, kind);
  if (!asset) {
    return new Response("Website asset not found", { status: 404 });
  }

  return new Response(asset.buffer, {
    headers: {
      "Content-Type": asset.mimeType,
      "Content-Disposition": `inline; filename="${asset.fileName}"`,
      "Cache-Control": "no-store"
    }
  });
}
