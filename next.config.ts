import path from "path";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
import type { NextConfig } from "next";

export default function createNextConfig(phase: string): NextConfig {
  return {
    // Keep `next dev` artifacts isolated so ad-hoc `next build` runs cannot
    // invalidate the server bundle that the local dev server is still using.
    distDir: phase === PHASE_DEVELOPMENT_SERVER ? ".next-dev" : ".next",
    typedRoutes: true,
    outputFileTracingRoot: path.join(__dirname),
    experimental: {
      devtoolSegmentExplorer: false
    }
  };
}
