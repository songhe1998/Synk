import { getOptionalViewer } from "@/lib/auth";
import { getReadableSessionDetail, getReadableSessionImageEditAsset } from "@/lib/session-store";

function parseAssetName(value: string): "image" | "annotation" | null {
  return value === "image" || value === "annotation" ? value : null;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string; editId: string; assetName: string }> }
) {
  const { sessionId, editId, assetName } = await params;
  const viewer = await getOptionalViewer();

  if (!(await getReadableSessionDetail(sessionId, viewer?.id))) {
    return new Response("Session not found", { status: 404 });
  }

  const parsedAssetName = parseAssetName(assetName);
  if (!parsedAssetName) {
    return new Response("Unknown image edit asset", { status: 404 });
  }

  const asset = await getReadableSessionImageEditAsset(sessionId, editId, parsedAssetName, viewer?.id);
  if (!asset) {
    return new Response("Image edit asset not found", { status: 404 });
  }

  const fileName = asset.fileName.split("/").pop() || asset.fileName;
  return new Response(asset.buffer, {
    headers: {
      "Content-Type": asset.mimeType,
      "Content-Disposition": `inline; filename="${fileName}"`,
      "Cache-Control": "private, max-age=31536000, immutable"
    }
  });
}
