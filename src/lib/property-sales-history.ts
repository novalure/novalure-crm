export const propertySalesHistoryKinds = [
  "reservation.request", "reservation.confirm", "reservation.extend", "reservation.expire", "reservation.withdraw", "unit.audit",
] as const;
export type PropertySalesHistoryKind = (typeof propertySalesHistoryKinds)[number];
export type PropertySalesHistoryItem = {
  id: string;
  source: "reservation_command" | "unit_audit";
  kind: PropertySalesHistoryKind;
  occurredAt: string;
  actor: { id: string | null; name: string | null };
  unitId: string;
  reservationId: string | null;
  status: { before: string | null; after: string | null };
  expiresAt: { before: string | null; after: string | null };
  reservationVersion: number | null;
  unitVersion: number | null;
  taskId: string | null;
  sourceReference: string | null;
};
export type PropertySalesHistoryPage = {
  workspaceId: string;
  projectId: string;
  unitId: string;
  reservationId: string | null;
  items: PropertySalesHistoryItem[];
  nextCursor: string | null;
  coverage: "RECORDED_EVENTS_ONLY";
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const nullableUuid = (value: unknown) => value === null || (typeof value === "string" && uuid.test(value));
const timestamp = (value: unknown) => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(value) && Number.isFinite(Date.parse(value));
const nullableTime = (value: unknown) => value === null || timestamp(value);
const nullableVersion = (value: unknown) => value === null || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
const statuses = new Set(["requested", "hold", "reserved", "expired", "converted", "withdrawn", "available", "sold", "blocked"]);
const nullableStatus = (value: unknown) => value === null || (typeof value === "string" && statuses.has(value));
const unitStatus = (value: unknown) => value === null || (typeof value === "string" && ["available", "reserved", "sold", "blocked"].includes(value));
const reservationStatus = (value: unknown) => value === null || (typeof value === "string" && ["requested", "hold", "reserved", "expired", "converted", "withdrawn"].includes(value));

/** Client boundary validation; authorization and cursor scope are always enforced by the server. */
export function isPropertySalesHistoryPage(value: unknown): value is PropertySalesHistoryPage {
  if (!object(value) || ![value.workspaceId, value.projectId, value.unitId].every(id => typeof id === "string" && uuid.test(id))
    || !nullableUuid(value.reservationId) || value.coverage !== "RECORDED_EVENTS_ONLY"
    || !(value.nextCursor === null || (typeof value.nextCursor === "string" && value.nextCursor.length <= 1200 && /^[A-Za-z0-9_-]+$/.test(value.nextCursor)))
    || !Array.isArray(value.items) || value.items.length > 40) return false;
  return value.items.every(item => object(item) && typeof item.id === "string" && uuid.test(item.id)
    && (item.source === "reservation_command" || item.source === "unit_audit")
    && propertySalesHistoryKinds.includes(item.kind as PropertySalesHistoryKind)
    && (item.source === "unit_audit" ? item.kind === "unit.audit" : item.kind !== "unit.audit")
    && timestamp(item.occurredAt) && item.unitId === value.unitId && nullableUuid(item.reservationId)
    && (value.reservationId === null || item.reservationId === value.reservationId)
    && object(item.actor) && nullableUuid(item.actor.id) && (item.actor.name === null || (typeof item.actor.name === "string" && item.actor.name.length <= 200))
    && object(item.status) && nullableStatus(item.status.before) && nullableStatus(item.status.after)
    && (item.source !== "unit_audit" || (unitStatus(item.status.before) && unitStatus(item.status.after)))
    && (item.source !== "reservation_command" || (reservationStatus(item.status.before) && reservationStatus(item.status.after)))
    && object(item.expiresAt) && nullableTime(item.expiresAt.before) && nullableTime(item.expiresAt.after)
    && nullableVersion(item.reservationVersion) && nullableVersion(item.unitVersion) && nullableUuid(item.taskId)
    && (item.sourceReference === null || (typeof item.sourceReference === "string" && item.sourceReference.length <= 2000)));
}
