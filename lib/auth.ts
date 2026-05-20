import type { Route } from "next";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { hasSupabaseAdminConfig, isDemoModeEnabled } from "@/lib/supabase/config";

export interface Viewer {
  id: string;
  email: string | null;
}

function buildSignInHref(nextPath: string) {
  return `/sign-in?next=${encodeURIComponent(nextPath)}`;
}

export function isAuthEnabled() {
  return hasSupabaseAdminConfig() && !isDemoModeEnabled();
}

export async function getOptionalViewer(): Promise<Viewer | null> {
  if (!isAuthEnabled()) {
    return null;
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  return {
    id: user.id,
    email: user.email ?? null
  };
}

export async function requireViewer(nextPath: string) {
  if (!isAuthEnabled()) {
    return null;
  }

  const viewer = await getOptionalViewer();
  if (!viewer) {
    redirect(buildSignInHref(nextPath) as Route);
  }

  return viewer;
}

export function getSignInHref(nextPath = "/") {
  return buildSignInHref(nextPath);
}
