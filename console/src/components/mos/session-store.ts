"use client";

/**
 * MOS SPA session + navigation state (client-side ONLY — no page routes).
 *
 * This store holds PRESENTATION state only: the MOS Bearer session token,
 * the last navigation view, and the active agency SELECTOR. It holds ZERO
 * authority state — every datum is re-fetched from the MOS API and every
 * authorization decision is made server-side on every request.
 */

import { create } from "zustand";
import type { ObjectiveFamily } from "@/components/mos/create/families";
import {
  getMosToken,
  MosApiError,
  setMosToken,
  type AuthContext,
  type LoginResponse,
  mosGet,
  mosPost,
} from "@/lib/mos-api";

const SESSION_STORAGE_KEY = "mos.presentation.session.v1";
const AGENCY_STORAGE_KEY = "mos.presentation.agency.v1";

export type ClientWorkspaceTab =
  | "overview"
  | "trace"
  | "goals"
  | "playbooks"
  | "deployments"
  | "workflows"
  | "evidence"
  | "decisions"
  | "learning"
  | "memory";

export type AppsTab = "installed" | "marketplace" | "first-party" | "developer";

export type MosView =
  | { kind: "home" }
  | { kind: "command-center" }
  | { kind: "clients" }
  | { kind: "client"; clientId: string; tab: ClientWorkspaceTab }
  | { kind: "decision"; decisionId: string }
  | { kind: "attention" }
  | { kind: "profit" }
  | { kind: "human-work" }
  | { kind: "apps"; tab: AppsTab }
  | { kind: "admin" }
  // UX-002 — the reusable mission-creation flow (one flow, optionally
  // pre-seeded with a frozen §3 family by a home outcome card; reachable
  // with no seed too) and its honest mission-created read-back view.
  | { kind: "create-mission"; family?: ObjectiveFamily }
  | { kind: "mission-created"; missionId: string }
  // UX-003 — the mission workspace: one screen that answers what a mission
  // is doing by COMPOSING the existing module authorities (mission detail,
  // goal mappings, client-scoped surfaces). Presentation view state only.
  | { kind: "mission"; missionId: string };

type MosSessionState = {
  /** The MOS Bearer token (null → login screen). */
  token: string | null;
  /** The caller's own authorization context (server-derived). */
  authContext: AuthContext | null;
  /** The active agency selector (a membership agencyId, or an admin-entered id). */
  agencyId: string | null;
  /** Agency ids the operator has addressed before (navigation memory only). */
  knownAgencyIds: string[];
  view: MosView;
  booted: boolean;

  hydrate: () => void;
  login: (email: string, password: string) => Promise<void>;
  logout: (revoke?: boolean) => Promise<void>;
  setAuthContext: (context: AuthContext) => void;
  clearSession: () => void;
  setAgency: (agencyId: string) => void;
  navigate: (view: MosView) => void;
};

function readStoredSession(): string | null {
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
    return raw === null || raw === "" ? null : raw;
  } catch {
    return null;
  }
}

function readStoredAgency(): { agencyId: string | null; known: string[] } {
  try {
    const raw = window.localStorage.getItem(AGENCY_STORAGE_KEY);
    if (raw === null) return { agencyId: null, known: [] };
    const parsed = JSON.parse(raw) as { agencyId?: string | null; known?: string[] };
    return {
      agencyId: parsed.agencyId ?? null,
      known: Array.isArray(parsed.known) ? parsed.known : [],
    };
  } catch {
    return { agencyId: null, known: [] };
  }
}

function persistAgency(agencyId: string | null, known: string[]): void {
  try {
    window.localStorage.setItem(AGENCY_STORAGE_KEY, JSON.stringify({ agencyId, known }));
  } catch {
    /* storage unavailable — navigation memory is best-effort only */
  }
}

export const useMosSession = create<MosSessionState>((set, get) => ({
  token: null,
  authContext: null,
  agencyId: null,
  knownAgencyIds: [],
  view: { kind: "home" },
  booted: false,

  hydrate: () => {
    if (get().booted) return;
    const token = readStoredSession();
    const { agencyId, known } = readStoredAgency();
    if (token !== null) {
      setMosToken(token);
    }
    set({ token, agencyId, knownAgencyIds: known, booted: true });
    if (token !== null) {
      // Validate the stored token on boot against the REAL auth contract —
      // an expired or revoked session clears back to the login screen
      // instead of erroring on every screen (DEP-006 D4).
      void mosGet<AuthContext>("/api/auth/authorization-context").catch((cause: unknown) => {
        if (cause instanceof MosApiError && cause.status === 401) {
          get().clearSession();
        }
      });
    }
  },

  login: async (email, password) => {
    const response = await mosPost<LoginResponse>("/api/auth/login", { email, password });
    setMosToken(response.token);
    try {
      window.localStorage.setItem(SESSION_STORAGE_KEY, response.token);
    } catch {
      /* session persistence is best-effort */
    }
    set({ token: response.token, authContext: null, view: { kind: "home" } });
  },

  logout: async (revoke = true) => {
    if (revoke && get().token !== null) {
      try {
        await mosPost("/api/auth/logout", {});
      } catch {
        /* revocation failures still clear the local session */
      }
    }
    get().clearSession();
  },

  clearSession: () => {
    setMosToken(null);
    try {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      /* ignore */
    }
    // The agency selector + navigation memory are PER-IDENTITY presentation
    // state — drop them with the session so the next sign-in (which may be a
    // different identity) starts from its own memberships, never inherits
    // another identity's agency selection.
    try {
      window.localStorage.removeItem(AGENCY_STORAGE_KEY);
    } catch {
      /* ignore */
    }
    set({ token: null, authContext: null, agencyId: null, knownAgencyIds: [], view: { kind: "home" } });
  },

  setAuthContext: (context) => {
    const state = get();
    // Prefer a stored agency selector, else the first active membership.
    let agencyId = state.agencyId;
    if (agencyId === null) {
      const active = context.memberships.find((m) => m.membershipStatus === "active");
      agencyId = active?.agencyId ?? null;
    }
    if (agencyId !== null && !state.knownAgencyIds.includes(agencyId)) {
      const known = [agencyId, ...state.knownAgencyIds].slice(0, 12);
      persistAgency(agencyId, known);
      set({ authContext: context, agencyId, knownAgencyIds: known });
      return;
    }
    persistAgency(agencyId, state.knownAgencyIds);
    set({ authContext: context, agencyId });
  },

  setAgency: (agencyId) => {
    const state = get();
    const known = state.knownAgencyIds.includes(agencyId)
      ? state.knownAgencyIds
      : [agencyId, ...state.knownAgencyIds].slice(0, 12);
    persistAgency(agencyId, known);
    set({ agencyId, knownAgencyIds: known, view: { kind: "home" } });
  },

  navigate: (view) => set({ view }),
}));
