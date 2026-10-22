import "server-only";

import type { AppSession } from "@/lib/auth/session";
import { assertProjectGrant, CrmCommandError, withCrmRead, type TenantTransaction, type TenantTransactionOptions } from "@/lib/crm-command";
import { createPublicSiteKey, normalizeExternalOrigin, type ExternalIntegrationMode } from "@/lib/db/external-integration-gateway";
import { KnowledgeCenterError, knowledgeId, knowledgeText } from "@/lib/knowledge-center/policy";
import { knowledgeInternals } from "@/lib/knowledge-center/repository";
import { hasProductCapability, isProductRole } from "@/lib/product-model";
import type { BookingKind } from "@/lib/booking/types";
import type { BookingPublicationConfig } from "@/lib/booking/publication-types";

const chatCapabilities = ["chat.start", "chat.context", "chat.message"] as const;
const statuses = ["test", "active", "disabled", "revoked"] as const;
type IntegrationStatus = typeof statuses[number];
type Widget = Record<string, unknown>;
export type WebsiteIntegrationReadiness = { ready: boolean; code: string | null; message: string | null; publishedSources: number };
export type WebsiteBookingGrant = { enabled: true; publicId: string; channels: ["chat"]; typeIds: string[] };
export type WebsiteBookingOptions = { canManage: boolean; publication: { publicId: string; types: { id: string; kind: BookingKind; organizerName: string }[] } | null };
type IntegrationRow = {
  id: string; publicSiteKey: string; projectId: string | null; formId: string | null;
  integrationType: string; status: IntegrationStatus; mode: ExternalIntegrationMode;
  allowedOrigins: string[]; capabilities: string[]; configuration: Record<string, unknown>;
  updatedAt: string; widget: Widget;
};
export type ManagedWebsiteIntegration = Omit<IntegrationRow, "configuration"> & {
  knowledgeAssistantId: string | null; readiness: WebsiteIntegrationReadiness; booking: WebsiteBookingGrant | null;
};
export const websiteIntegrationCreateFields = ["projectId", "knowledgeAssistantId", "allowedOrigins", "mode", "widget", "integrationType", "capabilities", "formId"] as const;
export const websiteIntegrationUpdateFields = ["integrationId", "expectedUpdatedAt", "knowledgeAssistantId", "allowedOrigins", "mode", "status", "widget", "booking"] as const;
const widgetFields = ["brandName", "assistantName", "assistantAvatarReference", "primaryColor", "widgetPosition", "language", "welcomeMessage"] as const;

function fail(code: string, message: string, status = 400): never { throw new KnowledgeCenterError(code, message, status); }
function fields(input: Record<string, unknown>, allowed: readonly string[]) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) fail("UNKNOWN_FIELD", "Unbekanntes Feld in der Website-Verbindung.");
}
function permissions(session: AppSession) {
  const canPause = session.permissions.includes("crm:write") && hasProductCapability(session.productRole, "settings:manage");
  return { canManage: canPause && hasProductCapability(session.productRole, "bots:publish"), canPause };
}
function authorize(session: AppSession, write = false, assistant = false) {
  if (!session.permissions.includes(write ? "crm:write" : "crm:read") || !hasProductCapability(session.productRole, "settings:manage") || (assistant && !hasProductCapability(session.productRole, "bots:publish"))) fail("FORBIDDEN", "Für diese Website-Verbindung fehlen die Verwaltungsrechte.", 403);
}
function optionalId(value: unknown, label: string) { return value === null || value === undefined ? null : knowledgeId(value, label); }
function storedAssistant(row: IntegrationRow) { const value = row.configuration.knowledgeAssistantId; return typeof value === "string" ? value : null; }
function origins(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) fail("VALIDATION_ERROR", "Bitte 1 bis 20 genaue HTTPS-Domains angeben.");
  return [...new Set(value.map(item => {
    if (typeof item !== "string" || item.includes("*")) fail("VALIDATION_ERROR", "Nur genaue HTTPS-Domains ohne Platzhalter sind erlaubt.");
    let origin: string;
    try { origin = normalizeExternalOrigin(item.trim()); } catch { fail("VALIDATION_ERROR", "Eine HTTPS-Domain ohne Pfad, Zugangsdaten oder Parameter ist erforderlich."); }
    if (!origin.startsWith("https://")) fail("VALIDATION_ERROR", "Die Website-Verbindung benötigt HTTPS.");
    return origin;
  }))];
}
const bookingId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function storedBooking(row: IntegrationRow): WebsiteBookingGrant | null {
  const value = row.configuration.booking;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const grant = value as Record<string, unknown>;
  if (grant.enabled !== true || typeof grant.publicId !== "string" || !/^[a-z0-9][a-z0-9-]{10,79}$/.test(grant.publicId) ||
    !Array.isArray(grant.channels) || !grant.channels.includes("chat") || !Array.isArray(grant.typeIds) ||
    !grant.typeIds.length || grant.typeIds.length > 50 || grant.typeIds.some(id => typeof id !== "string" || !bookingId.test(id))) return null;
  return { enabled: true, publicId: grant.publicId, channels: ["chat"], typeIds: [...new Set(grant.typeIds as string[])] };
}
function bookingPatch(value: unknown): { enabled: false } | Omit<WebsiteBookingGrant, "channels"> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("VALIDATION_ERROR", "Ungültige Buchungsfreigabe.");
  const input = value as Record<string, unknown>; fields(input, ["enabled", "publicId", "typeIds"]);
  if (input.enabled === false && Object.keys(input).length === 1) return { enabled: false };
  if (input.enabled !== true || typeof input.publicId !== "string" || !/^[a-z0-9][a-z0-9-]{10,79}$/.test(input.publicId) ||
    !Array.isArray(input.typeIds) || !input.typeIds.length || input.typeIds.length > 20 ||
    input.typeIds.some(id => typeof id !== "string" || !bookingId.test(id)) || new Set(input.typeIds).size !== input.typeIds.length) {
    fail("VALIDATION_ERROR", "Bitte veröffentlichte Terminarten für die Buchungsfreigabe auswählen.");
  }
  return { enabled: true, publicId: input.publicId, typeIds: input.typeIds as string[] };
}
function canManageBooking(session: AppSession) {
  return !session.serviceIdentity && permissions(session).canManage && hasProductCapability(session.productRole, "calendar:manage") && session.productPermissions.includes("workspace:admin");
}
async function bookingOptions(tx: TenantTransaction, session: AppSession, lock = false): Promise<WebsiteBookingOptions & { allowedOrigins: string[] }> {
  const canManage = canManageBooking(session), empty = { canManage: false, publication: null, allowedOrigins: [] };
  if (!canManage) return empty;
  const calendarModule = await tx.queryOne<{ enabled: boolean }>("select enabled from public.workspace_module_settings where workspace_id=$1::uuid and module_key='calendar'", [session.workspaceId]);
  if (calendarModule?.enabled !== true) return empty;
  const publication = await tx.queryOne<{ id: string; config: BookingPublicationConfig }>(`select id,config from public.booking_publications
    where workspace_id=$1::uuid and enabled and (config->>'enabled')::boolean and (config->'channels'->>'chat')::boolean${lock ? " for share" : ""}`, [session.workspaceId]);
  if (!publication) return { canManage: true, publication: null, allowedOrigins: [] };
  const assignments = await tx.query<{ id: string; organizerId: string; kind: string; provider: string; organizerName: string; productRole: string }>(`select a.id,a.organizer_id as "organizerId",a.kind,a.provider,u.name as "organizerName",u.product_role as "productRole"
    from public.booking_publication_assignments a join public.workspace_users u on u.id=a.organizer_id and u.workspace_id=a.workspace_id
    where a.workspace_id=$1::uuid and a.publication_id=$2::uuid and a.enabled and u.status='active' and u.role in ('owner','admin','agent')${lock ? " for share of a" : ""}`, [session.workspaceId, publication.id]);
  const types = assignments.flatMap(row => {
    const configured = publication.config.assignments.find(item => item.id === row.id);
    return configured && configured.organizerId === row.organizerId && configured.kind === row.kind && configured.provider === row.provider &&
      isProductRole(row.productRole) && hasProductCapability(row.productRole, "calendar:manage")
      ? [{ id: row.id, kind: configured.kind, organizerName: row.organizerName }] : [];
  });
  return { canManage: true, publication: { publicId: publication.config.publicId, types }, allowedOrigins: publication.config.allowedOrigins };
}
function removeBooking(row: IntegrationRow) {
  // The capability existed before chat booking. Leave separately configured
  // appointment-request paths intact when this connection has no chat grant.
  if (!storedBooking(row)) return;
  delete row.configuration.booking;
  row.capabilities = row.capabilities.filter(value => value !== "appointment.request");
  const enabled = Array.isArray(row.widget.enabledCapabilities) ? row.widget.enabledCapabilities : [];
  row.widget = { ...row.widget, calendarEnabled: false, enabledCapabilities: enabled.filter(value => value !== "appointment.request") };
}
async function saveBookingGrant(tx: TenantTransaction, session: AppSession, row: IntegrationRow, patch: ReturnType<typeof bookingPatch>) {
  if (!patch) return;
  if (!patch.enabled) { removeBooking(row); return; }
  if (row.integrationType !== "website_chat" || row.mode !== "real_customer" || row.status !== "active" || !storedAssistant(row)) {
    fail("BOOKING_CHAT_NOT_ACTIVE", "Buchungen benötigen einen aktiven Website-Chat im Kundenbetrieb mit zugeordnetem Assistenten.", 409);
  }
  const available = await bookingOptions(tx, session, true);
  if (!available.canManage) fail("BOOKING_MANAGEMENT_FORBIDDEN", "Für Buchungsfreigaben fehlen Kalender-Verwaltungsrechte oder das Kalendermodul.", 403);
  if (!available.publication || available.publication.publicId !== patch.publicId || patch.typeIds.some(id => !available.publication!.types.some(type => type.id === id))) {
    fail("BOOKING_PUBLICATION_REQUIRED", "Bitte zuerst Terminarten und Webchat in der Terminbuchung veröffentlichen.", 409);
  }
  if (row.allowedOrigins.some(origin => !available.allowedOrigins.includes(origin))) fail("BOOKING_ORIGIN_REQUIRED", "Bitte diese Website-Adressen auch in der Terminbuchung freigeben.", 409);
  row.configuration.booking = { ...patch, channels: ["chat"] } satisfies WebsiteBookingGrant;
  row.capabilities = [...new Set([...row.capabilities, "appointment.request"])];
  const enabled = Array.isArray(row.widget.enabledCapabilities) ? row.widget.enabledCapabilities.filter((value): value is string => typeof value === "string") : [];
  row.widget = { ...row.widget, calendarEnabled: true, enabledCapabilities: [...new Set([...enabled, "appointment.request"])] };
}
function mode(value: unknown): ExternalIntegrationMode {
  if (value !== "training" && value !== "real_customer") fail("VALIDATION_ERROR", "Ungültiger Betriebsmodus.");
  return value;
}
function status(value: unknown): IntegrationStatus {
  if (typeof value !== "string" || !(statuses as readonly string[]).includes(value)) fail("VALIDATION_ERROR", "Ungültiger Verbindungsstatus.");
  return value as IntegrationStatus;
}
function widgetPatch(value: unknown): Widget {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("VALIDATION_ERROR", "Ungültige Widget-Einstellungen.");
  const input = value as Record<string, unknown>; fields(input, widgetFields);
  const result: Widget = {};
  for (const key of ["brandName", "assistantName", "welcomeMessage"] as const) if (input[key] !== undefined) result[key] = knowledgeText(input[key], key, key === "welcomeMessage" ? 500 : 120);
  if (input.assistantAvatarReference !== undefined) result.assistantAvatarReference = input.assistantAvatarReference === null ? null : knowledgeText(input.assistantAvatarReference, "assistantAvatarReference", 500);
  if (input.primaryColor !== undefined) {
    if (typeof input.primaryColor !== "string" || !/^#[0-9a-f]{6}$/iu.test(input.primaryColor)) fail("VALIDATION_ERROR", "Ungültige Widget-Farbe.");
    result.primaryColor = input.primaryColor;
  }
  if (input.widgetPosition !== undefined) {
    if (input.widgetPosition !== "bottom_left" && input.widgetPosition !== "bottom_right") fail("VALIDATION_ERROR", "Ungültige Widget-Position.");
    result.widgetPosition = input.widgetPosition;
  }
  if (input.language !== undefined) {
    if (typeof input.language !== "string" || !/^[a-z]{2}(?:-[A-Z]{2})?$/u.test(input.language)) fail("VALIDATION_ERROR", "Ungültige Widget-Sprache.");
    result.language = input.language;
  }
  return result;
}
function defaultWidget(session: AppSession): Widget {
  return { brandName: session.workspaceName.trim().slice(0, 120) || "Website", assistantName: "Assistent", assistantAvatarReference: null,
    primaryColor: "#111827", widgetPosition: "bottom_right", language: "de", welcomeMessage: "Wie kann ich Ihnen helfen?",
    enabledCapabilities: [], chatEnabled: false, leadCaptureEnabled: false, calendarEnabled: false, propertySearchEnabled: false };
}
const rowSelect = `select i.id,i.public_site_key as "publicSiteKey",i.project_id as "projectId",i.form_id as "formId",
  i.integration_type as "integrationType",i.status,i.mode,i.allowed_origins as "allowedOrigins",i.capabilities,i.configuration,i.updated_at::text as "updatedAt",
  case when w.integration_id is null then '{}'::jsonb else jsonb_build_object(
    'brandName',w.brand_name,'assistantName',w.assistant_name,'assistantAvatarReference',w.assistant_avatar_reference,
    'primaryColor',w.primary_color,'widgetPosition',w.widget_position,'language',w.language,'welcomeMessage',w.welcome_message,
    'enabledCapabilities',w.enabled_capabilities,'chatEnabled',w.chat_enabled,'leadCaptureEnabled',w.lead_capture_enabled,
    'calendarEnabled',w.calendar_enabled,'propertySearchEnabled',w.property_search_enabled) end as widget
  from public.external_integrations i left join public.external_integration_widget_configs w on w.integration_id=i.id and w.workspace_id=i.workspace_id`;
async function getRow(tx: TenantTransaction, session: AppSession, id: string, lock = false) {
  const row = await tx.queryOne<IntegrationRow>(`${rowSelect} where i.workspace_id=$1::uuid and i.id=$2::uuid${lock ? " for update of i" : ""}`, [session.workspaceId, id]);
  if (!row) fail("NOT_FOUND", "Website-Verbindung nicht gefunden.", 404);
  if (row.projectId) await assertProjectGrant(tx, session, row.projectId, lock);
  return row;
}
async function assistantScope(tx: TenantTransaction, session: AppSession, row: IntegrationRow, write = false) {
  const id = storedAssistant(row); if (!id) fail("ASSISTANT_REQUIRED", "Bitte einen Assistenten zuordnen.", 409);
  knowledgeId(id, "knowledgeAssistantId");
  const bot = await tx.queryOne<{ projectId: string | null }>(`select project_id as "projectId" from public.bots where workspace_id=$1::uuid and id=$2::uuid`, [session.workspaceId, id]);
  if (!bot || bot.projectId !== row.projectId) fail("ASSISTANT_SCOPE_MISMATCH", "Der Assistent muss zum selben Unternehmen und Projekt gehören.", 403);
  if (bot.projectId) await assertProjectGrant(tx, session, bot.projectId, write);
  return id;
}
async function assertReady(tx: TenantTransaction, session: AppSession, row: IntegrationRow): Promise<WebsiteIntegrationReadiness> {
  const assistantId = await assistantScope(tx, session, row);
  const contract = await knowledgeInternals.enabled(tx, session);
  const assistantModule = await tx.queryOne<{ enabled: boolean }>(`select enabled from public.workspace_module_settings where workspace_id=$1::uuid and module_key='bots'`, [session.workspaceId]);
  if (assistantModule?.enabled === false || contract.features?.webchatAccess !== true) fail("ENTITLEMENT_REQUIRED", "Webchat ist für dieses Unternehmen nicht freigeschaltet.", 403);
  origins(row.allowedOrigins);
  const enabledCapabilities = row.widget.enabledCapabilities;
  if (!chatCapabilities.every(capability => row.capabilities.includes(capability)) || row.widget.chatEnabled !== true ||
    !Array.isArray(enabledCapabilities) || !chatCapabilities.every(capability => enabledCapabilities.includes(capability)) ||
    enabledCapabilities.some(capability => typeof capability !== "string" || !row.capabilities.includes(capability))) {
    fail("CHAT_CONFIGURATION_REQUIRED", "Die gespeicherte Verbindung ist noch nicht für Webchat eingerichtet.", 409);
  }
  const grants = await tx.query<{ id: string; projectId: string | null }>(`select a.id,a.project_id as "projectId" from public.knowledge_area_grants g
    join public.knowledge_areas a on a.id=g.area_id and a.workspace_id=g.workspace_id
    where g.workspace_id=$1::uuid and g.bot_id=$2::uuid and g.channel='webchat' and a.archived_at is null`, [session.workspaceId, assistantId]);
  for (const area of grants) {
    if (area.projectId && area.projectId !== row.projectId) fail("KNOWLEDGE_SCOPE_MISMATCH", "Ein Wissensbereich gehört zu einem anderen Projekt.", 403);
    if (area.projectId) await assertProjectGrant(tx, session, area.projectId);
  }
  const published = await tx.queryOne<{ count: number }>(`select count(distinct s.id)::int as count from public.knowledge_area_grants g
    join public.knowledge_areas a on a.id=g.area_id and a.workspace_id=g.workspace_id and a.archived_at is null
    join public.knowledge_sources s on s.knowledge_area_id=a.id and s.workspace_id=g.workspace_id and s.archived_at is null
    join public.knowledge_source_versions v on v.id=s.approved_version_id and v.source_id=s.id and v.workspace_id=s.workspace_id and v.status='approved'
    where g.workspace_id=$1::uuid and g.bot_id=$2::uuid and g.channel='webchat'
      and (a.project_id is null or a.project_id=$3::uuid) and (s.project_id is null or s.project_id=$3::uuid)
      and exists(select 1 from public.knowledge_chunks c where c.source_id=s.id and c.knowledge_version_id=v.id)`, [session.workspaceId, assistantId, row.projectId]);
  if (!grants.length || !published?.count) fail("PUBLISHED_KNOWLEDGE_REQUIRED", "Bitte dem Assistenten veröffentlichtes Wissen für Webchat zuordnen.", 409);
  return { ready: true, code: null, message: null, publishedSources: published.count };
}
async function present(tx: TenantTransaction, session: AppSession, row: IntegrationRow): Promise<ManagedWebsiteIntegration> {
  let readiness: WebsiteIntegrationReadiness;
  try { readiness = await assertReady(tx, session, row); } catch (error) {
    if (!(error instanceof KnowledgeCenterError || error instanceof CrmCommandError)) throw error;
    readiness = { ready: false, code: error.code, message: error.message, publishedSources: 0 };
  }
  const { configuration, ...safe } = row;
  return { ...safe, knowledgeAssistantId: typeof configuration.knowledgeAssistantId === "string" ? configuration.knowledgeAssistantId : null, readiness, booking: storedBooking(row) };
}
async function saveWidget(tx: TenantTransaction, session: AppSession, row: IntegrationRow) {
  const w = row.widget;
  await tx.execute(`insert into public.external_integration_widget_configs(integration_id,workspace_id,brand_name,assistant_name,
    assistant_avatar_reference,primary_color,widget_position,language,welcome_message,enabled_capabilities,chat_enabled,lead_capture_enabled,calendar_enabled,property_search_enabled)
    values($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10::text[],$11,$12,$13,$14)
    on conflict(integration_id) do update set brand_name=excluded.brand_name,assistant_name=excluded.assistant_name,
      assistant_avatar_reference=excluded.assistant_avatar_reference,primary_color=excluded.primary_color,
      widget_position=excluded.widget_position,language=excluded.language,welcome_message=excluded.welcome_message,
      enabled_capabilities=excluded.enabled_capabilities,chat_enabled=excluded.chat_enabled,lead_capture_enabled=excluded.lead_capture_enabled,
      calendar_enabled=excluded.calendar_enabled,property_search_enabled=excluded.property_search_enabled,updated_at=clock_timestamp()
    where public.external_integration_widget_configs.workspace_id=excluded.workspace_id`,
  [row.id, session.workspaceId, w.brandName, w.assistantName, w.assistantAvatarReference, w.primaryColor, w.widgetPosition,
    w.language, w.welcomeMessage, w.enabledCapabilities, w.chatEnabled, w.leadCaptureEnabled, w.calendarEnabled, w.propertySearchEnabled]);
}
function binding(row: IntegrationRow, assistantId: string | null) {
  const config = { ...row.configuration };
  const prior = row.widget.enabledCapabilities;
  const enabled = Array.isArray(prior) ? prior.filter((value): value is string => typeof value === "string") : [];
  if (assistantId) {
    config.knowledgeAssistantId = assistantId;
    row.capabilities = [...new Set([...row.capabilities, ...chatCapabilities])];
    row.widget = { ...row.widget, chatEnabled: true, enabledCapabilities: [...new Set([...enabled, ...chatCapabilities])] };
  } else {
    const hadBooking = storedBooking(row) !== null;
    removeBooking(row);
    if (hadBooking) delete config.booking;
    delete config.knowledgeAssistantId;
    const keep = (value: string) => !(chatCapabilities as readonly string[]).includes(value);
    row.capabilities = row.capabilities.filter(keep);
    const remaining = Array.isArray(row.widget.enabledCapabilities) ? row.widget.enabledCapabilities : [];
    row.widget = { ...row.widget, chatEnabled: false, enabledCapabilities: remaining.filter(value => typeof value === "string" && keep(value)) };
    if (!row.capabilities.length && row.status !== "revoked") row.status = "disabled";
  }
  row.configuration = config;
}
function auditState(row: IntegrationRow | null) {
  return row ? { projectId: row.projectId, knowledgeAssistantId: storedAssistant(row), status: row.status, mode: row.mode,
    allowedOrigins: row.allowedOrigins, capabilities: row.capabilities, widget: row.widget, booking: storedBooking(row) } : null;
}
async function audit(tx: TenantTransaction, session: AppSession, action: string, before: IntegrationRow | null, after: IntegrationRow) {
  await tx.execute(`insert into public.audit_logs(workspace_id,actor_user_id,project_id,action,entity_type,entity_id,before,after)
    values($1::uuid,$2::uuid,$3::uuid,$4,'external_integration',$5::uuid,$6::jsonb,$7::jsonb)`,
  [session.workspaceId, session.userId, after.projectId, action, after.id, JSON.stringify(auditState(before)), JSON.stringify(auditState(after))]);
}
export async function listManagedWebsiteIntegrations(session: AppSession, options: TenantTransactionOptions = {}) {
  return withCrmRead(session, async (tx, fresh) => {
    authorize(fresh);
    const rows = await tx.query<IntegrationRow>(`${rowSelect} where i.workspace_id=$1::uuid
      and (i.project_id is null or crm_project_access(i.workspace_id,i.project_id,false)) order by i.updated_at desc,i.id`, [fresh.workspaceId]);
    const integrations: ManagedWebsiteIntegration[] = [];
    for (const row of rows) integrations.push(await present(tx, fresh, row));
    const available = await bookingOptions(tx, fresh);
    return { integrations, permissions: permissions(fresh), bookingOptions: { canManage: available.canManage, publication: available.publication } };
  }, options);
}
export async function createManagedWebsiteIntegration(session: AppSession, input: Record<string, unknown>, options: TenantTransactionOptions = {}) {
  fields(input, websiteIntegrationCreateFields);
  if ((input.integrationType !== undefined && input.integrationType !== "website_chat") || input.formId != null) fail("VALIDATION_ERROR", "Neue Selfservice-Verbindungen verwenden den Website-Chat.");
  if (input.capabilities !== undefined && (!Array.isArray(input.capabilities) || input.capabilities.length !== chatCapabilities.length || !chatCapabilities.every(capability => (input.capabilities as unknown[]).includes(capability)))) fail("VALIDATION_ERROR", "Website-Chat verwendet fest vorgegebene Fähigkeiten.");
  const assistantId = optionalId(input.knowledgeAssistantId, "knowledgeAssistantId"), projectId = optionalId(input.projectId, "projectId");
  const allowedOrigins = origins(input.allowedOrigins), integrationMode = mode(input.mode ?? "training"), appearance = widgetPatch(input.widget);
  return withCrmRead(session, async (tx, fresh) => {
    authorize(fresh, true, true); await knowledgeInternals.lock(tx, fresh);
    if (projectId) await assertProjectGrant(tx, fresh, projectId, true);
    const row: IntegrationRow = { id: "", publicSiteKey: createPublicSiteKey(), projectId, formId: null, integrationType: "website_chat",
      status: "test", mode: integrationMode, allowedOrigins, capabilities: [], configuration: {}, updatedAt: "", widget: { ...defaultWidget(fresh), ...appearance } };
    binding(row, assistantId); await assertReady(tx, fresh, row);
    const created = await tx.queryOne<{ id: string }>(`insert into public.external_integrations(
      public_site_key,workspace_id,project_id,integration_type,status,mode,allowed_origins,capabilities,configuration,created_by)
      values($1,$2::uuid,$3::uuid,'website_chat','test',$4,$5::text[],$6::text[],$7::jsonb,$8::uuid) returning id`,
    [row.publicSiteKey, fresh.workspaceId, projectId, integrationMode, allowedOrigins, row.capabilities, JSON.stringify(row.configuration), fresh.userId]);
    if (!created) fail("CREATE_FAILED", "Die Website-Verbindung konnte nicht gespeichert werden.", 503);
    row.id = created.id; await saveWidget(tx, fresh, row);
    const saved = await getRow(tx, fresh, row.id); await audit(tx, fresh, "website.integration.created", null, saved);
    return present(tx, fresh, saved);
  }, options);
}
export async function updateManagedWebsiteIntegration(session: AppSession, input: Record<string, unknown>, options: TenantTransactionOptions = {}) {
  fields(input, websiteIntegrationUpdateFields);
  const id = knowledgeId(input.integrationId, "integrationId"), expected = knowledgeText(input.expectedUpdatedAt, "expectedUpdatedAt", 80);
  if (!websiteIntegrationUpdateFields.slice(2).some(key => input[key] !== undefined)) fail("VALIDATION_ERROR", "Keine Änderung angegeben.");
  const allowedOrigins = input.allowedOrigins === undefined ? undefined : origins(input.allowedOrigins);
  const assistantId = input.knowledgeAssistantId === undefined ? undefined : optionalId(input.knowledgeAssistantId, "knowledgeAssistantId");
  const integrationMode = input.mode === undefined ? undefined : mode(input.mode), nextStatus = input.status === undefined ? undefined : status(input.status);
  const appearance = widgetPatch(input.widget);
  const booking = bookingPatch(input.booking);
  return withCrmRead(session, async (tx, fresh) => {
    authorize(fresh, true);
    // Public knowledge reads hold this integration before taking the knowledge
    // lock. Keep the same order so editing cannot deadlock an in-flight answer.
    const previous = await getRow(tx, fresh, id, true);
    if (previous.updatedAt !== expected) fail("CONFLICT", "Die Verbindung wurde inzwischen geändert. Bitte neu laden.", 409);
    await knowledgeInternals.lock(tx, fresh);
    if (previous.status === "revoked" && nextStatus !== undefined && nextStatus !== "revoked") fail("INTEGRATION_REVOKED", "Eine widerrufene Verbindung benötigt einen neuen Website-Schlüssel.", 409);
    const row: IntegrationRow = { ...previous, configuration: { ...previous.configuration }, capabilities: [...previous.capabilities],
      allowedOrigins: allowedOrigins ?? previous.allowedOrigins, mode: integrationMode ?? previous.mode, status: nextStatus ?? previous.status,
      widget: { ...defaultWidget(fresh), ...previous.widget, ...appearance } };
    const originChanged = row.allowedOrigins.length !== previous.allowedOrigins.length || row.allowedOrigins.some(origin => !previous.allowedOrigins.includes(origin));
    const onlyRevokesBooking = booking?.enabled === false && (assistantId === undefined || assistantId === storedAssistant(previous)) &&
      row.mode === previous.mode && row.status === previous.status && !originChanged && Object.entries(appearance).every(([key, value]) => previous.widget[key] === value);
    if (assistantId !== undefined) { authorize(fresh, true, true); binding(row, assistantId); if (assistantId) await assistantScope(tx, fresh, row, true); }
    const runnable = row.status === "test" || row.status === "active";
    const chat = row.integrationType === "website_chat" || Boolean(storedAssistant(row)) || row.widget.chatEnabled === true || row.capabilities.some(value => (chatCapabilities as readonly string[]).includes(value));
    if (runnable && chat && !onlyRevokesBooking) {
      authorize(fresh, true, true);
      // Older Studio bindings may have an assistant but only lead/form capabilities.
      if (storedAssistant(row)) binding(row, storedAssistant(row));
      await assertReady(tx, fresh, row);
    }
    // Detaching chat does not activate or change an existing form. It must stay
    // possible even when that form has since been unpublished. Full editor
    // submissions may include unchanged values, so compare the actual change.
    const onlyDetachesChat = assistantId === null && row.mode === previous.mode &&
      (row.status === previous.status || row.status === "disabled" || row.status === "revoked") &&
      row.allowedOrigins.length === previous.allowedOrigins.length && row.allowedOrigins.every(origin => previous.allowedOrigins.includes(origin)) &&
      Object.entries(appearance).every(([key, value]) => previous.widget[key] === value);
    if (runnable && row.formId && !onlyDetachesChat && !onlyRevokesBooking) {
      const form = await tx.queryOne<{ id: string }>(`select id from public.forms where workspace_id=$1::uuid and id=$2::uuid
        and project_id is not distinct from $3::uuid and status in ('aktiv','eingebaut')`, [fresh.workspaceId, row.formId, row.projectId]);
      if (!form) fail("PUBLISHED_FORM_REQUIRED", "Das zugeordnete Formular ist nicht veröffentlicht.", 409);
    }
    const retained = storedBooking(row);
    await saveBookingGrant(tx, fresh, row, booking ?? (originChanged && retained ? retained : undefined));
    await tx.execute(`update public.external_integrations set allowed_origins=$3::text[],capabilities=$4::text[],configuration=$5::jsonb,
      status=$6,mode=$7,revoked_at=case when $6='revoked' then coalesce(revoked_at,clock_timestamp()) else null end,
      updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond') where workspace_id=$1::uuid and id=$2::uuid`,
    [fresh.workspaceId, id, row.allowedOrigins, row.capabilities, JSON.stringify(row.configuration), row.status, row.mode]);
    await saveWidget(tx, fresh, row);
    const saved = await getRow(tx, fresh, id); await audit(tx, fresh, "website.integration.updated", previous, saved);
    return present(tx, fresh, saved);
  }, options);
}
