"use client";

/**
 * Administration — platform-scoped surfaces: platform health, the platform
 * policy registry, user provisioning (through the real /api/users routes)
 * and agency administration (detail + memberships by identifier). The
 * platform-operations surface is service-principal-only by design; that is
 * stated honestly rather than faked.
 */

import * as React from "react";
import { ArrowRight, Settings2, UserPlus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAgency, useCreateUser, useMemberships, usePlatformPolicies, useUser } from "./hooks";
import { useMosQuery } from "./hooks";
import { useMosSession } from "./session-store";
import {
  EmptyState,
  LoadingSkeleton,
  MosErrorView,
  ScrollList,
  StatusBadge,
  formatWhen,
  shortId,
} from "./shared";

export function AdminScreen() {
  const authContext = useMosSession((state) => state.authContext);
  const isPlatformAdmin = authContext?.platformRoles.includes("platform_administrator") ?? false;

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Settings2 className="size-5" aria-hidden="true" /> Administration
        </h1>
        <p className="text-sm text-muted-foreground">
          Platform-scoped administration surfaces. Authorization is enforced by the server on every
          request — a non-admin sees the server&apos;s own denial, never fabricated data.
        </p>
      </header>

      <PlatformHealthCard />
      <PlatformPoliciesCard />
      <UsersCard isPlatformAdmin={isPlatformAdmin} />
      <AgencyAdminCard />
    </div>
  );
}

function PlatformHealthCard() {
  const health = useMosQuery<import("@/lib/mos-api").PlatformHealth>(["platform-health"], "/api/platform/health");
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Platform health</CardTitle>
        <CardDescription className="font-mono text-xs">
          source: GET /api/platform/health (liveness — unauthenticated by design, exposes no state)
        </CardDescription>
      </CardHeader>
      <CardContent>
        {health.isPending ? (
          <LoadingSkeleton rows={1} />
        ) : health.isError ? (
          <MosErrorView error={health.error} what="platform health" />
        ) : health.data ? (
          <div className="grid gap-2 font-mono text-xs sm:grid-cols-4">
            <p>status: {health.data.status}</p>
            <p>service: {health.data.service}</p>
            <p>env: {health.data.env}</p>
            <p>time: {formatWhen(health.data.time)}</p>
          </div>
        ) : null}
        <p className="mt-2 text-xs text-muted-foreground">
          Long-running platform operations (POST /api/platform/operations) are a machine-to-machine
          service-principal surface by design — user sessions are not authorized, so this SPA performs
          no such submission.
        </p>
      </CardContent>
    </Card>
  );
}

function PlatformPoliciesCard() {
  const policies = usePlatformPolicies();
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Platform policies</CardTitle>
        <CardDescription className="font-mono text-xs">
          source: GET /api/policies — the platform-scope declared versions (supersession history
          visible)
        </CardDescription>
      </CardHeader>
      <CardContent>
        {policies.isPending ? (
          <LoadingSkeleton rows={2} />
        ) : policies.isError ? (
          <MosErrorView error={policies.error} what="platform policies" onRetry={() => void policies.refetch()} />
        ) : (policies.data ?? []).length === 0 ? (
          <EmptyState title="No platform policies declared" />
        ) : (
          <ScrollList label="Platform policies" className="space-y-2">
            {(policies.data ?? []).map((policy) => (
              <div key={policy.policyId} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary" className="font-mono text-xs">
                    {policy.dimension}
                  </Badge>
                  <StatusBadge status={policy.status} />
                  <span className="font-mono text-xs text-muted-foreground">v{policy.versionSeq}</span>
                  <span className="font-mono text-xs text-muted-foreground">{shortId(policy.policyId)}</span>
                </div>
                {policy.description ? (
                  <p className="mt-1 text-xs text-muted-foreground">{policy.description}</p>
                ) : null}
                <pre className="mos-scroll mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-xs">
                  {JSON.stringify(policy.rules, null, 2)}
                </pre>
              </div>
            ))}
          </ScrollList>
        )}
      </CardContent>
    </Card>
  );
}

function UsersCard({ isPlatformAdmin }: { isPlatformAdmin: boolean }) {
  const createUser = useCreateUser();
  const [email, setEmail] = React.useState("");
  const [displayName, setDisplayName] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [lookupId, setLookupId] = React.useState("");
  const [lookupQuery, setLookupQuery] = React.useState("");
  const user = useUser(lookupQuery === "" ? null : lookupQuery);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <UserPlus className="size-4" aria-hidden="true" /> Users
        </CardTitle>
        <CardDescription>
          {isPlatformAdmin
            ? "Provision identities through the real POST /api/users + credential routes."
            : "User provisioning requires the platform_administrator role — the server enforces it."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (email === "" || displayName === "" || password.length < 12) return;
            createUser.mutate(
              { email, displayName, password },
              {
                onSettled: () => {
                  setEmail("");
                  setDisplayName("");
                  setPassword("");
                },
              },
            );
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="mos-user-email">Email</Label>
            <Input
              id="mos-user-email"
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="new.user@mos.demo"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mos-user-name">Display name</Label>
            <Input
              id="mos-user-name"
              required
              maxLength={200}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="New User"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mos-user-password">Initial password (≥ 12 chars)</Label>
            <Input
              id="mos-user-password"
              type="password"
              required
              minLength={12}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          <div className="flex items-end">
            <Button type="submit" disabled={createUser.isPending}>
              Create user
            </Button>
          </div>
        </form>

        <div className="space-y-1.5">
          <Label htmlFor="mos-user-lookup">Look up a user by id</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="mos-user-lookup"
              className="font-mono text-sm"
              placeholder="userId (uuid)"
              value={lookupId}
              onChange={(event) => setLookupId(event.target.value)}
            />
            <Button
              variant="outline"
              onClick={() => setLookupQuery(lookupId.trim())}
              disabled={lookupId.trim() === ""}
            >
              Read user
            </Button>
          </div>
        </div>

        {lookupQuery !== "" ? (
          user.isPending ? (
            <LoadingSkeleton rows={1} />
          ) : user.isError ? (
            <MosErrorView error={user.error} what="the user record" />
          ) : user.data ? (
            <div className="rounded-lg border p-3 text-sm">
              <p className="font-medium">{user.data.displayName}</p>
              <p className="font-mono text-xs text-muted-foreground">
                {user.data.email} · {shortId(user.data.userId)}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <StatusBadge status={user.data.status} />
                {user.data.platformRoles.map((role) => (
                  <Badge key={role} variant="outline" className="font-mono text-xs">
                    {role}
                  </Badge>
                ))}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">created {formatWhen(user.data.createdAt)}</p>
            </div>
          ) : null
        ) : null}
      </CardContent>
    </Card>
  );
}

function AgencyAdminCard() {
  const authContext = useMosSession((state) => state.authContext);
  const knownAgencyIds = useMosSession((state) => state.knownAgencyIds);
  const setAgency = useMosSession((state) => state.setAgency);
  const [agencyQuery, setAgencyQuery] = React.useState("");
  const [input, setInput] = React.useState("");
  const membershipAgencyIds = (authContext?.memberships ?? [])
    .filter((membership) => membership.membershipStatus === "active")
    .map((membership) => membership.agencyId);
  const candidates = [...new Set([...membershipAgencyIds, ...knownAgencyIds])];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Agencies</CardTitle>
        <CardDescription>
          There is no platform-wide agency listing route by design — agencies are addressed by
          identifier (memberships + your navigation memory below).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="mos-agency-lookup">Address an agency by id</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="mos-agency-lookup"
              className="font-mono text-sm"
              placeholder="agencyId (uuid)"
              value={input}
              onChange={(event) => setInput(event.target.value)}
            />
            <Button variant="outline" onClick={() => setAgencyQuery(input.trim())} disabled={input.trim() === ""}>
              Read agency
            </Button>
          </div>
        </div>

        {candidates.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {candidates.map((id) => (
              <Button
                key={id}
                size="sm"
                variant="outline"
                className="gap-1 font-mono text-xs"
                onClick={() => {
                  setInput(id);
                  setAgencyQuery(id);
                }}
              >
                {shortId(id)} <ArrowRight className="size-3" aria-hidden="true" />
              </Button>
            ))}
          </div>
        ) : null}

        {agencyQuery !== "" ? <AgencyDetail agencyId={agencyQuery} onActivate={setAgency} /> : null}
      </CardContent>
    </Card>
  );
}

function AgencyDetail({ agencyId, onActivate }: { agencyId: string; onActivate: (id: string) => void }) {
  const agency = useAgency(agencyId);
  const memberships = useMemberships(agencyId);
  return (
    <div className="space-y-3">
      {agency.isPending ? (
        <LoadingSkeleton rows={1} />
      ) : agency.isError ? (
        <MosErrorView error={agency.error} what="the agency record" />
      ) : agency.data ? (
        <div className="rounded-lg border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium">{agency.data.name}</p>
              <p className="font-mono text-xs text-muted-foreground">
                {agency.data.slug} · {agencyId}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge status={agency.data.status} />
              <Button size="sm" variant="secondary" onClick={() => onActivate(agencyId)}>
                Work in this agency
              </Button>
            </div>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">updated {formatWhen(agency.data.updatedAt)}</p>
        </div>
      ) : null}

      {memberships.isPending ? (
        <LoadingSkeleton rows={1} />
      ) : memberships.isError ? (
        <MosErrorView error={memberships.error} what="the agency memberships" />
      ) : (memberships.data ?? []).length === 0 ? (
        <EmptyState title="No memberships in this agency" />
      ) : (
        <ScrollList label="Memberships" className="space-y-1.5">
          {(memberships.data ?? []).map((membership) => (
            <div
              key={membership.membershipId}
              className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-xs"
            >
              <Badge variant="outline" className="font-mono">
                {membership.role}
              </Badge>
              <StatusBadge status={membership.status} />
              <span className="font-mono text-muted-foreground">user {shortId(membership.userId)}</span>
              <span className="font-mono text-muted-foreground">since {formatWhen(membership.createdAt)}</span>
            </div>
          ))}
        </ScrollList>
      )}
    </div>
  );
}
