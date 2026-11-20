import "server-only";
import { CrmCommandError } from "./crm-command";
import { getBuildMetadata } from "./build-metadata";
import { assertVerifiedPropertyReaderIdentity, type VerifiedPropertyIdentity } from "./crm-property-observation-auth";
import { PROPERTY_OBSERVATION_FIELDS, makePropertyObservation, type PropertyObservationField } from "./crm-property-observation";
import { withPropertyObservationTransaction } from "./crm-property-observation-pool";
import type { TenantPool } from "./db/tenant-client";

export type PropertyObservationRead = Readonly<{
  workspaceId: string; projectId: string; unitId: string; fields: readonly PropertyObservationField[];
}>;
export type AuthorizedPropertyObservation = Readonly<{
  observation: ReturnType<typeof makePropertyObservation>;
  assertCurrent: () => void;
}>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** No caller-provided actor/session: a stored grant and the dedicated DB login resolve the actor. */
export async function readPropertyObservationFromAuthorizedContext(
  identity: VerifiedPropertyIdentity, request: PropertyObservationRead, pool: TenantPool,
): Promise<AuthorizedPropertyObservation> {
  assertVerifiedPropertyReaderIdentity(identity);
  if (![request.workspaceId,request.projectId,request.unitId].every(value => typeof value === "string" && uuid.test(value)) ||
      !Array.isArray(request.fields) || request.fields.length < 1 || request.fields.length > PROPERTY_OBSERVATION_FIELDS.length ||
      new Set(request.fields).size !== request.fields.length || request.fields.some(field => !PROPERTY_OBSERVATION_FIELDS.includes(field))) {
    throw new CrmCommandError("INVALID_CRM_REQUEST", "Invalid property observation request", 400);
  }
  const workspaceId = request.workspaceId.toLowerCase(); const projectId = request.projectId.toLowerCase();
  const unitId = request.unitId.toLowerCase(); const fields = Object.freeze([...request.fields]);
  const boundIdentity = Object.freeze({ ...identity });
  const metadata = getBuildMetadata();
  if (!metadata.gitSha || !metadata.deploymentId) throw new CrmCommandError("CRM_PROPERTY_BUILD_UNVERIFIED", "Property observation build identity is unavailable", 503);
  const result = await withPropertyObservationTransaction(pool, async client => {
    assertVerifiedPropertyReaderIdentity(identity);
    const args = [workspaceId,projectId,unitId,boundIdentity.issuer,boundIdentity.subject,boundIdentity.audience,boundIdentity.ownerId,boundIdentity.workloadProjectId,boundIdentity.environment,fields];
    const actors = await client.query<{ actor_id: string }>("select * from public.crm_property_observation_actor($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10::text[])", args);
    if (actors.rows.length !== 1 || !uuid.test(actors.rows[0].actor_id)) throw new CrmCommandError("CRM_NOT_ACCESSIBLE", "Property observation is not accessible", 403);
    assertVerifiedPropertyReaderIdentity(identity);
    const actorId = actors.rows[0].actor_id;
    const started = performance.now();
    const read = await client.query<{ result: { binding: { grantId: string; remainingMs: number }; unitId: string; workspaceId: string; projectId: string; objectVersion: string; updatedAt: string; values: Record<string,unknown> } | null }>(
      "select public.crm_property_observe_unit($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9,$10,$11::text[],$12,$13::timestamptz) as result",
      [workspaceId,actorId,projectId,unitId,boundIdentity.issuer,boundIdentity.subject,boundIdentity.audience,boundIdentity.ownerId,boundIdentity.workloadProjectId,boundIdentity.environment,fields,boundIdentity.jtiHash,new Date(boundIdentity.expiresAt * 1000).toISOString()],
    );
    const value = read.rows[0]?.result;
    if (!value || value.unitId !== unitId || value.workspaceId !== workspaceId || value.projectId !== projectId ||
        !value.binding || !uuid.test(value.binding.grantId) || !Number.isSafeInteger(value.binding.remainingMs) || value.binding.remainingMs <= 0 ||
        !value.values || typeof value.values !== "object" || Array.isArray(value.values)) {
      throw new CrmCommandError("CRM_NOT_ACCESSIBLE", "Property observation is not accessible", 403);
    }
    const deadline = started + value.binding.remainingMs;
    const assertCurrent = () => {
      assertVerifiedPropertyReaderIdentity(identity);
      if (!Number.isFinite(deadline) || performance.now() >= deadline) throw new CrmCommandError("CRM_NOT_ACCESSIBLE", "Property authorization expired", 403);
    };
    assertCurrent();
    const at = new Date(value.updatedAt); if (!Number.isFinite(at.valueOf())) throw new CrmCommandError("CRM_NOT_ACCESSIBLE", "Property observation is not accessible", 403);
    const observation = makePropertyObservation({ actorId,workspaceId,projectId,unitId,sourceRevision: metadata.gitSha!,deploymentId: metadata.deploymentId!,
      objectVersion: Number(value.objectVersion),updatedAt: at.toISOString(),requestedFields: fields,row: value.values });
    return Object.freeze({ observation, assertCurrent });
  });
  result.assertCurrent(); // Recheck after the asynchronous database COMMIT.
  return result;
}
