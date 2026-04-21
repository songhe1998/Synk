"use client";

import { useEffect, useRef } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

export function useSupabaseAuthCompletion({
  authEnabled,
  redirectTarget,
  enabled = true,
  onStart,
  onError
}: {
  authEnabled: boolean;
  redirectTarget: string;
  enabled?: boolean;
  onStart?: () => void;
  onError?: (message: string) => void;
}) {
  const didCompleteAuthRef = useRef(false);
  const onStartRef = useRef(onStart);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onStartRef.current = onStart;
  }, [onStart]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    if (!authEnabled || !enabled) {
      return;
    }

    let cancelled = false;
    const supabase = getSupabaseBrowserClient();

    async function finalizeSignIn() {
      if (didCompleteAuthRef.current || cancelled) {
        return;
      }

      const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      const hashError = hashParams.get("error_description") ?? hashParams.get("error");
      if (hashError) {
        onErrorRef.current?.(hashError);
        return;
      }

      const accessToken = hashParams.get("access_token");
      const refreshToken = hashParams.get("refresh_token");
      if (accessToken && refreshToken) {
        const { error } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken
        });

        if (error) {
          onErrorRef.current?.(error.message);
          return;
        }

        window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      }

      const {
        data: { session }
      } = await supabase.auth.getSession();

      if (!session || didCompleteAuthRef.current || cancelled) {
        return;
      }

      didCompleteAuthRef.current = true;
      onStartRef.current?.();

      try {
        const response = await fetch("/api/auth/ensure-profile", { method: "POST" });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(typeof payload?.error === "string" ? payload.error : "Failed to finish sign-in.");
        }

        window.location.replace(redirectTarget || "/dashboard");
      } catch (error) {
        didCompleteAuthRef.current = false;
        onErrorRef.current?.(error instanceof Error ? error.message : "Failed to finish sign-in.");
      }
    }

    void finalizeSignIn();

    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) {
        void finalizeSignIn();
      }
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [authEnabled, enabled, redirectTarget]);
}
