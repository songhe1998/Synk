import { getOptionalViewer } from "@/lib/auth";
import { getReadableSessionAsset, getReadableSessionDetail } from "@/lib/session-store";
import { AssetKind } from "@/lib/types";

function toAssetKind(assetName: string): AssetKind | null {
  switch (assetName) {
    case "sketch":
      return "sketch";
    case "annotatedSketch":
      return "annotatedSketch";
    case "videoAnnotatedSketch":
      return "videoAnnotatedSketch";
    case "generatedImage":
      return "generatedImage";
    case "generatedImageLabeled":
      return "generatedImageLabeled";
    case "generatedImagePlain":
      return "generatedImagePlain";
    case "generatedVideoSourceImage":
      return "generatedVideoSourceImage";
    default:
      return null;
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string; assetName: string }> }
) {
  const { sessionId, assetName } = await params;
  const viewer = await getOptionalViewer();

  if (!(await getReadableSessionDetail(sessionId, viewer?.id))) {
    return new Response("Session not found", { status: 404 });
  }

  const assetKind = toAssetKind(assetName);
  if (!assetKind) {
    return new Response("Unknown asset", { status: 404 });
  }

  const asset = await getReadableSessionAsset(sessionId, assetKind, viewer?.id);
  if (!asset) {
    return new Response("Asset not found", { status: 404 });
  }

  return new Response(asset.buffer, {
    headers: {
      "Content-Type": asset.mimeType,
      "Content-Disposition": `inline; filename="${asset.fileName}"`,
      "Cache-Control": "no-store"
    }
  });
}
