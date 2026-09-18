"use client";

/**
 * MOS app shell: sidebar navigation (desktop) / top bar + drawer (mobile),
 * agency selector, user menu, sticky footer. All navigation is client-side
 * state in the single `/` route — no page routes exist.
 */

import * as React from "react";
import {
  ChevronDown,
  ClipboardList,
  LayoutDashboard,
  LogOut,
  Menu,
  Puzzle,
  Radio,
  Settings2,
  Sparkles,
  TrendingUp,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useAgency, useAuthContext } from "./hooks";
import { useMosSession, type MosView } from "./session-store";

type NavItem = {
  key: MosView["kind"];
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  view: MosView;
};

const NAV_ITEMS: NavItem[] = [
  { key: "command-center", label: "Command Center", icon: LayoutDashboard, view: { kind: "command-center" } },
  { key: "clients", label: "Clients", icon: Users, view: { kind: "clients" } },
  { key: "attention", label: "Attention", icon: Sparkles, view: { kind: "attention" } },
  { key: "profit", label: "Profit Intelligence", icon: TrendingUp, view: { kind: "profit" } },
  { key: "human-work", label: "Human Work", icon: ClipboardList, view: { kind: "human-work" } },
  { key: "apps", label: "Apps", icon: Puzzle, view: { kind: "apps", tab: "installed" } },
  { key: "admin", label: "Administration", icon: Settings2, view: { kind: "admin" } },
];

function isActive(view: MosView, kind: MosView["kind"]): boolean {
  if (view.kind === "client" && kind === "clients") return true;
  if (view.kind === "decision" && kind === "clients") return true;
  return view.kind === kind;
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const view = useMosSession((state) => state.view);
  const navigate = useMosSession((state) => state.navigate);
  return (
    <nav aria-label="Primary" className="space-y-1">
      {NAV_ITEMS.map((item) => (
        <Button
          key={item.key}
          variant={isActive(view, item.key) ? "secondary" : "ghost"}
          className="h-11 w-full justify-start gap-3"
          aria-current={isActive(view, item.key) ? "page" : undefined}
          onClick={() => {
            navigate(item.view);
            onNavigate?.();
          }}
        >
          <item.icon className="size-4 shrink-0" aria-hidden="true" />
          <span className="truncate">{item.label}</span>
        </Button>
      ))}
    </nav>
  );
}

function AgencySwitcher() {
  const authContext = useAuthSessionContext();
  const agencyId = useMosSession((state) => state.agencyId);
  const knownAgencyIds = useMosSession((state) => state.knownAgencyIds);
  const setAgency = useMosSession((state) => state.setAgency);
  const agencyQuery = useAgency(agencyId);
  const memberships = authContext?.memberships ?? [];
  const membershipOptions = memberships.filter((m) => m.membershipStatus === "active");
  const extraKnown = knownAgencyIds.filter((id) => !membershipOptions.some((m) => m.agencyId === id));
  const options = [
    ...membershipOptions.map((m) => ({ id: m.agencyId, label: m.agencyName ?? m.agencyId, tag: m.role })),
    ...extraKnown.map((id) => ({ id, label: id, tag: "by id" })),
  ];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="h-10 max-w-full justify-between gap-2" aria-label="Switch agency">
          <span className="min-w-0">
            <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">Agency</span>
            <span className="block truncate text-sm font-medium">
              {agencyId === null
                ? "No agency selected"
                : agencyQuery.data?.name ?? agencyId}
            </span>
          </span>
          <ChevronDown className="size-4 shrink-0" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel>Your agencies</DropdownMenuLabel>
        {options.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            No agency memberships. Platform administrators can address an agency by identifier in
            Administration.
          </p>
        ) : (
          options.map((option) => (
            <DropdownMenuItem
              key={option.id}
              className="gap-2"
              onSelect={() => setAgency(option.id)}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-xs">{option.label}</span>
                <span className="block text-[10px] text-muted-foreground">{option.tag}</span>
              </span>
              {option.id === agencyId ? <Badge variant="secondary">active</Badge> : null}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function useAuthSessionContext() {
  const context = useMosSession((state) => state.authContext);
  return context;
}

/**
 * PRESENTATION ONLY (DEP-006 D3): identities whose email ends with ".demo"
 * are the pre-seeded demo personas. This badge is a visual HINT, never a
 * gate — demo/real is a presentational distinction only. Every permission
 * stays enforced server-side by MOS on every request, for every account.
 */
function isDemoEmail(email: string | undefined | null): boolean {
  return typeof email === "string" && email.toLowerCase().endsWith(".demo");
}

function DemoBadge() {
  const email = useMosSession((state) => state.authContext)?.principal.email;
  if (!isDemoEmail(email)) return null;
  return (
    <Badge variant="outline" className="border-dashed font-normal text-muted-foreground">
      Demo — pre-seeded data
    </Badge>
  );
}

function UserMenu() {
  const authContext = useAuthSessionContext();
  const logout = useMosSession((state) => state.logout);
  const email = authContext?.principal.email ?? "signed in";
  const roles = authContext?.platformRoles ?? [];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-10 gap-2 px-2" aria-label="Account menu">
          <span className="hidden max-w-40 truncate text-sm sm:block">{email}</span>
          {/* Presentation-only demo hint — see the isDemoEmail comment. */}
          <DemoBadge />
          <ChevronDown className="size-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="font-normal">
          <p className="truncate text-sm font-medium">{email}</p>
          <p className="text-xs text-muted-foreground">
            {authContext?.principal.displayName ?? "MOS user"}
          </p>
          {roles.length > 0 ? (
            <p className="mt-1 font-mono text-[10px] text-muted-foreground">{roles.join(", ")}</p>
          ) : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void logout(true)} className="gap-2">
          <LogOut className="size-4" aria-hidden="true" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <div className="flex flex-1 flex-col md:flex-row">
        {/* Desktop sidebar */}
        <aside className="hidden w-64 shrink-0 flex-col gap-4 border-r bg-sidebar p-4 md:flex">
          <div className="flex items-center gap-2 px-1">
            <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Radio className="size-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">MOS</p>
              <p className="truncate text-[10px] text-muted-foreground">Marketing Operating System</p>
            </div>
          </div>
          <AgencySwitcher />
          <NavList />
          <p className="mt-auto px-1 text-[10px] leading-relaxed text-muted-foreground">
            Presentation layer over the live MOS API. All authority state is server-held; every
            mutation flows through existing MOS contracts.
          </p>
        </aside>

        {/* Mobile top bar */}
        <div className="sticky top-0 z-30 flex items-center gap-2 border-b bg-background px-4 py-2 md:hidden">
          <Drawer open={drawerOpen} onOpenChange={setDrawerOpen}>
            <DrawerTrigger asChild>
              <Button variant="ghost" size="icon" className="size-11" aria-label="Open navigation">
                <Menu className="size-5" />
              </Button>
            </DrawerTrigger>
            <DrawerContent>
              <DrawerHeader className="pb-2">
                <DrawerTitle className="flex items-center gap-2">
                  <Radio className="size-4" aria-hidden="true" /> MOS navigation
                </DrawerTitle>
                <DrawerDescription>Pick a destination</DrawerDescription>
              </DrawerHeader>
              <div className="space-y-3 px-4 pb-6">
                <AgencySwitcher />
                <NavList onNavigate={() => setDrawerOpen(false)} />
              </div>
            </DrawerContent>
          </Drawer>
          <p className="flex-1 truncate text-sm font-semibold">MOS</p>
          <UserMenu />
        </div>

        {/* Main column */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="hidden items-center justify-end gap-2 border-b bg-background px-4 py-2 md:flex">
            <UserMenu />
          </header>
          <main className="min-w-0 flex-1 p-4 md:p-6">{children}</main>
          <footer className="mt-auto border-t bg-background px-4 py-3 md:px-6">
            <p className="text-xs text-muted-foreground">
              MOS — Marketing Operating System · single-route presentation
              app · every datum comes from the MOS API, honestly rendered.
            </p>
          </footer>
        </div>
      </div>
    </div>
  );
}

/** The agency access gate shown when no agency selector is resolvable. */
export function AgencyGate() {
  const setAgency = useMosSession((state) => state.setAgency);
  const knownAgencyIds = useMosSession((state) => state.knownAgencyIds);
  const authContext = useAuthSessionContext();
  const [value, setValue] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const isPlatformAdmin = authContext?.platformRoles.includes("platform_administrator") ?? false;

  return (
    <section aria-labelledby="agency-gate-title" className="space-y-3">
      <h2 id="agency-gate-title" className="text-lg font-semibold">
        No agency selected
      </h2>
      <p className="max-w-xl text-sm text-muted-foreground">
        Your identity has no active agency membership in its authorization context.{" "}
        {isPlatformAdmin
          ? "As a platform administrator you can address any agency by its identifier — the server still enforces every permission on each request."
          : "Ask your agency owner to add your identity as a member, or sign in with a different account."}
      </p>
      {isPlatformAdmin ? (
        <form
          className="flex max-w-md gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = value.trim();
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
              setError("Enter the agency identifier (UUID) you want to address.");
              return;
            }
            setError(null);
            setAgency(trimmed);
          }}
        >
          <Input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="agency id (uuid)"
            aria-label="Agency identifier"
            className="h-11 font-mono text-sm"
          />
          <Button type="submit" className="h-11">
            Open agency
          </Button>
        </form>
      ) : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {knownAgencyIds.length > 0 ? (
        <div className="flex flex-wrap gap-2 pt-1">
          {knownAgencyIds.map((id) => (
            <Button key={id} variant="outline" size="sm" onClick={() => setAgency(id)}>
              <span className="font-mono text-xs">{id}</span>
            </Button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
