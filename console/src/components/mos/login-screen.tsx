"use client";

/**
 * MOS login screen (DEP-006): one screen, two clearly separated REAL
 * experiences + one visually distinct DEMO panel.
 *
 *   - "Sign in": email + password against the real /api/auth/login
 *     (password ≥ 12 chars, uniform 401 on bad credentials — no account
 *     enumeration).
 *   - "Create account": name, work email, agency name, password + confirm
 *     through POST /api/mos-signup (a server-side orchestrator over MOS's own
 *     admin contracts). On 201 the SPA signs the new identity in through the
 *     REAL /api/auth/login — zero simulation, the account starts empty.
 *   - Demo quick-logins: one-click buttons for the seeded demo personas.
 *     These are REAL users of the REAL staging platform whose data was seeded
 *     through the real API — the buttons only prefill credentials. Demo
 *     accounts are for exploration only.
 */

import * as React from "react";
import { FlaskConical, Loader2, LogIn, Radio, UserPlus } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MosApiError } from "@/lib/mos-api";
import { useMosSession } from "./session-store";

type DemoLogin = { label: string; email: string; password: string; hint: string };

/**
 * Demo quick-logins. The DEP-002 staging seed defines these users through
 * the REAL /api/users routes — see
 * mini-services/mos-api-service/CREDENTIALS.md when present.
 */
export const DEMO_LOGINS: DemoLogin[] = [
  {
    label: "Platform Administrator",
    email: "admin@mos.demo",
    password: "DemoAdmin-2026",
    hint: "Platform admin — administration surfaces, can address any agency by id",
  },
  {
    label: "Agency Owner — Northwind",
    email: "casey@northwind.demo",
    password: "Northwind-Owner-2026",
    hint: "Owner of the demo agency Northwind Growth Partners",
  },
  {
    label: "Agency Operator — Northwind",
    email: "jordan@northwind.demo",
    password: "Northwind-Ops-2026",
    hint: "Agency operator membership",
  },
  {
    label: "Human Agent — Northwind",
    email: "sam@northwind.demo",
    password: "Northwind-Agent-2026",
    hint: "Human Agent profile — the jobs work queue",
  },
];

/** The shared error alert (status + message + validation details). */
function ErrorAlert({ error }: { error: MosApiError }) {
  return (
    <Alert role="alert" variant="destructive">
      <AlertDescription>
        {error.status === 401
          ? "Invalid credentials."
          : error.status === 409
            ? error.message
            : `${error.status === 0 ? "" : `${error.status} · `}${error.message}`}
        {error.details.length > 0 ? (
          <span className="mt-1 block font-mono text-xs">{error.details.join(" · ")}</span>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

/** POST /api/mos-signup — the Next.js server-side orchestrator route. */
async function requestSignup(input: {
  displayName: string;
  email: string;
  agencyName: string;
  password: string;
}): Promise<void> {
  let response: Response;
  try {
    response = await fetch("/api/mos-signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      cache: "no-store",
    });
  } catch (cause) {
    throw new MosApiError(0, "NETWORK_ERROR", `Cannot reach the sign-up service: ${String(cause)}`);
  }
  if (response.ok) return; // 201 — the honest success contract
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    payload = null;
  }
  const envelope = (payload ?? {}) as { error?: { code?: unknown; message?: unknown; details?: unknown } };
  const error = envelope.error ?? {};
  const code = typeof error.code === "string" ? error.code : `HTTP_${response.status}`;
  const message =
    typeof error.message === "string" ? error.message : `Sign-up failed (HTTP ${response.status})`;
  const details = Array.isArray(error.details)
    ? error.details.filter((entry): entry is string => typeof entry === "string")
    : [];
  throw new MosApiError(response.status, code, message, details);
}

export function LoginScreen() {
  const login = useMosSession((state) => state.login);

  // --- shared state ---------------------------------------------------------
  const [error, setError] = React.useState<MosApiError | null>(null);
  const [pending, setPending] = React.useState<string | null>(null);

  // --- sign-in form -----------------------------------------------------------
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");

  // --- create-account form ------------------------------------------------------
  const [name, setName] = React.useState("");
  const [signupEmail, setSignupEmail] = React.useState("");
  const [agencyName, setAgencyName] = React.useState("");
  const [signupPassword, setSignupPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [confirmError, setConfirmError] = React.useState<string | null>(null);

  async function submitSignIn(demo?: DemoLogin) {
    const useEmail = demo?.email ?? email;
    const usePassword = demo?.password ?? password;
    setError(null);
    setPending(demo?.label ?? "signin");
    try {
      await login(useEmail, usePassword);
    } catch (cause) {
      setError(
        cause instanceof MosApiError
          ? cause
          : new MosApiError(0, "CLIENT_ERROR", String(cause)),
      );
    } finally {
      setPending(null);
    }
  }

  async function submitSignUp(event: React.FormEvent) {
    event.preventDefault();
    setConfirmError(null);
    if (signupPassword !== confirmPassword) {
      setConfirmError("Passwords do not match.");
      return;
    }
    setError(null);
    setPending("signup");
    try {
      // 1. Create the REAL account through the server-side orchestrator.
      await requestSignup({
        displayName: name.trim(),
        email: signupEmail.trim(),
        agencyName: agencyName.trim(),
        password: signupPassword,
      });
      // 2. Auto sign-in through the REAL /api/auth/login contract.
      await login(signupEmail.trim(), signupPassword);
    } catch (cause) {
      setError(
        cause instanceof MosApiError
          ? cause
          : new MosApiError(0, "CLIENT_ERROR", String(cause)),
      );
    } finally {
      setPending(null);
    }
  }

  const busy = pending !== null;

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-md space-y-6">
        <header className="space-y-2 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Radio className="size-6" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">MOS — Marketing Operating System</h1>
          <p className="text-sm text-muted-foreground">
            Sign in with your MOS identity, or create a real account for your agency. Every view
            renders live backend state — nothing here is simulated.
          </p>
        </header>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle>Welcome</CardTitle>
            <CardDescription>Sign in to an existing account or create a new one.</CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="signin">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="signin" className="gap-1.5">
                  <LogIn className="size-3.5" aria-hidden="true" /> Sign in
                </TabsTrigger>
                <TabsTrigger value="signup" className="gap-1.5">
                  <UserPlus className="size-3.5" aria-hidden="true" /> Create account
                </TabsTrigger>
              </TabsList>

              {/* ------------------------- Sign in ------------------------- */}
              <TabsContent value="signin" className="mt-4">
                <form
                  className="space-y-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitSignIn();
                  }}
                >
                  <div className="space-y-2">
                    <Label htmlFor="mos-login-email">Email</Label>
                    <Input
                      id="mos-login-email"
                      type="email"
                      autoComplete="username"
                      required
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="you@agency.example"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="mos-login-password">Password</Label>
                    <Input
                      id="mos-login-password"
                      type="password"
                      autoComplete="current-password"
                      required
                      minLength={12}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder="••••••••••••"
                    />
                  </div>
                  <Button type="submit" className="h-11 w-full" disabled={busy}>
                    {pending === "signin" ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <LogIn className="size-4" aria-hidden="true" />
                    )}
                    Sign in
                  </Button>
                </form>
              </TabsContent>

              {/* ---------------------- Create account ---------------------- */}
              <TabsContent value="signup" className="mt-4">
                <form className="space-y-4" onSubmit={submitSignUp}>
                  <div className="space-y-2">
                    <Label htmlFor="mos-signup-name">Your name</Label>
                    <Input
                      id="mos-signup-name"
                      autoComplete="name"
                      required
                      maxLength={100}
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="Alex Rivera"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="mos-signup-email">Work email</Label>
                    <Input
                      id="mos-signup-email"
                      type="email"
                      autoComplete="email"
                      required
                      maxLength={254}
                      value={signupEmail}
                      onChange={(event) => setSignupEmail(event.target.value)}
                      placeholder="you@agency.example"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="mos-signup-agency">Agency name</Label>
                    <Input
                      id="mos-signup-agency"
                      required
                      maxLength={100}
                      value={agencyName}
                      onChange={(event) => setAgencyName(event.target.value)}
                      placeholder="e.g. Rivera Growth Studio"
                    />
                    <p className="text-xs text-muted-foreground">
                      Your agency starts genuinely empty — you create its clients yourself.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="mos-signup-password">Password (≥ 12 characters)</Label>
                    <Input
                      id="mos-signup-password"
                      type="password"
                      autoComplete="new-password"
                      required
                      minLength={12}
                      maxLength={256}
                      value={signupPassword}
                      onChange={(event) => setSignupPassword(event.target.value)}
                      placeholder="••••••••••••"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="mos-signup-confirm">Confirm password</Label>
                    <Input
                      id="mos-signup-confirm"
                      type="password"
                      autoComplete="new-password"
                      required
                      minLength={12}
                      maxLength={256}
                      value={confirmPassword}
                      onChange={(event) => setConfirmPassword(event.target.value)}
                      placeholder="••••••••••••"
                    />
                    {confirmError ? <p className="text-sm text-destructive">{confirmError}</p> : null}
                  </div>
                  <Button type="submit" className="h-11 w-full" disabled={busy}>
                    {pending === "signup" ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <UserPlus className="size-4" aria-hidden="true" />
                    )}
                    Create account
                  </Button>
                </form>
              </TabsContent>
            </Tabs>

            {error ? (
              <div className="mt-4">
                <ErrorAlert error={error} />
              </div>
            ) : null}
          </CardContent>
        </Card>

        {/* -------------------- Demo quick-login panel -------------------- */}
        <section
          aria-labelledby="mos-demo-logins"
          className="space-y-3 rounded-xl border border-dashed bg-muted/30 p-4"
        >
          <div className="flex items-center gap-2">
            <FlaskConical className="size-4 text-muted-foreground" aria-hidden="true" />
            <h2 id="mos-demo-logins" className="text-sm font-semibold">
              Demo accounts
            </h2>
          </div>
          <p className="text-xs text-muted-foreground">
            Explore MOS with pre-seeded demo data (the Northwind demo agency: clients, goals,
            workflows, evidence, apps and a live work queue). Demo accounts are for exploration
            only — they are real identities on this platform, but their data is demo staging data.
          </p>
          {/* F-2 (VER-001): grid-cols-1 = repeat(1, minmax(0, 1fr)) — the
              track can shrink below the buttons' whitespace-nowrap
              max-content, so the inner min-w-0 + truncate spans actually
              truncate inside the max-w-md card on 390px viewports (an
              implicit auto track sizes to the max-content width and blew the
              document out to 507px). */}
          <div className="grid grid-cols-1 gap-2">
            {DEMO_LOGINS.map((demo) => (
              <Button
                key={demo.email}
                type="button"
                variant="outline"
                className="h-auto justify-start gap-3 bg-background px-4 py-3 text-left"
                disabled={busy}
                onClick={() => void submitSignIn(demo)}
              >
                {pending === demo.label ? (
                  <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
                ) : null}
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{demo.label}</span>
                  <span className="block truncate text-xs text-muted-foreground">{demo.hint}</span>
                </span>
              </Button>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
