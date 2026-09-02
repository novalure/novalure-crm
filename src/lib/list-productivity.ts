import type { CrmEntityKind } from "@/lib/list-query-state";

export const bulkActionKinds = [
  "assign_owner",
  "add_tags",
  "create_follow_up",
  "archive",
  "pause_portal",
] as const;

export type BulkActionKind = (typeof bulkActionKinds)[number];

export type BulkActionInput = Readonly<{
  action: BulkActionKind;
  entityIds: readonly string[];
  entityType: CrmEntityKind;
  payload: Readonly<Record<string, unknown>>;
  projectId?: string | null;
}>;

export type BulkActionValidation =
  | Readonly<{ ok: true; value: BulkActionInput }>
  | Readonly<{ error: string; ok: false }>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maxSelection = 100;
const actionsByEntity: Readonly<Partial<Record<CrmEntityKind, readonly BulkActionKind[]>>> = {
  contact: ["assign_owner", "add_tags", "create_follow_up", "archive"],
  deal: ["assign_owner", "add_tags", "create_follow_up"],
  lead: ["assign_owner", "add_tags", "create_follow_up"],
  organization: ["assign_owner", "add_tags"],
  property: ["assign_owner", "add_tags", "pause_portal"],
  task: ["assign_owner", "add_tags"],
};

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

export function normalizeTags(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .map(String)
      .map((tag) => tag.trim().replace(/\s+/g, " ").slice(0, 48))
      .filter(Boolean),
  )].slice(0, 20);
}

export function validateBulkAction(input: unknown): BulkActionValidation {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { error: "Bulk action payload must be an object.", ok: false };
  }
  const raw = input as Record<string, unknown>;
  const entityType = raw.entityType as CrmEntityKind;
  const action = raw.action as BulkActionKind;
  const allowedActions = actionsByEntity[entityType];

  if (!allowedActions?.includes(action)) {
    return { error: "Bulk action is not supported for this entity type.", ok: false };
  }
  if (!Array.isArray(raw.entityIds) || raw.entityIds.length === 0 || raw.entityIds.length > maxSelection) {
    return { error: `Select between 1 and ${maxSelection} records.`, ok: false };
  }
  const entityIds = [...new Set(raw.entityIds)];
  if (entityIds.length !== raw.entityIds.length || !entityIds.every(isUuid)) {
    return { error: "Every selected record must be a distinct UUID.", ok: false };
  }
  const projectId = raw.projectId === null || raw.projectId === undefined || raw.projectId === ""
    ? null
    : raw.projectId;
  if (projectId !== null && !isUuid(projectId)) {
    return { error: "Project scope must be a UUID.", ok: false };
  }
  const payload = raw.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)
    ? raw.payload as Record<string, unknown>
    : {};

  if (action === "assign_owner" && !isUuid(payload.ownerUserId)) {
    return { error: "A valid owner is required.", ok: false };
  }
  if (action === "add_tags" && normalizeTags(payload.tags).length === 0) {
    return { error: "At least one tag is required.", ok: false };
  }
  if (action === "create_follow_up") {
    const title = typeof payload.title === "string" ? payload.title.trim() : "";
    const dueAt = typeof payload.dueAt === "string" ? Date.parse(payload.dueAt) : Number.NaN;
    if (!title || title.length > 160 || !Number.isFinite(dueAt)) {
      return { error: "A title and valid due date are required for follow-up tasks.", ok: false };
    }
  }
  if ((action === "archive" || action === "pause_portal") && payload.confirmedCount !== entityIds.length) {
    return { error: "The confirmed record count does not match the selection.", ok: false };
  }

  return {
    ok: true,
    value: Object.freeze({ action, entityIds, entityType, payload, projectId }),
  };
}

export function requiresPrivilegedBulkRole(action: BulkActionKind) {
  return action === "archive" || action === "assign_owner" || action === "pause_portal";
}

export function sanitizeSavedViewState(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  const query = typeof value.query === "string" ? value.query.trim().replace(/\s+/g, " ").slice(0, 160) : "";
  if (query) result.query = query;
  if (Number.isSafeInteger(value.pageSize)) result.pageSize = Math.min(100, Math.max(1, Number(value.pageSize)));
  if (typeof value.sort === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value.sort)) result.sort = value.sort;
  if (value.direction === "asc" || value.direction === "desc") result.direction = value.direction;
  if (value.filters && typeof value.filters === "object" && !Array.isArray(value.filters)) {
    const filters: Record<string, string[]> = {};
    for (const [key, rawFilter] of Object.entries(value.filters as Record<string, unknown>)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(key) || !Array.isArray(rawFilter)) continue;
      const entries = [...new Set(rawFilter.map(String).map((entry) => entry.trim().slice(0, 120)).filter(Boolean))].slice(0, 20);
      if (entries.length) filters[key] = entries;
    }
    if (Object.keys(filters).length) result.filters = filters;
  }
  return result;
}
