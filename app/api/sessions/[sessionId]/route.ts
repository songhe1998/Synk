import { getOptionalViewer } from "@/lib/auth";
import { requireApiViewer } from "@/lib/auth-route";
import { deleteSession, getReadableSessionDetail, getSessionDetail } from "@/lib/session-store";
import { NextResponse } from "next/server";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const viewer = await getOptionalViewer();

  const session = await getReadableSessionDetail(sessionId, viewer?.id);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  return NextResponse.json(session);
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const { viewer, response } = await requireApiViewer(`/sessions/${sessionId}`);
  if (response) {
    return response;
  }

  const session = await getSessionDetail(sessionId, viewer?.id);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  await deleteSession(sessionId, viewer?.id);
  return NextResponse.json({ ok: true });
}
