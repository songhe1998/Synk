import { getWebsiteJobArtifact } from "@/lib/website-store";
import { verifyV0WebsiteArtifactAttachmentToken } from "@/lib/v0-attachment-url";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const payload = verifyV0WebsiteArtifactAttachmentToken(token);
  if (!payload) {
    return new Response("Attachment not found", { status: 404 });
  }

  const artifact = await getWebsiteJobArtifact(payload.sessionId, payload.jobId, payload.artifactKind);
  if (!artifact) {
    return new Response("Attachment not found", { status: 404 });
  }

  return new Response(artifact.buffer, {
    headers: {
      "Content-Type": artifact.mimeType,
      "Content-Disposition": `inline; filename="${artifact.fileName}"`,
      "Cache-Control": "private, max-age=300"
    }
  });
}
