import type { Project, PropertyBuilding } from "@/lib/crm-types";
import { parsePropertyEuroCents } from "@/lib/property-money";
import { parsePropertyAreaSqm } from "@/lib/property-area-input";

export type UnitInventoryMode = "building" | "unit";

export type UnitInventoryDraft = {
  address: string;
  areaSqm: string;
  buildingId: string;
  floor: string;
  floors: string;
  name: string;
  price: string;
  projectId: string;
  rooms: string;
  unitNumber: string;
};

export function createUnitInventoryDraft(projectId = ""): UnitInventoryDraft {
  return { address: "", areaSqm: "", buildingId: "", floor: "", floors: "", name: "", price: "", projectId, rooms: "", unitNumber: "" };
}

export function updateUnitInventoryDraft<Key extends keyof UnitInventoryDraft>(
  draft: UnitInventoryDraft,
  key: Key,
  value: UnitInventoryDraft[Key],
): UnitInventoryDraft {
  return key === "projectId" && value !== draft.projectId
    ? { ...draft, projectId: value, buildingId: "" }
    : { ...draft, [key]: value };
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decimalInput = /^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function inventoryPayload(draft: UnitInventoryDraft, mode: UnitInventoryMode) {
  const common = { operation: mode, projectId: draft.projectId };
  if (mode === "building") {
    if (!draft.name.trim()) throw new Error("unit_inventory_invalid");
    return { ...common, address: draft.address, floors: draft.floors, name: draft.name };
  }
  // Number controls emit ungrouped dot decimals. Do not interpret a third
  // decimal place as German thousands grouping in the shared money parser.
  if (!draft.unitNumber.trim()
    || (draft.price.trim() && (!decimalInput.test(draft.price.trim()) || parsePropertyEuroCents(draft.price) === null))
    || (draft.areaSqm.trim() && (!decimalInput.test(draft.areaSqm.trim()) || parsePropertyAreaSqm(draft.areaSqm) === null))) {
    throw new Error("unit_inventory_invalid");
  }
  return { ...common, areaSqm: draft.areaSqm, buildingId: draft.buildingId, floor: draft.floor, price: draft.price, rooms: draft.rooms, unitNumber: draft.unitNumber };
}

function matchesReceipt(value: unknown, draft: UnitInventoryDraft, mode: UnitInventoryMode, workspaceId: string) {
  const data = record(value);
  if (!data || typeof data.id !== "string" || !uuidPattern.test(data.id)
    || data.workspaceId !== workspaceId || data.projectId !== draft.projectId) return false;
  if (mode === "building") {
    return data.name === draft.name.trim() && data.address === draft.address.trim()
      && data.floors === Number(draft.floors || 0);
  }
  return data.unitNumber === draft.unitNumber.trim() && data.buildingId === draft.buildingId
    && data.priceCents === (draft.price.trim() ? parsePropertyEuroCents(draft.price) : 0)
    && data.areaSqm === (draft.areaSqm.trim() ? parsePropertyAreaSqm(draft.areaSqm) : 0)
    && data.floor === Number(draft.floor || 0) && data.rooms === Number(draft.rooms || 0);
}

/** The component's ref is acquired synchronously and held through the refresh. */
export async function saveUnitInventoryDraft(input: {
  buildings: Pick<PropertyBuilding, "id" | "workspaceId" | "projectId">[];
  draft: UnitInventoryDraft;
  lock: { current: boolean };
  mode: UnitInventoryMode;
  onChanged?: () => Promise<boolean | void> | boolean | void;
  onSaved: (blankDraft: UnitInventoryDraft) => void;
  projects: Pick<Project, "id" | "workspaceId">[];
  request: typeof fetch;
  workspaceId: string;
}): Promise<{ kind: "busy" | "saved" | "saved_refresh_failed" }> {
  if (input.lock.current) return { kind: "busy" };
  input.lock.current = true;
  try {
    const draft = { ...input.draft };
    const { mode, workspaceId } = input;
    if (!uuidPattern.test(workspaceId) || !uuidPattern.test(draft.projectId)
      || !input.projects.some((project) => project.id === draft.projectId && project.workspaceId === workspaceId)
      || (mode === "unit" && draft.buildingId && !input.buildings.some((building) =>
        building.id === draft.buildingId && building.projectId === draft.projectId && building.workspaceId === workspaceId))) {
      throw new Error("unit_inventory_scope");
    }
    const payload = inventoryPayload(draft, mode);
    const response = await input.request(`/api/crm/units?${new URLSearchParams({ workspaceId })}`, {
      body: JSON.stringify(payload), headers: { "Content-Type": "application/json" }, method: "POST",
    });
    const body = record(await response.json().catch(() => null));
    if (!response.ok) {
      throw new Error(response.status === 409 && body?.code === "UNIT_ALREADY_EXISTS"
        ? "UNIT_ALREADY_EXISTS" : "unit_inventory_unconfirmed");
    }
    if (body?.persisted !== true || !matchesReceipt(body.data, draft, mode, workspaceId)) {
      throw new Error("unit_inventory_unconfirmed");
    }
    input.onSaved(createUnitInventoryDraft(draft.projectId));
    try {
      if (await input.onChanged?.() === false) return { kind: "saved_refresh_failed" };
      return { kind: "saved" };
    } catch {
      return { kind: "saved_refresh_failed" };
    }
  } finally {
    input.lock.current = false;
  }
}

export function unitInventoryErrorMessage(error: unknown, language: string, fallback: string) {
  const code = error instanceof Error ? error.message : "";
  if (code === "UNIT_ALREADY_EXISTS") return language === "de"
    ? "Diese Einheitennummer existiert bereits in diesem Projekt. Bitte öffnen Sie die vorhandene Einheit oder wählen Sie eine andere Nummer. Ihre Eingaben bleiben erhalten."
    : "This unit number already exists in this project. Open the existing unit or choose a different number. Your entries have been kept.";
  if (code === "unit_inventory_scope") return language === "de"
    ? "Bitte wählen Sie ein Projekt und gegebenenfalls ein Gebäude aus dem aktiven Workspace. Ihre Eingaben bleiben erhalten."
    : "Select a project and, if applicable, a building in the active workspace. Your entries have been kept.";
  if (code === "unit_inventory_invalid") return language === "de"
    ? "Bitte prüfen Sie die Pflichtfelder sowie Preis und Fläche: nicht negativ und höchstens zwei Nachkommastellen. Ihre Eingaben bleiben erhalten."
    : "Check the required fields, price and area: non-negative values with at most two decimal places. Your entries have been kept.";
  return fallback;
}

export function unitInventoryRefreshMessage(language: string) {
  return language === "de"
    ? "Gespeichert. Die Ansicht konnte nicht aktualisiert werden. Bitte aktualisieren Sie die Seite, bevor Sie weitere Einheiten anlegen."
    : "Saved. The view could not be refreshed. Refresh the page before creating further units.";
}
