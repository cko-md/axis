"use client";

import { Suspense, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = useMemo(() => createClient(), []);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setNotice(null);

    const result =
      mode === "signin"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });

    setLoading(false);

    if (result.error) {
      setError(result.error.message);
      return;
    }

    // Sign-up with email confirmation enabled returns a user but no session
    if (mode === "signup" && !result.data.session) {
      setNotice("Check your email to confirm your account, then sign in.");
      setMode("signin");
      return;
    }

    const redirect = searchParams.get("redirect");
    const next = redirect && redirect.startsWith("/") && !redirect.startsWith("//") ? redirect : "/console";
    router.push(next);
    router.refresh();
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center p-6">
      <div className="grain" aria-hidden />
      <div className="card relative z-10 w-full max-w-md tick">
        <div className="mb-6 text-center">
          <div className="font-mono text-[13px] tracking-[0.26em]">
            A<span className="text-[var(--accent)]">XIS</span>
            <sup className="text-[6.5px] text-[var(--accent-2)]">[CKO]</sup>
          </div>
          <h1 className="hero-title mt-3 text-2xl">Sign in</h1>
          <p className="sub mx-auto mt-2 text-center">Your personal operating system</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            type="email"
            required
            autoComplete="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
          />
          <input
            type="password"
            required
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
          />
          {error && <p className="text-xs text-[var(--down)]">{error}</p>}
          {notice && <p className="text-xs text-[var(--up)]">{notice}</p>}
          <Button type="submit" variant="primary" loading={loading} className="w-full py-2.5">
            {mode === "signin" ? "Sign in" : "Create account"}
          </Button>
        </form>

        <button
          type="button"
          className="mt-4 w-full text-center text-xs text-[var(--ink-dim)] hover:text-[var(--accent)]"
          onClick={() => setMode((m) => (m === "signin" ? "signup" : "signin"))}
        >
          {mode === "signin" ? "Need an account? Sign up" : "Already have an account? Sign in"}
        </button>

        <p className="mt-6 text-center font-mono text-[9px] text-[var(--ink-faint)]">
          Configure Supabase env vars before signing in.
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
