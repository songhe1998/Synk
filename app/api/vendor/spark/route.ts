import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

let sparkBundleCache: string | null = null;

export async function GET() {
  if (!sparkBundleCache) {
    const bundlePath = path.join(process.cwd(), "node_modules", "@sparkjsdev", "spark", "dist", "spark.cjs.js");
    sparkBundleCache = await fs.readFile(bundlePath, "utf8");
  }

  return new NextResponse(sparkBundleCache, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=3600"
    }
  });
}
