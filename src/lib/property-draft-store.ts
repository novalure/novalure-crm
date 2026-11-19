import type { PropertyPriceVisibility } from "./crm-types";
import type { JSONContent } from "@tiptap/react";
import type { PropertyEnergyCertificate, PropertyGeography } from "./property-country";
import type { PropertyDetails } from "./property-details";
import type { PropertyCostEditorDraft } from "./property-cost-editing";

export type PropertyCostDraft = {
  costKey: string;
  groupKey: string;
  label: string;
  monthlyGross: string;
  monthlyNet: string;
  monthlyVat: string;
  oneTimeGross: string;
  oneTimeNet: string;
  oneTimeVat: string;
  exposeVisible: boolean;
};

export type PropertyDraft = {
  costEditor?: PropertyCostEditorDraft;
  coreEdit?: { propertyId: string; workspaceId: string; expected: Record<string, unknown>; expectedAncillaryCosts?: Record<string, unknown>; expectedGeography?: Record<string, unknown> | null; expectedEnergyCertificate?: Record<string, unknown> | null; expectedUsageType?: string; expectedFullSnapshot?: Record<string,unknown> };
  propertyDetails?: PropertyDetails;
  city?: string;
  street?: string;
  internalNotes?: string;
  geography?: PropertyGeography | null;
  energyCertificate?: PropertyEnergyCertificate;
  address: string;
  areaSqm: string;
  availableFrom: string;
  availableFromText: string;
  availabilityNote: string;
  channelPriceVisibility: Record<string, PropertyPriceVisibility>;
  contactEmail: string;
  contactName: string;
  contactPhone: string;
  costItems: PropertyCostDraft[];
  fieldValues: Record<string, string>;
  gdprStatus: string;
  internalReference: string;
  marketingType: string;
  monthlyCostsGross: string;
  objectType: string;
  objectNumber: string;
  portalMappingStatus: string;
  postalCode: string;
  price: string;
  priceVisibility: PropertyPriceVisibility;
  projectId: string;
  publicPrice: string;
  purchaseAncillaryCosts: string;
  purchaseAncillaryMode?: "percentage" | "manual";
  purchaseAncillaryRate?: string;
  region: string;
  rentNet: string;
  rentPrice: string;
  rooms: string;
  subObjectType: string;
  textBlocks: Record<string, string>;
  textDocuments?: Record<string, JSONContent | undefined>;
  title: string;
  usageType: string;
  yearBuilt: string;
};

export type PropertyDraftScope = {
  workspaceId: string;
  userId: string;
  projectId: string | null;
};

export function propertyDraftScopeKey(scope: PropertyDraftScope): string {
  return JSON.stringify([scope.userId, scope.workspaceId, scope.projectId]);
}

// A fresh draft and a draft whose values were fully reverted are both clean.
// Compare record keys independently of insertion order (e.g. optional fields).
function stableDraftValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableDraftValue).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([, item]) => item !== "" && item !== undefined).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableDraftValue(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

type DraftEntry = { draft: PropertyDraft; baseline: PropertyDraft };

export type PropertyCreateAttempt = {
  workspaceId: string;
  projectId: string;
  endpoint: string;
  body: string;
  key: string;
  correlation: string;
  submittedDraft: PropertyDraft;
  phase: "in_flight" | "uncertain";
};

/** One instance per mounted CRM session. Never writes customer inputs to browser storage. */
export function createPropertyDraftStore(ownerUserId?: string) {
  const entries = new Map<string, DraftEntry>();
  const createAttempts = new Map<string, PropertyCreateAttempt>();
  const listeners = new Set<() => void>();
  let activeMutation: symbol | null = null;
  const notify = () => listeners.forEach((listener) => listener());

  return {
    ownerUserId,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    read(scopeKey: string): PropertyDraft | undefined {
      return entries.get(scopeKey)?.draft;
    },
    hasDrafts() {
      return entries.size > 0 || createAttempts.size > 0;
    },
    readCreateAttempt(scopeKey: string) {
      return createAttempts.get(scopeKey);
    },
    hasCreateAttemptOutside(scopeKey: string) {
      return [...createAttempts.keys()].some((key) => key !== scopeKey);
    },
    setCreateAttempt(scopeKey: string, attempt: PropertyCreateAttempt) {
      createAttempts.set(scopeKey, attempt);
      notify();
    },
    markCreateUncertain(scopeKey: string, expectedKey: string) {
      const current = createAttempts.get(scopeKey);
      if (current?.key !== expectedKey) return false;
      createAttempts.set(scopeKey, { ...current, phase: "uncertain" });
      notify();
      return true;
    },
    clearCreateAttempt(scopeKey: string, expectedKey: string) {
      if (createAttempts.get(scopeKey)?.key !== expectedKey) return false;
      createAttempts.delete(scopeKey);
      notify();
      return true;
    },
    isMutationBusy() {
      return activeMutation !== null;
    },
    acquireMutation(): symbol | null {
      if (activeMutation !== null) return null;
      activeMutation = Symbol("property-mutation");
      notify();
      return activeMutation;
    },
    releaseMutation(token: symbol): boolean {
      if (activeMutation !== token) return false;
      activeMutation = null;
      notify();
      return true;
    },
    update(
      scopeKey: string,
      initialDraft: PropertyDraft,
      update: PropertyDraft | ((current: PropertyDraft) => PropertyDraft),
    ): PropertyDraft {
      const entry = entries.get(scopeKey);
      const current = entry?.draft ?? initialDraft;
      const next = typeof update === "function" ? update(current) : update;
      const baseline = entry?.baseline ?? initialDraft;
      if (stableDraftValue(next) === stableDraftValue(baseline)) {
        if (entries.delete(scopeKey)) notify();
        return initialDraft;
      }
      entries.set(scopeKey, { baseline, draft: next });
      notify();
      return next;
    },
    clear(scopeKey: string, submittedDraft?: PropertyDraft): boolean {
      const entry = entries.get(scopeKey);
      // A delayed save must not erase edits made after that request started.
      if (submittedDraft && entry?.draft !== submittedDraft) return false;
      const removed = entries.delete(scopeKey);
      if (removed) notify();
      return removed;
    },
    clearAll() {
      if (!entries.size && !createAttempts.size && !activeMutation) return;
      entries.clear();
      createAttempts.clear();
      activeMutation = null;
      notify();
    },
  };
}

export type PropertyDraftStore = ReturnType<typeof createPropertyDraftStore>;

export function protectPropertyDraftUnload(
  store: PropertyDraftStore,
  event: Pick<BeforeUnloadEvent, "preventDefault" | "returnValue">,
): boolean {
  if (!store.hasDrafts() && !store.isMutationBusy()) return false;
  event.preventDefault();
  event.returnValue = "";
  return true;
}

export function getPropertyDraftCopy(language: string) {
  return language === "de" ? {
    heading: "Ungespeicherter Entwurf",
    body: "Deine Eingaben bleiben beim Wechsel zwischen CRM-Bereichen erhalten – getrennt nach Workspace und Projektfilter. Sie sind noch nicht in der Datenbank gespeichert und gehen beim Neuladen, Schließen oder Abmelden verloren.",
    resume: "Entwurf weiterbearbeiten",
    discard: "Entwurf verwerfen",
    discardConfirmation: "Diesen ungespeicherten Immobilienentwurf wirklich verwerfen? Die Eingaben können nicht wiederhergestellt werden.",
    logoutConfirmation: "Es gibt ungespeicherte Immobilienentwürfe. Beim Abmelden gehen diese Eingaben verloren. Trotzdem abmelden?",
  } : {
    heading: "Unsaved draft",
    body: "Your inputs are kept when switching CRM sections, separately for each workspace and project filter. They are not saved to the database and will be lost on reload, close or sign-out.",
    resume: "Continue editing draft",
    discard: "Discard draft",
    discardConfirmation: "Discard this unsaved property draft? These inputs cannot be recovered.",
    logoutConfirmation: "You have unsaved property drafts. Signing out will lose these inputs. Sign out anyway?",
  };
}
