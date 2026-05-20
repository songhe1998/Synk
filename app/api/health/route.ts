import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "skratch-demo",
    timestamp: new Date().toISOString()
  });
}
