"use client";

/**
 * Clients portfolio + creation through the real
 * POST /api/agencies/:agencyId/clients route. Clicking a client opens the
 * Client Workspace (Journey B) in the same single route.
 */

import * as React from "react";
import { ArrowRight, Building2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useClients, useCommandCenter, useCreateClient } from "./hooks";
import { useMosSession } from "./session-store";
import { EmptyState, LoadingSkeleton, MosErrorView, StatusBadge, formatWhen, shortId } from "./shared";

export function ClientsScreen() {
  const agencyId = useMosSession((state) => state.agencyId);
  const navigate = useMosSession((state) => state.navigate);
  const clients = useClients(agencyId);
  const command = useCommandCenter(agencyId);
  const createClient = useCreateClient(agencyId ?? "");
  const [newName, setNewName] = React.useState("");
  const [showForm, setShowForm] = React.useState(false);

  if (agencyId === null) {
    return <EmptyState title="No agency selected" hint="Select an agency to view its client portfolio." />;
  }
  if (clients.isPending) return <LoadingSkeleton rows={5} />;
  if (clients.isError) {
    return <MosErrorView error={clients.error} what="the client portfolio" onRetry={() => void clients.refetch()} />;
  }

  const list = clients.data ?? [];
  const perClientGoals = new Map(
    (command.data?.portfolioGoals.perClient ?? []).map((tally) => [tally.clientId, tally]),
  );

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Clients</h1>
          <p className="text-sm text-muted-foreground">
            Agency <span className="font-mono text-xs">{agencyId}</span> · {list.length} live client
            {list.length === 1 ? "" : "s"} · source:{" "}
            <span className="font-mono text-xs">GET /api/agencies/:agencyId/clients</span>
          </p>
        </div>
        <Button variant="outline" className="gap-2" onClick={() => setShowForm((open) => !open)}>
          <Plus className="size-4" aria-hidden="true" /> New client
        </Button>
      </header>

      {showForm ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Create a client</CardTitle>
            <CardDescription>
              Creates through the real <span className="font-mono text-xs">POST /api/agencies/:agencyId/clients</span>{" "}
              route — requires agency owner/admin (the server enforces it).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="flex flex-col gap-3 sm:flex-row sm:items-end"
              onSubmit={(event) => {
                event.preventDefault();
                const name = newName.trim();
                if (name === "") return;
                createClient.mutate(name, {
                  onSettled: () => setNewName(""),
                });
              }}
            >
              <div className="flex-1 space-y-2">
                <Label htmlFor="mos-new-client">Client name</Label>
                <Input
                  id="mos-new-client"
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  placeholder="e.g. Helio Robotics"
                  maxLength={200}
                  required
                />
              </div>
              <Button type="submit" disabled={createClient.isPending || newName.trim() === ""}>
                Create client
              </Button>
            </form>
          </CardContent>
        </Card>
      ) : null}

      {list.length === 0 ? (
        <EmptyState
          title="No clients yet"
          hint="This agency has no live clients yet. Create your first client through the real API route — it becomes the home for its goals, playbooks, workflows and app installs."
          icon={Building2}
          action={
            !showForm ? (
              <Button variant="outline" className="gap-2" onClick={() => setShowForm(true)}>
                <Plus className="size-4" aria-hidden="true" /> Create your first client
              </Button>
            ) : null
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((client) => {
            const goals = perClientGoals.get(client.clientId);
            return (
              <Card key={client.clientId} className="flex flex-col">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="truncate text-base">{client.name}</CardTitle>
                    <StatusBadge status={client.status} />
                  </div>
                  <CardDescription className="font-mono text-xs">
                    {shortId(client.clientId)} · updated {formatWhen(client.updatedAt)}
                  </CardDescription>
                </CardHeader>
                <CardContent className="mt-auto space-y-3">
                  {goals ? (
                    <p className="text-xs text-muted-foreground">
                      {goals.total} goal{goals.total === 1 ? "" : "s"}{" "}
                      {Object.entries(goals.goalStatusCounts)
                        .filter(([, value]) => value !== 0)
                        .map(([key, value]) => `· ${key}: ${value}`)
                        .join(" ")}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">No goals recorded.</p>
                  )}
                  <Button
                    variant="secondary"
                    className="w-full gap-1"
                    onClick={() => navigate({ kind: "client", clientId: client.clientId, tab: "overview" })}
                  >
                    Open workspace <ArrowRight className="size-3" aria-hidden="true" />
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
