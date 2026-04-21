import { requireApiViewer } from "@/lib/auth-route";
import { getSessionDetail } from "@/lib/session-store";
import { getWebsitePreviewFile } from "@/lib/website-store";
import { normalizeWebsitePreviewAssetPath } from "@/lib/website-artifacts";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string; jobId: string; assetPath: string[] }> }
) {
  const { sessionId, jobId, assetPath } = await params;
  const { viewer, response } = await requireApiViewer(`/sessions/${sessionId}/websites/${jobId}`);
  if (response) {
    return response;
  }

  if (!(await getSessionDetail(sessionId, viewer?.id))) {
    return new Response("Session not found", { status: 404 });
  }

  const normalizedAssetPath = normalizeWebsitePreviewAssetPath(assetPath);
  if (!normalizedAssetPath) {
    return new Response("Asset not found", { status: 404 });
  }

  const asset = await getWebsitePreviewFile(sessionId, jobId, normalizedAssetPath);
  if (!asset) {
    return new Response("Preview asset not found", { status: 404 });
  }

  return new Response(asset.buffer, {
    headers: {
      "Content-Type": asset.mimeType,
      "Content-Disposition": `inline; filename="${asset.fileName}"`,
      "Cache-Control": "no-store"
    }
  });
}
