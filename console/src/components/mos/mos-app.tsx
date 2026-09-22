"use client";

/**
 * The MOS single-route application: providers (TanStack Query + sonner),
 * session bootstrap and the client-side view switch. This is the ONLY
 * user-visible route in the presentation app.
 */

import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { AgencyGate, AppShell } from "./app-shell";
import HomeScreen from "./home/HomeScreen";
import { MissionCreateScreen } from "./create/MissionCreateScreen";
import { MissionCreatedScreen } from "./create/MissionCreatedScreen";
import { AdminScreen } from "./admin-screen";
import { AppsScreen } from "./apps-screen";
import { AttentionScreen } from "./attention-screen";
import { ClientWorkspaceScreen } from "./client-workspace";
import { ClientsScreen } from "./clients-screen";
import { CommandCenterScreen } from "./command-center";
import { DecisionDetailScreen } from "./decision-detail";
import { useAuthContext } from "./hooks";
import { HumanWorkScreen } from "./human-work-screen";
import { LoginScreen } from "./login-screen";
import { ProfitScreen } from "./profit-screen";
import { useMosSession } from "./session-store";

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: 15_000 },
    },
  });
}

export function MosApp() {
  const [queryClient] = React.useState(makeQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <MosAppInner />
      <Toaster position="bottom-right" richColors closeButton />
    </QueryClientProvider>
  );
}

function MosAppInner() {
  const hydrate = useMosSession((state) => state.hydrate);
  const token = useMosSession((state) => state.token);
  const view = useMosSession((state) => state.view);
  const agencyId = useMosSession((state) => state.agencyId);
  const setAuthContext = useMosSession((state) => state.setAuthContext);

  React.useEffect(() => {
    hydrate();
  }, [hydrate]);

  // The caller's own authorization context — server-derived, refreshed on
  // every mount; a 401 here clears the session back to the login screen.
  const auth = useAuthContext();
  React.useEffect(() => {
    if (auth.data !== undefined) {
      setAuthContext(auth.data);
    }
  }, [auth.data, setAuthContext]);

  if (!token) {
    return <LoginScreen />;
  }

  return (
    <AppShell>
      {view.kind === "home" ? <HomeScreen /> : null}
      {view.kind === "create-mission" ? (
        <MissionCreateScreen seedFamily={view.family ?? null} />
      ) : null}
      {view.kind === "mission-created" ? (
        <MissionCreatedScreen missionId={view.missionId} />
      ) : null}
      {view.kind === "command-center" ? (
        agencyId === null ? (
          <AgencyGate />
        ) : (
          <CommandCenterScreen />
        )
      ) : null}
      {view.kind === "clients" ? (
        agencyId === null ? <AgencyGate /> : <ClientsScreen />
      ) : null}
      {view.kind === "client" ? (
        <ClientWorkspaceScreen clientId={view.clientId} tab={view.tab} />
      ) : null}
      {view.kind === "decision" ? <DecisionDetailScreen decisionId={view.decisionId} /> : null}
      {view.kind === "attention" ? (
        agencyId === null ? <AgencyGate /> : <AttentionScreen />
      ) : null}
      {view.kind === "profit" ? (
        agencyId === null ? <AgencyGate /> : <ProfitScreen />
      ) : null}
      {view.kind === "human-work" ? <HumanWorkScreen /> : null}
      {view.kind === "apps" ? <AppsScreen tab={view.tab} /> : null}
      {view.kind === "admin" ? <AdminScreen /> : null}
    </AppShell>
  );
}
