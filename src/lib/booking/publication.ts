import "server-only";
import { randomUUID } from "node:crypto";
import type { AppSession } from "@/lib/auth/session";
import { getTrustedAppOrigin } from "@/lib/auth/app-origin";
import { queryRows } from "@/lib/db/client";
import type { TenantTransactionOptions } from "@/lib/db/tenant-client";
import { hasProductCapability, isProductRole } from "@/lib/product-model";
import { bookingAudit, withBookingTransaction } from "./repository";
import { readBookingSetup } from "./configuration";
import type { BookingCalendar } from "./connections";
import { validatedBookingFrameOrigin } from "./public-frame-policy";
import { assertBookingActivation } from "./activation";
import { BookingError, type BookingKind } from "./types";
import { bookingChannels, type BookingChannel, type BookingPublicationConfig, type BookingPublicationReadiness, type PublicBookingPublication } from "./publication-types";

export type StoredBookingPublication = { id: string; workspaceId: string; ownerId: string; config: BookingPublicationConfig; revision: number };
/** Request-local presentation data, never a substitute for transactional authorization. */
export type PreparedBookingPublication = { stored: StoredBookingPublication; channel?: BookingChannel; publication: PublicBookingPublication };
export const publicationUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function serverBookingSession(workspaceId: string, organizerId: string): AppSession {
  return { authenticated: true, workspaceId, userId: organizerId, workspaceName: "", email: "", name: "", role: "agent", productRole: "team_member", permissions: [], productPermissions: [], source: "database" };
}
export async function bookingBootstrapRows<T extends Record<string, unknown>>(sql: string, params: unknown[], options: TenantTransactionOptions = {}): Promise<T[]> {
  if (!options.pool) return queryRows<T>(sql, params);
  const client = await options.pool.connect();
  try { return (await client.query(sql, params)).rows as T[]; } finally { client.release(); }
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number, empty = false): value is string => typeof value === "string" && value.length <= max && (empty || value.trim().length > 0) && !/[\u0000-\u001f\u007f]/.test(value);
const kinds: BookingKind[] = ["phone", "teams", "meet", "office", "onsite"];
export function validateBookingPublication(value: unknown): BookingPublicationConfig {
  if (!object(value) || Object.keys(value).some(key => !["publicId", "enabled", "title", "description", "appearance", "language", "allowedOrigins", "channels", "assignments", "legacyMeetingPageIds"].includes(key)) ||
    typeof value.publicId !== "string" || !/^[a-z0-9][a-z0-9-]{10,79}$/.test(value.publicId) || typeof value.enabled !== "boolean" || !text(value.title, 120) || (typeof value.description !== "string" || value.description.length > 1000 || /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/.test(value.description)) ||
    !["light", "dark"].includes(String(value.appearance)) || !["auto", "de", "en"].includes(String(value.language)) || !object(value.channels) ||
    Object.keys(value.channels).some(key => !bookingChannels.includes(key as BookingChannel)) || bookingChannels.some(key => typeof (value.channels as Record<string, unknown>)[key] !== "boolean")) throw new BookingError("INVALID_PUBLICATION");
  if (!Array.isArray(value.allowedOrigins) || value.allowedOrigins.length > 20) throw new BookingError("INVALID_PUBLICATION_ORIGIN");
  const allowedOrigins = value.allowedOrigins.map(origin => {
    if (typeof origin !== "string" || origin.length > 300) throw new BookingError("INVALID_PUBLICATION_ORIGIN");
    if (!validatedBookingFrameOrigin(origin, process.env.NODE_ENV === "test")) throw new BookingError("INVALID_PUBLICATION_ORIGIN");
    return origin;
  });
  if (!Array.isArray(value.assignments) || value.assignments.length > 20 || value.enabled && value.assignments.length === 0) throw new BookingError("INVALID_PUBLICATION_ASSIGNMENTS");
  const seen = new Set<string>();
  const assignments = value.assignments.map(item => {
    if (!object(item) || Object.keys(item).some(key => !["id", "kind", "organizerId", "provider", "publicLocation"].includes(key)) || typeof item.id !== "string" || !publicationUuid.test(item.id) || seen.has(item.id) ||
      typeof item.organizerId !== "string" || !publicationUuid.test(item.organizerId) || !kinds.includes(item.kind as BookingKind) || !["microsoft", "google"].includes(String(item.provider)) ||
      item.kind === "teams" && item.provider !== "microsoft" || item.kind === "meet" && item.provider !== "google" || item.publicLocation !== undefined && !text(item.publicLocation, 500, true)) throw new BookingError("INVALID_PUBLICATION_ASSIGNMENTS");
    seen.add(item.id);
    return { id: item.id, kind: item.kind as BookingKind, organizerId: item.organizerId, provider: item.provider as "microsoft" | "google", ...(item.publicLocation !== undefined ? { publicLocation: item.publicLocation as string } : {}) };
  });
  const pages = value.legacyMeetingPageIds ?? [];
  if (!Array.isArray(pages) || pages.length > 30 || pages.some(id => typeof id !== "string" || !publicationUuid.test(id))) throw new BookingError("INVALID_PUBLICATION_LEGACY_PAGES");
  return { publicId: value.publicId, enabled: value.enabled, title: value.title.trim(), description: value.description.trim(), appearance: value.appearance as "light" | "dark", language: value.language as "auto" | "de" | "en",
    allowedOrigins: [...new Set(allowedOrigins)], channels: value.channels as BookingPublicationConfig["channels"], assignments, legacyMeetingPageIds: [...new Set(pages)] as string[] };
}
function draftPublication(): BookingPublicationConfig {
  return { publicId: `bk-${randomUUID()}`, enabled: false, title: "Terminbuchung", description: "", appearance: "light", language: "auto", allowedOrigins: [],
    channels: { link: false, inline: false, popup: false, form: false, chat: false, voice: false }, assignments: [], legacyMeetingPageIds: [] };
}

export async function lookupBookingPublication(publicId: string, options: TenantTransactionOptions = {}): Promise<StoredBookingPublication> {
  if (typeof publicId !== "string" || !/^[a-z0-9][a-z0-9-]{10,79}$/.test(publicId)) throw new BookingError("PUBLICATION_NOT_FOUND", 404);
  const row = (await bookingBootstrapRows<{ publication: StoredBookingPublication | null }>("select booking_publication_lookup($1) as publication", [publicId], options))[0]?.publication;
  if (!row) throw new BookingError("PUBLICATION_NOT_FOUND", 404);
  return row;
}

export async function lookupActiveWorkspaceBookingPublication(workspaceId: string, meetingPageId?: string, options: TenantTransactionOptions = {}): Promise<BookingPublicationConfig | null> {
  if (!publicationUuid.test(workspaceId) || meetingPageId !== undefined && !publicationUuid.test(meetingPageId)) throw new BookingError("INVALID_PUBLICATION_SCOPE");
  const row = (await bookingBootstrapRows<{ publication: { config: BookingPublicationConfig } | null }>("select booking_workspace_publication_lookup($1::uuid,$2::uuid) as publication", [workspaceId, meetingPageId ?? null], options))[0]?.publication;
  return row?.config ?? null;
}

export async function prepareBookingPublication(stored: StoredBookingPublication, channel?: BookingChannel, options: TenantTransactionOptions = {}, selectedKinds?: readonly BookingKind[]): Promise<PreparedBookingPublication> {
  const config = stored.config;
  if (!config.enabled || channel && !config.channels[channel]) throw new BookingError("PUBLICATION_NOT_FOUND", 404);
  const types: PublicBookingPublication["types"] = [];
  const assignments = config.assignments.filter(assignment => !selectedKinds || selectedKinds.includes(assignment.kind));
  const prepare = async (assignment: typeof assignments[number]) => {
    try {
      const { setup, organizerName } = await withBookingTransaction(serverBookingSession(stored.workspaceId, assignment.organizerId), async (tx, fresh) => {
        const member = await tx.queryOne<{ name: string }>(`select name from public.workspace_users
          where workspace_id=$1::uuid and id=$2::uuid and status='active'`, [fresh.workspaceId, fresh.userId]);
        return { setup: await readBookingSetup(tx, fresh, assignment.kind), organizerName: member?.name.trim() ?? "" };
      }, options);
      if (!organizerName || organizerName.length > 120 || /[@\u0000-\u001f\u007f]/.test(organizerName)) return null;
      return { id: assignment.id, kind: assignment.kind, organizerName, durationMinutes: setup.rules.durationMinutes, timeZone: setup.rules.timeZone, locationRequired: assignment.kind === "onsite", location: assignment.kind === "office" ? assignment.publicLocation ?? "" : "" };
    } catch { return null; /* An inactive organizer is never offered publicly. */ }
  };
  // Studio's independent type reads use separate tenant transactions, bounded to two.
  const width = selectedKinds ? 2 : 1;
  for (let offset = 0; offset < assignments.length; offset += width) {
    for (const prepared of await Promise.all(assignments.slice(offset, offset + width).map(prepare))) if (prepared) {
      types.push(prepared);
    }
  }
  return { stored, channel, publication: { publicId: config.publicId, title: config.title, description: config.description, appearance: config.appearance, language: config.language, allowedOrigins: config.allowedOrigins, channels: config.channels, types } };
}
export async function publicBookingPublication(stored: StoredBookingPublication, channel?: BookingChannel, options: TenantTransactionOptions = {}): Promise<PublicBookingPublication> {
  return (await prepareBookingPublication(stored, channel, options)).publication;
}
export async function getPublicBookingPublication(publicId: string, channel?: BookingChannel, options: TenantTransactionOptions = {}) {
  return publicBookingPublication(await lookupBookingPublication(publicId, options), channel, options);
}

async function readiness(stored: StoredBookingPublication, options: TenantTransactionOptions = {}): Promise<BookingPublicationReadiness> {
  const rows: BookingPublicationReadiness["assignments"] = [];
  for (const assignment of stored.config.assignments) {
    const errors: string[] = []; let calendar = false, maps = false, mail = false;
    try {
      const session = serverBookingSession(stored.workspaceId, assignment.organizerId);
      await withBookingTransaction(session, async (tx, fresh) => {
        const setup = await readBookingSetup(tx, fresh, assignment.kind);
        const connection = await tx.queryOne<{id:string;status:string;accountId:string|null;writeCalendarId:string|null;calendars:BookingCalendar[]}>(`select id,status,account_id as "accountId",write_calendar_id as "writeCalendarId",calendars from booking_calendar_connections where workspace_id=$1 and user_id=$2 and provider=$3`,[fresh.workspaceId,fresh.userId,assignment.provider]);
        const selected = connection?.calendars.find(item => item.id === connection.writeCalendarId);
        calendar = connection?.status === "connected" && !!selected?.canWrite && (assignment.kind !== "teams" || selected.teamsSupported) && (assignment.kind !== "meet" || selected.meetSupported);
        if (calendar && connection?.writeCalendarId) {
          await assertBookingActivation({ workspaceId: stored.workspaceId, actorId: assignment.organizerId }, { provider: assignment.provider, connectionId: connection.id, accountId: connection.accountId, calendarId: connection.writeCalendarId }, {...options,tx});
        }
        maps = !setup.travel.enabled || !!process.env.GOOGLE_MAPS_ROUTES_API_KEY;
        mail = !setup.communication.enabled || process.env.BOOKING_MESSAGES_ENABLED === "1" && !!process.env.RESEND_API_KEY && !!(process.env.RESEND_FROM || process.env.NOVALURE_EMAIL_FROM);
        if (assignment.kind === "office" && (!assignment.publicLocation || assignment.publicLocation.trim() !== setup.rules.location.trim())) errors.push("PUBLIC_OFFICE_LOCATION_REQUIRED");
      }, options);
    } catch (error) { errors.push(error instanceof BookingError ? error.code : "ORGANIZER_NOT_READY"); }
    if (!calendar) errors.push("CALENDAR_NOT_READY"); if (!maps) errors.push("MAPS_NOT_READY"); if (!mail) errors.push("MAIL_NOT_READY");
    rows.push({ id: assignment.id, calendar, maps, mail, ready: calendar && maps && mail && errors.length === 0, errors: [...new Set(errors)] });
  }
  return { canPublish: rows.length > 0 && rows.every(row => row.ready), assignments: rows };
}
export async function getBookingPublication(session: AppSession, options: TenantTransactionOptions = {}) {
  const local = await withBookingTransaction(session, async (tx, fresh) => {
    if (!fresh.productPermissions.includes("workspace:admin")) throw new BookingError("BOOKING_PUBLICATION_FORBIDDEN", 403);
    const stored = await tx.queryOne<StoredBookingPublication>('select id,workspace_id as "workspaceId",owner_id as "ownerId",config,revision::int from booking_publications where workspace_id=$1', [fresh.workspaceId]);
    const employees = (await tx.query<{ id: string; name: string; productRole: string }>(`select id,name,product_role as "productRole" from workspace_users where workspace_id=$1 and status='active' and role in ('owner','admin','agent') order by name,id`, [fresh.workspaceId])).filter(row => isProductRole(row.productRole) && hasProductCapability(row.productRole, "calendar:manage")).map(({ id, name }) => ({ id, name }));
    return { stored: stored ?? { id: randomUUID(), workspaceId: fresh.workspaceId, ownerId: fresh.userId, config: draftPublication(), revision: 0 }, employees };
  }, options);
  const origin = new URL(getTrustedAppOrigin()).origin;
  return { publication: local.stored.config, revision: local.stored.revision, employees: local.employees, readiness: await readiness(local.stored, options), bookingUrl: `${origin}/appointments/${local.stored.config.publicId}`, embedOrigin: origin };
}
export async function saveBookingPublication(session: AppSession, input: { publication: BookingPublicationConfig; expectedRevision?: number }, options: TenantTransactionOptions = {}) {
  const config = validateBookingPublication(input.publication);
  if (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)) throw new BookingError("INVALID_PUBLICATION_REVISION");
  const stored = await withBookingTransaction(session, async (tx, fresh) => {
    if (!fresh.productPermissions.includes("workspace:admin")) throw new BookingError("BOOKING_PUBLICATION_FORBIDDEN", 403);
    await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`booking-workspace:${fresh.workspaceId}`]);
    const previous = await tx.queryOne<{ id: string; publicId: string; revision: number }>('select id,public_id as "publicId",revision::int from booking_publications where workspace_id=$1 for update', [fresh.workspaceId]);
    if (previous && previous.publicId !== config.publicId || input.expectedRevision !== undefined && input.expectedRevision !== (previous?.revision ?? 0)) throw new BookingError("BOOKING_PUBLICATION_CHANGED", 409);
    const people = await tx.query<{ id: string }>(`select id from workspace_users where workspace_id=$1 and id=any($2::uuid[]) and status='active' and role in ('owner','admin','agent')`, [fresh.workspaceId, config.assignments.map(item => item.organizerId)]);
    if (config.assignments.some(item => !people.some(person => person.id === item.organizerId))) throw new BookingError("INVALID_PUBLICATION_ASSIGNMENTS");
    if (config.legacyMeetingPageIds?.length) {
      const pages = await tx.queryOne<{allowed:boolean}>("select booking_publication_legacy_pages_allowed($1,$2::uuid[]) as allowed", [fresh.workspaceId, config.legacyMeetingPageIds]);
      if (!pages?.allowed) throw new BookingError("INVALID_PUBLICATION_LEGACY_PAGES");
    }
    const id = previous?.id ?? randomUUID();
    const saved = await tx.queryOne<StoredBookingPublication>(`insert into booking_publications(id,workspace_id,owner_id,public_id,enabled,config) values($1,$2,$3,$4,$5,$6::jsonb)
      on conflict(workspace_id) do update set config=excluded.config,enabled=excluded.enabled,revision=booking_publications.revision+1,updated_at=now()
      returning id,workspace_id as "workspaceId",owner_id as "ownerId",config,revision::int`, [id, fresh.workspaceId, fresh.userId, config.publicId, false, JSON.stringify({ ...config, enabled: false })]);
    await tx.execute("update booking_publication_assignments set enabled=false where workspace_id=$1 and publication_id=$2", [fresh.workspaceId, id]);
    for (const assignment of config.assignments) {
      const changed = await tx.queryOne<{ id: string }>(`insert into booking_publication_assignments(id,workspace_id,publication_id,organizer_id,kind,provider) values($1,$2,$3,$4,$5,$6)
        on conflict(id) do update set organizer_id=excluded.organizer_id,kind=excluded.kind,provider=excluded.provider,enabled=true
        where booking_publication_assignments.workspace_id=excluded.workspace_id and booking_publication_assignments.publication_id=excluded.publication_id returning id`, [assignment.id, fresh.workspaceId, id, assignment.organizerId, assignment.kind, assignment.provider]);
      if (!changed) throw new BookingError("INVALID_PUBLICATION_ASSIGNMENTS");
    }
    await bookingAudit(tx, fresh, "booking.publication_saved", id, { enabled: config.enabled, revision: saved!.revision });
    return saved!;
  }, options);
  // Saving a draft is always possible. Enabling is gated by actual persisted readiness.
  const checked = await readiness(stored, options);
  if (config.enabled) {
    if (!checked.canPublish) throw new BookingError("PUBLICATION_NOT_READY", 409);
    await withBookingTransaction(session, async (tx, fresh) => {
      if (!fresh.productPermissions.includes("workspace:admin")) throw new BookingError("BOOKING_PUBLICATION_FORBIDDEN", 403);
      await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))",[`booking-workspace:${fresh.workspaceId}`]);
      const activated = await tx.queryOne("update booking_publications set enabled=true,config=jsonb_set(config,'{enabled}','true'::jsonb),published_at=coalesce(published_at,now()),legacy_meeting_page_ids=array(select distinct value from unnest(legacy_meeting_page_ids||array(select jsonb_array_elements_text(coalesce(config->'legacyMeetingPageIds','[]'::jsonb)))::uuid[]) value),revision=revision+1,updated_at=now() where workspace_id=$1 and id=$2 and revision=$3 returning id", [stored.workspaceId, stored.id, stored.revision]);
      if (!activated) throw new BookingError("BOOKING_PUBLICATION_CHANGED", 409);
      await tx.execute(`insert into booking_publication_organizer_cutovers(workspace_id,organizer_id,publication_id)
        select distinct workspace_id,organizer_id,publication_id from booking_publication_assignments
        where workspace_id=$1 and publication_id=$2 and enabled on conflict(workspace_id,organizer_id) do nothing`,[stored.workspaceId,stored.id]);
    }, options);
  }
  return getBookingPublication(session, options);
}
