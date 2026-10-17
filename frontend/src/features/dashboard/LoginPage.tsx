import { useMutation } from "@tanstack/react-query";
import { motion } from "motion/react";
import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router";

import { ThemeToggle } from "../../components/ThemeToggle";
import { Button, DemoBadge, Field, inputClass, Logo } from "../../components/ui";
import { DEMO_EMAIL, DEMO_PASSWORD } from "../../demo/engine";
import { api, auth, DEMO } from "../../lib/api";
import { ApiError } from "../../lib/errors";

export function LoginPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = useMutation({
    mutationFn: (creds: { email: string; password: string }) =>
      mode === "login" ? api.login(creds.email, creds.password) : api.register(creds.email, creds.password),
    onSuccess: () => navigate("/dashboard"),
    onError: (e) => {
      if (e instanceof ApiError && e.status === 422) setErrors(e.fields);
      else setErrors({ _: e instanceof ApiError && e.code === "rate_limited" ? "Too many attempts. Wait a minute and try again." : e.message });
    },
  });

  if (auth.get()) return <Navigate to="/dashboard" replace />;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setErrors({});
    submit.mutate({ email, password });
  };

  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <header className="flex h-14 items-center justify-between px-4 sm:px-6">
        <Link to="/">
          <Logo />
        </Link>
        <ThemeToggle />
      </header>
      <main className="flex flex-1 items-center justify-center px-4 pb-20">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", bounce: 0, duration: 0.45 }}
          className="w-full max-w-sm"
        >
          <h1 className="text-center text-2xl font-semibold title">{mode === "login" ? "Sign in to Pulse" : "Create your account"}</h1>
          <div className="mt-2 flex justify-center">
            <DemoBadge />
          </div>

          {DEMO && mode === "login" && (
            <Button
              variant="primary"
              className="mt-8 h-11 w-full"
              onClick={() => submit.mutate({ email: DEMO_EMAIL, password: DEMO_PASSWORD })}
              disabled={submit.isPending}
            >
              Continue with the demo account
            </Button>
          )}
          {DEMO && mode === "login" && (
            <div className="my-6 flex items-center gap-3 text-xs text-subtle">
              <span className="h-px flex-1 bg-border" /> or with email <span className="h-px flex-1 bg-border" />
            </div>
          )}

          <form onSubmit={onSubmit} className={`space-y-4 ${DEMO && mode === "login" ? "" : "mt-8"}`} noValidate>
            <Field label="Email" error={errors.email}>
              <input
                className={inputClass}
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-invalid={!!errors.email}
                placeholder={DEMO ? DEMO_EMAIL : "you@company.com"}
              />
            </Field>
            <Field label="Password" error={errors.password} hint={mode === "register" ? "At least 8 characters." : undefined}>
              <input
                className={inputClass}
                type="password"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={!!errors.password}
              />
            </Field>
            {errors._ && <p className="rounded-md bg-down-soft px-3 py-2 text-[13px] text-down">{errors._}</p>}
            <Button type="submit" className="h-10 w-full" variant={DEMO && mode === "login" ? "secondary" : "primary"} disabled={submit.isPending}>
              {submit.isPending ? "…" : mode === "login" ? "Sign in" : "Create account"}
            </Button>
          </form>
          <p className="mt-6 text-center text-sm text-muted">
            {mode === "login" ? "No account yet? " : "Already have one? "}
            <button
              type="button"
              className="font-medium text-text underline underline-offset-4"
              onClick={() => {
                setMode(mode === "login" ? "register" : "login");
                setErrors({});
              }}
            >
              {mode === "login" ? "Create one" : "Sign in"}
            </button>
          </p>
        </motion.div>
      </main>
    </div>
  );
}
