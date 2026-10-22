import "server-only";
import { crmPayloadDigest, withCrmRead, type TenantTransactionOptions } from "@/lib/crm-command";
import type { AppSession } from "@/lib/auth/session";
import { getRolePermissions } from "@/lib/auth/permissions";
import { getProductRoleCapabilities } from "@/lib/product-model";
import { getCrmMachineBearer, verifyCrmMachineToken, type CrmMachineAuthOptions } from "@/lib/crm-machine-auth";
import { queryAuthenticationRows } from "@/lib/db/tenant-client";
import { getExternalChatContext, resolveExternalIntegration } from "@/lib/db/external-integration-gateway";
import { BookingError } from "./types";

type Principal = { id: string; workspace_id: string; actor_user_id: string; identity_id: string; data_context: string };
export type BookingChannelAuthority = {
  publicId: string; workspaceId: string; bindingId: string; typeIds: string[];
  relation?: { source: "machine" | "external_chat" | "studio_handoff"; sourceId: string; leadId?: string; contactId?: string };
};
export type BookingMachineOptions = TenantTransactionOptions & { machineAuth?: CrmMachineAuthOptions };
const authenticationSql = "select * from public.crm_authenticate_machine($1,$2,$3,$4,$5,$6,$7::uuid,$8,$9)";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function deny(): never { throw new BookingError("BOOKING_CHANNEL_DENIED", 403); }

/** A saved booking grant is independent of the existing knowledge grant. */
export function readSavedBookingGrant(config: unknown, channel: "chat" | "voice") {
  const record = config && typeof config === "object" && !Array.isArray(config) ? config as Record<string, unknown> : {};
  const grant = record.booking && typeof record.booking === "object" && !Array.isArray(record.booking)
    ? record.booking as Record<string, unknown> : {};
  if (grant.enabled !== true || typeof grant.publicId !== "string" || !/^[a-z0-9][a-z0-9-]{10,79}$/.test(grant.publicId) ||
      !Array.isArray(grant.channels) || !grant.channels.includes(channel) ||
      !Array.isArray(grant.typeIds) || !grant.typeIds.length || grant.typeIds.length > 50 ||
      grant.typeIds.some(id => typeof id !== "string" || !uuid.test(id))) deny();
  return { publicId: grant.publicId as string, typeIds: [...new Set(grant.typeIds as string[])] };
}

/**
 * Every call verifies the workload and locks its saved assistant mapping again.
 * A phone number, model argument, caller tenant or prior tool result grants no access.
 * No voice provider, phone number, outbound call or implicit production grant is created.
 */
export async function verifyMachineBookingAuthority(request: Request, channel: "chat" | "voice", options: BookingMachineOptions = {}): Promise<BookingChannelAuthority> {
  if (request.method !== "POST" || request.headers.has("cookie") || request.headers.has("origin") || new URL(request.url).search) deny();
  const bearer = getCrmMachineBearer(request.headers);
  if (!bearer) throw new BookingError("BOOKING_CHANNEL_UNAUTHORIZED", 401);
  const claims = await verifyCrmMachineToken(bearer, options.machineAuth);
  const params = [claims.identityId, claims.subject, claims.issuer, claims.audience, claims.projectId,
    claims.ownerId, claims.workspaceId, claims.environment, claims.role];
  const principal = (await queryAuthenticationRows<Principal>(authenticationSql, params, options))[0];
  if (!principal || principal.workspace_id !== claims.workspaceId || principal.identity_id !== claims.identityId) deny();
  const productRole = principal.data_context === "NOVALURE_INTERNAL" ? "novalure_operator" : "project_sales_member";
  const session: AppSession = {
    authenticated: true, source: "database", userId: principal.actor_user_id, workspaceId: principal.workspace_id,
    workspaceName: "Verified assistant workspace", name: "Verified booking assistant", email: "booking-service@service.invalid",
    role: "agent", permissions: getRolePermissions("agent"), productRole, productPermissions: getProductRoleCapabilities(productRole),
    serviceIdentity: { identityId: claims.identityId, role: claims.role, consumer: claims.consumer, environment: claims.environment, jtiHash: claims.jtiHash },
  };
  return withCrmRead(session, async (tx, member) => {
    const binding = await tx.queryOne<{ bot_id: string; workspace_id: string }>(
      "select * from public.knowledge_lock_assistant_service_binding($1::uuid,$2)", [principal.id, channel === "chat" ? "webchat" : "voice"]);
    if (!binding || binding.workspace_id !== member.workspaceId) deny();
    const current = await tx.queryOne<Principal>(authenticationSql, params);
    if (!current || crmPayloadDigest(current) !== crmPayloadDigest(principal)) deny();
    const bot = await tx.queryOne<{ config: unknown }>("select config from public.bots where id=$1::uuid and workspace_id=$2::uuid for share", [binding.bot_id, member.workspaceId]);
    const grant = readSavedBookingGrant(bot?.config, channel);
    return { ...grant, workspaceId: member.workspaceId, bindingId: principal.id,
      relation: { source: "machine", sourceId: principal.id } };
  }, options);
}

/** Reuses the real-customer integration and its opaque active chat credential. */
export async function verifyExternalChatBookingAuthority(input: {
  publicSiteKey: string; origin: string; sessionId: string; sessionToken: string; correlationId: string;
}): Promise<BookingChannelAuthority> {
  const resolution = await resolveExternalIntegration({ capability: "appointment.request", origin: input.origin, publicSiteKey: input.publicSiteKey });
  if (!resolution || resolution.integrationMode !== "real_customer") deny();
  const chat = await getExternalChatContext({ ...input, resolution });
  if (chat.status !== "active" || chat.mode !== "real_customer") deny();
  const grant = readSavedBookingGrant(resolution.configuration, "chat");
  return { ...grant, workspaceId: resolution.workspaceId, bindingId: resolution.integrationId,
    relation: { source: "external_chat", sourceId: input.sessionId } };
}

export function assertBookingChannelType(authority: BookingChannelAuthority, typeId: unknown): string {
  if (typeof typeId !== "string" || !authority.typeIds.includes(typeId)) deny();
  return typeId as string;
}
