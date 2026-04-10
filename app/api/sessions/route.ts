import { createSession } from "@/lib/session-store";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const payload = await request.json().catch(() => ({}));
  const session = await createSession(typeof payload?.title === "string" ? payload.title : undefined);
  return NextResponse.json(session);
}
