import { requireApiViewer } from "@/lib/auth-route";
import { getSessionDetail } from "@/lib/session-store";
import { restoreSessionImageFromReference } from "@/lib/session-pipeline";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function getErrorStatus(message: string) {
  if (/not configured/i.test(message)) {
    return 503;
  }
  if (/not found|missing/i.test(message)) {
    return 404;
  }
  if (/choose|required|before/i.test(message)) {
    return 409;
  }
  return 500;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const { viewer, response } = await requireApiViewer(`/sessions/${sessionId}/image`);
  if (response) {
    return response;
  }

  if (!(await getSessionDetail(sessionId, viewer?.id))) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const referenceRevisionNumber = Number(body?.referenceRevisionNumber);
  if (!Number.isFinite(referenceRevisionNumber) || referenceRevisionNumber < 0) {
    return NextResponse.json({ error: "A valid reference revision is required." }, { status: 400 });
  }

  try {
    const result = await restoreSessionImageFromReference({
      sessionId,
      referenceRevisionNumber: Math.floor(referenceRevisionNumber)
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Reference restore failed.";
    return NextResponse.json({ error: message }, { status: getErrorStatus(message) });
  }
}
