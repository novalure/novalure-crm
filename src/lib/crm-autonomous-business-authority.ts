import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppSession } from "./auth/session";
import { CrmCommandError, crmPayloadDigest, withCrmRead, type TenantTransaction, type TenantTransactionOptions } from "./crm-command";
import { parseAutonomousModuleRequest, validateAutonomousModulePatch, type AutonomousModuleRequest } from "./crm-autonomous-module-contract";
import type { AutonomousModuleGrant } from "./crm-autonomous-module-storage";

const guarded = ["SendOffer", "ConfirmReservation", "ConfirmSale"] as const;
function denied(code = "APPROVAL_REQUIRED", status = 403): never {
  throw new CrmCommandError(code, "A current exact business decision is required", status);
}
function guardedCommand(raw: unknown): AutonomousModuleRequest {
  // Snapshot before awaiting any authentication/database operation.
  const body = parseAutonomousModuleRequest(JSON.parse(JSON.stringify(raw)));
  if (!(guarded as readonly string[]).includes(body.operation)) denied("INVALID_REQUEST", 400);
  const entity = body.operation === "SendOffer" ? "Offer" : body.operation === "ConfirmReservation" ? "Reservation" : "Sale";
  validateAutonomousModulePatch(entity, body);
  return Object.freeze({ ...body, patch: Object.freeze({ ...body.patch }) });
}
const decisionSchema = z.discriminatedUnion("decision", [
  z.strictObject({ decision: z.enum(["APPROVED", "DENIED"]), decisionId: z.uuid(), grantId: z.uuid(),
    command: z.unknown(), expiresAt: z.iso.datetime({ offset: true }) }),
  z.strictObject({ decision: z.literal("REVOKE"), decisionId: z.uuid() }),
  z.strictObject({ decision: z.literal("ATTEST_OFFER_QUALITY"), decisionId: z.uuid(), grantId: z.uuid(),
    command: z.unknown(), expiresAt: z.iso.datetime({ offset: true }) }),
  z.strictObject({ decision: z.literal("REVOKE_OFFER_QUALITY"), decisionId: z.uuid() }),
]);

/** Human decision entry only. Persisted owner/MFA/configuration checks run again in SQL;
 * cookie authentication and CSRF are additionally mandatory at the route boundary. */
export async function decideAutonomousBusinessAuthority(session: AppSession, raw: unknown,
  options: TenantTransactionOptions = {}) {
  if (!session.authenticated || session.source !== "cookie" || session.serviceIdentity || session.role !== "owner"
    || !session.authSessionId || !session.authIdentityId) denied("OWNER_AUTHENTICATION_REQUIRED", 401);
  const parsed = decisionSchema.safeParse(raw);
  if (!parsed.success) denied("INVALID_REQUEST", 400);
  const input = parsed.data;
  const body = "command" in input ? guardedCommand(input.command) : null;
  return withCrmRead(session, async (tx, fresh) => {
    if (fresh.role !== "owner" || fresh.serviceIdentity) denied();
    const result = input.decision === "REVOKE"
      ? await tx.queryOne<{ id: string }>("select public.crm_revoke_autonomous_business($1,$2,$3) as id",
        [fresh.authSessionId, fresh.authIdentityId, input.decisionId])
      : input.decision === "REVOKE_OFFER_QUALITY"
      ? await tx.queryOne<{ id: string }>("select public.crm_revoke_autonomous_offer_quality($1,$2,$3) as id",
        [fresh.authSessionId, fresh.authIdentityId, input.decisionId])
      : input.decision === "ATTEST_OFFER_QUALITY"
      ? await tx.queryOne<{ id: string }>("select public.crm_attest_autonomous_offer_quality($1,$2,$3,$4,$5::jsonb,$6,$7::timestamptz) as id",
        [fresh.authSessionId, fresh.authIdentityId, input.decisionId, input.grantId, JSON.stringify(body), crmPayloadDigest(body), input.expiresAt])
      : await tx.queryOne<{ id: string }>("select public.crm_decide_autonomous_business($1,$2,$3,$4,$5::jsonb,$6,$7,$8::timestamptz) as id",
        [fresh.authSessionId, fresh.authIdentityId, input.decisionId, input.grantId, JSON.stringify(body), crmPayloadDigest(body), input.decision, input.expiresAt]);
    if (result?.id !== input.decisionId) denied();
    const auditReference = randomUUID();
    await tx.execute(`insert into audit_logs(id,workspace_id,actor_user_id,action,entity_type,entity_id,after)
      values($1::uuid,$2::uuid,$3::uuid,'crm.autonomous.business_decision','autonomous_business_decision',$4::uuid,$5::jsonb)`,
      [auditReference, fresh.workspaceId, fresh.userId, input.decisionId, JSON.stringify({ decision: input.decision,
        ...(body ? { requestHash: crmPayloadDigest(body), operation: body.operation, expectedVersion: body.expectedVersion } : {}),
        ...(input.decision === "ATTEST_OFFER_QUALITY" ? { qualityOrigin: "OWNER_QUALITY_ATTESTATION" } : {}) })]);
    return { decisionId: result.id, decision: input.decision, auditReference };
  }, options);
}

/** Call inside the SAME existing native effect/receipt transaction. A failure must roll
 * back consumption and effect together. Exact replay never grants a second command.
 * Original owner session freshness is proven at decision time; service execution does
 * not require a live personal login/MFA. Active owner configuration/revocation still apply. */
export async function assertAndConsumeAutonomousBusinessAuthority(tx: TenantTransaction, session: AppSession,
  grant: AutonomousModuleGrant, rawBody: AutonomousModuleRequest): Promise<Readonly<{
    approvalReference: string; replayed: boolean; qualityReference: string | null; qualityOrigin: "OWNER_QUALITY_ATTESTATION" | null;
  }>> {
  const body = guardedCommand(rawBody);
  const identity = session.serviceIdentity;
  const registeredSource = identity && (identity.identityId === "EVELYN_CRM_AUTONOMOUS_INTERNAL_IDENTITY" && identity.environment === "production"
    || identity.identityId === "EVELYN_CRM_PERSONAL_INTERNAL_IDENTITY" && identity.environment === "franz-personal");
  if (!session.authenticated || session.workspaceId !== grant.workspace_id || session.userId !== grant.actor_user_id
    || !registeredSource || identity?.role !== "Evelyn.Service" || identity.consumer !== "EVELYN") denied();
  type Result = { approvalReference: string; replayed: boolean; qualityReference: string | null; qualityOrigin: "OWNER_QUALITY_ATTESTATION" | null };
  let result: Result | null;
  try {
    result = await tx.queryOne<Result>(
      'select approval_reference as "approvalReference",replayed,quality_reference as "qualityReference",quality_origin as "qualityOrigin" from public.crm_consume_autonomous_business($1,$2::jsonb,$3)',
      [grant.id, JSON.stringify(body), crmPayloadDigest(body)]);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "42501") denied("APPROVAL_REQUIRED", 403);
    if (code === "40001") denied("VERSION_CONFLICT", 409);
    if (code === "23505") denied("APPROVAL_SCOPE_MISMATCH", 409);
    throw error;
  }
  if (!result || !z.uuid().safeParse(result.approvalReference).success || typeof result.replayed !== "boolean"
    || !z.uuid().nullable().safeParse(result.qualityReference).success
    || !z.literal("OWNER_QUALITY_ATTESTATION").nullable().safeParse(result.qualityOrigin).success
    || body.operation === "SendOffer" && (!result.qualityReference || result.qualityOrigin !== "OWNER_QUALITY_ATTESTATION")) denied();
  return Object.freeze(result);
}
