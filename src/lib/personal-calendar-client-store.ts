"use client";

import { useLayoutEffect, useMemo } from "react";

export type PersonalCalendarForm = {
  provider: "microsoft" | "google";
  title: string;
  startsAt: string;
  endsAt: string;
  startInstant: string;
  endInstant: string;
  timeZone: string;
  location: string;
  projectId: string;
  attendees: string;
  attendeeNames: Record<string, string>;
  invitationsConfirmed: boolean;
};
export type PersonalCalendarAttempt = {
  key: string;
  endpoint: string;
  body: string;
  action: string;
  eventId?: string;
  submittedForm: PersonalCalendarForm;
  phase: "running" | "uncertain";
};
export type PersonalCalendarClientEntry = {
  form: PersonalCalendarForm;
  editingId: string | null;
  editingVersion: number | null;
  pending: PersonalCalendarAttempt | null;
  notice: string;
  reloadVersion: number;
  awaitingReload: boolean;
};

/** One RAM instance per signed-in CRM session, never browser storage. */
export function createPersonalCalendarClientStore(ownerUserId: string) {
  const entries = new Map<string, PersonalCalendarClientEntry>();
  const baselines = new Map<string, PersonalCalendarForm>();
  const listeners = new Set<() => void>();
  let activeMutation: symbol | null = null;
  const notify = () => listeners.forEach(listener => listener());
  return {
    ownerUserId,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    read(scope: string) { return entries.get(scope); },
    hasPendingOutside(scope: string) { return [...entries].some(([key, entry]) => key !== scope && Boolean(entry.pending)); },
    update(scope: string, initial: PersonalCalendarClientEntry, change: (entry: PersonalCalendarClientEntry) => PersonalCalendarClientEntry) {
      if (!baselines.has(scope)) baselines.set(scope, initial.form);
      entries.set(scope, change(entries.get(scope) ?? initial)); notify();
    },
    isBusy() { return activeMutation !== null; },
    acquire() {
      if (activeMutation) return null;
      activeMutation = Symbol("personal-calendar"); notify(); return activeMutation;
    },
    release(token: symbol) { if (activeMutation === token) { activeMutation = null; notify(); } },
    finish(scope: string, key: string, initial: PersonalCalendarClientEntry, notice: string, resetForm: boolean) {
      const current = entries.get(scope);
      if (current?.pending?.key !== key) return false;
      const formUnchanged = current.form === current.pending.submittedForm;
      if (resetForm && formUnchanged) baselines.set(scope, initial.form);
      entries.set(scope, { ...current, pending: null, notice, reloadVersion: current.reloadVersion + 1, awaitingReload: true,
        ...(resetForm && formUnchanged ? { form: initial.form, editingId: null, editingVersion: null } : {}) });
      notify(); return true;
    },
    reloaded(scope: string, version: number) {
      const current = entries.get(scope);
      if (!current?.awaitingReload || current.reloadVersion !== version) return;
      entries.set(scope, { ...current, awaitingReload: false }); notify();
    },
    uncertain(scope: string, key: string, notice: string) {
      const current = entries.get(scope);
      if (current?.pending?.key !== key) return;
      entries.set(scope, { ...current, pending: { ...current.pending, phase: "uncertain" }, notice }); notify();
    },
    hasUnsaved() { return activeMutation !== null || [...entries].some(([scope, entry]) => entry.pending || entry.editingId || JSON.stringify(entry.form) !== JSON.stringify(baselines.get(scope))); },
    clearAll() { entries.clear(); baselines.clear(); activeMutation = null; notify(); },
  };
}
export type PersonalCalendarClientStore = ReturnType<typeof createPersonalCalendarClientStore>;

export function usePersonalCalendarSessionStore(userId: string) {
  const store = useMemo(() => createPersonalCalendarClientStore(userId), [userId]);
  useLayoutEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (store.hasUnsaved()) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", warn);
    return () => { window.removeEventListener("beforeunload", warn); store.clearAll(); };
  }, [store]);
  return store;
}
