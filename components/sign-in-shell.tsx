"use client";

import { FormEvent, useMemo, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { useSupabaseAuthCompletion } from "@/lib/use-supabase-auth-completion";

export function SignInShell({
  nextPath,
  authEnabled
}: {
  nextPath: string;
  authEnabled: boolean;
}) {
  const [email, setEmail] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState<"email" | "code" | "google" | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const redirectTarget = useMemo(() => {
    if (!nextPath.startsWith("/")) {
      return "/";
    }

    return nextPath;
  }, [nextPath]);

  useSupabaseAuthCompletion({
    authEnabled,
    redirectTarget,
    onStart: () => {
      setNotice("Finishing sign-in...");
      setErrorMessage(null);
    },
    onError: (message) => {
      setNotice(null);
      setErrorMessage(message);
    }
  });

  async function sendEmailCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("email");
    setErrorMessage(null);
    setNotice(null);

    try {
      const supabase = getSupabaseBrowserClient();
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: true,
          emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(redirectTarget)}`
        }
      });

      if (error) {
        throw error;
      }

      setStep("code");
      setNotice("We sent a verification code to your email.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to send the verification code.");
    } finally {
      setBusy(null);
    }
  }

  async function verifyEmailCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("code");
    setErrorMessage(null);
    setNotice(null);

    try {
      const supabase = getSupabaseBrowserClient();
      const { error } = await supabase.auth.verifyOtp({
        email,
        token: otpCode,
        type: "email"
      });

      if (error) {
        throw error;
      }

      await fetch("/api/auth/ensure-profile", { method: "POST" }).catch(() => null);
      window.location.assign(redirectTarget || "/dashboard");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to verify the code.");
    } finally {
      setBusy(null);
    }
  }

  async function signInWithGoogle() {
    setBusy("google");
    setErrorMessage(null);
    setNotice(null);

    try {
      const supabase = getSupabaseBrowserClient();
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(redirectTarget)}`
        }
      });

      if (error) {
        throw error;
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to start Google sign-in.");
      setBusy(null);
    }
  }

  if (!authEnabled) {
    return (
      <main className="page-shell">
        <section className="panel">
          <p className="eyebrow">Authentication</p>
          <h1>Supabase auth is not configured</h1>
          <p className="body-copy">
            Add your Supabase project URL, publishable key, and service role key first, then come back to enable email codes and Google sign-in.
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="page-shell auth-page-shell">
      <section className="panel auth-panel">
        <div className="auth-copy">
          <p className="eyebrow">Sign in</p>
          <h1>Pick up your sessions anywhere</h1>
          <p className="body-copy">
            Use an email code or Google. Once you are in, your sketches, images, videos, and worlds stay with your account.
          </p>
        </div>

        <div className="auth-actions">
          <button type="button" className="primary-button auth-google-button" onClick={signInWithGoogle} disabled={Boolean(busy)}>
            {busy === "google" ? "Opening Google..." : "Continue with Google"}
          </button>

          <div className="auth-divider">
            <span>or use email</span>
          </div>

          {step === "email" ? (
            <form className="auth-form" onSubmit={sendEmailCode}>
              <label className="auth-field">
                <span>Email</span>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                />
              </label>
              <button type="submit" className="primary-button auth-submit-button" disabled={busy === "email"}>
                {busy === "email" ? "Sending code..." : "Send verification code"}
              </button>
            </form>
          ) : (
            <form className="auth-form" onSubmit={verifyEmailCode}>
              <label className="auth-field">
                <span>Email</span>
                <input type="email" value={email} readOnly />
              </label>
              <label className="auth-field">
                <span>Verification code</span>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  value={otpCode}
                  onChange={(event) => setOtpCode(event.target.value.trim())}
                  placeholder="123456"
                />
              </label>
              <div className="auth-form-row">
                <button type="submit" className="primary-button auth-submit-button" disabled={busy === "code"}>
                  {busy === "code" ? "Verifying..." : "Verify code"}
                </button>
                <button type="button" className="ghost-button" onClick={() => setStep("email")} disabled={Boolean(busy)}>
                  Change email
                </button>
              </div>
            </form>
          )}

          {notice ? <p className="auth-notice">{notice}</p> : null}
          {errorMessage ? <p className="auth-error">{errorMessage}</p> : null}
        </div>
      </section>
    </main>
  );
}
