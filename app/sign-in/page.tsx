import type { Route } from "next";
import { SignInShell } from "@/components/sign-in-shell";
import { getOptionalViewer, isAuthEnabled } from "@/lib/auth";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const params = await searchParams;
  const viewer = await getOptionalViewer();
  const nextPath = typeof params.next === "string" && params.next.startsWith("/") ? params.next : "/dashboard";

  if (viewer) {
    redirect(nextPath as Route);
  }

  return <SignInShell nextPath={nextPath} authEnabled={isAuthEnabled()} />;
}
