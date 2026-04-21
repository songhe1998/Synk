import { NextResponse } from "next/server";
import { getOptionalViewer, getSignInHref, isAuthEnabled } from "@/lib/auth";

export async function requireApiViewer(nextPath: string) {
  if (!isAuthEnabled()) {
    return {
      viewer: null,
      response: null
    };
  }

  const viewer = await getOptionalViewer();
  if (!viewer) {
    return {
      viewer: null,
      response: NextResponse.json(
        {
          error: "Sign in required",
          signInUrl: getSignInHref(nextPath)
        },
        { status: 401 }
      )
    };
  }

  return {
    viewer,
    response: null
  };
}
