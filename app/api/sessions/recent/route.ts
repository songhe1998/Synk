import { listRecentSessions } from "@/lib/session-store";
import { NextResponse } from "next/server";

export async function GET() {
  const sessions = await listRecentSessions();
  return NextResponse.json(sessions);
}
