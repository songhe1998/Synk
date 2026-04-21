import { requireApiViewer } from "@/lib/auth-route";
import { getSessionDetail } from "@/lib/session-store";
import { getVideoJobAsset } from "@/lib/video-store";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sessionId: string; jobId: string }> }
) {
  const { sessionId, jobId } = await params;
  const { viewer, response } = await requireApiViewer(`/sessions/${sessionId}/videos/${jobId}`);
  if (response) {
    return response;
  }

  if (!(await getSessionDetail(sessionId, viewer?.id))) {
    return new Response("Session not found", { status: 404 });
  }

  const asset = await getVideoJobAsset(sessionId, jobId);
  if (!asset) {
    return new Response("Video not found", { status: 404 });
  }

  const totalSize = asset.buffer.byteLength;
  const rangeHeader = request.headers.get("range");
  const baseHeaders = {
    "Content-Type": asset.mimeType,
    "Content-Disposition": `inline; filename="${asset.fileName}"`,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store"
  };

  if (!rangeHeader) {
    return new Response(asset.buffer, {
      status: 200,
      headers: {
        ...baseHeaders,
        "Content-Length": String(totalSize)
      }
    });
  }

  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match) {
    return new Response("Invalid range", {
      status: 416,
      headers: {
        ...baseHeaders,
        "Content-Range": `bytes */${totalSize}`
      }
    });
  }

  const [, rawStart, rawEnd] = match;
  let start = rawStart ? Number.parseInt(rawStart, 10) : Number.NaN;
  let end = rawEnd ? Number.parseInt(rawEnd, 10) : Number.NaN;

  if (Number.isNaN(start)) {
    const suffixLength = Number.isNaN(end) ? totalSize : end;
    start = Math.max(totalSize - suffixLength, 0);
    end = totalSize - 1;
  } else if (Number.isNaN(end)) {
    end = totalSize - 1;
  }

  if (start < 0 || end < start || start >= totalSize) {
    return new Response("Requested range not satisfiable", {
      status: 416,
      headers: {
        ...baseHeaders,
        "Content-Range": `bytes */${totalSize}`
      }
    });
  }

  const clampedEnd = Math.min(end, totalSize - 1);
  const chunk = asset.buffer.subarray(start, clampedEnd + 1);

  return new Response(chunk, {
    status: 206,
    headers: {
      ...baseHeaders,
      "Content-Length": String(chunk.byteLength),
      "Content-Range": `bytes ${start}-${clampedEnd}/${totalSize}`
    }
  });
}
