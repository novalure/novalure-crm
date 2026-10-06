"use client";

import { useCallback, useSyncExternalStore, type SetStateAction } from "react";
import { type PropertyDraft, type PropertyDraftStore } from "@/lib/property-draft-store";

export function usePropertyDraft(store: PropertyDraftStore, scopeKey: string, initialDraft: PropertyDraft) {
  const getSnapshot = useCallback(() => store.read(scopeKey) ?? initialDraft, [initialDraft, scopeKey, store]);
  const draft = useSyncExternalStore(store.subscribe, getSnapshot, () => initialDraft);
  const isMutationBusy = useSyncExternalStore(store.subscribe, store.isMutationBusy, () => false);
  const setDraft = useCallback((update: SetStateAction<PropertyDraft>) => {
    // Persist synchronously in the input event; a fast navigation cannot outrun an effect.
    store.update(scopeKey, initialDraft, update);
  }, [initialDraft, scopeKey, store]);
  const resetDraft = useCallback(() => store.clear(scopeKey), [scopeKey, store]);
  const clearSubmittedDraft = useCallback((submittedDraft: PropertyDraft) => (
    store.clear(scopeKey, submittedDraft)
  ), [scopeKey, store]);

  return {
    draft, setDraft, resetDraft, clearSubmittedDraft, isDraftDirty: draft !== initialDraft,
    isMutationBusy, acquireMutation: store.acquireMutation, releaseMutation: store.releaseMutation,
  };
}
