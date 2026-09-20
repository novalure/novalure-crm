import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { getVercelOidcToken } from "@vercel/oidc";
import {
  approvalActionV2Hash,
  approvalActionV2InputSchema,
  moneyV2Schema,
  v2ThresholdContext,
  type ApprovalActionV2Input,
  type MoneyV2,
} from "./evelyn-money-tax-v2";

/** Contract source: novalure/evelyn@56e26c2b063319813076a3bc181473f484b1d490.
 * No owner decisions or business execution are available through this client. */
export const EVELYN_PREVIEW_URL = "https://evelyn-hrc1fof30-novalure.vercel.app";
/** Money/Tax V2 runtime from novalure/evelyn main@1de5e72d4f599f9fe9c05ddb9f8ab6db51f753fc.
 * Its deployed runtime source is 630c38e; the merge commit differs only in tests. */
export const EVELYN_V2_PREVIEW_URL = "https://evelyn-klpbq0dpl-novalure.vercel.app";
export const EVELYN_PREVIEW_AUDIENCE = "urn:evelyn:preview:approval-bridge:v1:prj_8bbjKnQ5XDr52YYPRYtvqtoSj71I";
export const CRM_VERCEL_PROJECT_ID = "prj_R32Okl6AHijTohvuKmryuTLjWMsk";
export const NOVALURE_VERCEL_TEAM_ID = "team_sjD78IkSicXJK6TAOR1JC7Wv";

export type EvelynApprovalAction = {
  actionId: string; workflowId: string; tenantId: string; requestingActorId: string;
  actionType: "contract.send"; resourceType: "Contract"; resourceId: string;
  actionVersion: number; resourceVersion: number; amount: number; currency: "EUR"; net: true;
  payload: {
    recipient: { id: string; email: string };
    contract: { id: string; version: number; content: string };
    scope: { projectId: string; description: string };
    price: { netCents: number; currency: "EUR" };
  };
};
export type EvelynPolicyEvidence = {
  financialTotalKnown: true; standardContract: boolean; approvedOffer: boolean;
  customerAccepted: boolean; approvedTemplate: boolean;
};
export type EvelynPolicyReferences = {
  approvedOfferId: string | null; customerAcceptanceId: string | null; approvedTemplateId: string | null;
};
export type EvelynCreateApprovalRequest = {
  contractVersion: "create-approval-request-v1"; requestId: string; correlationId: string;
  action: EvelynApprovalAction; actionHash: string;
  policyEvidence: EvelynPolicyEvidence; policyReferences: EvelynPolicyReferences;
};
export type EvelynApprovalStatus = "PENDING" | "STEP_1_APPROVED" | "APPROVED" | "REJECTED"
  | "CHANGES_REQUESTED" | "EXPIRED" | "CANCELLED" | "INVALIDATED";
export type EvelynCreateApprovalResponse = {
  contractVersion: "create-approval-request-v1"; environment: "preview";
  approvalReference: string; actionId: string; actionVersion: number; actionHash: string;
  requiredSteps: 0 | 1 | 2; status: EvelynApprovalStatus; auditReference: string; correlationId: string;
};
/** Exactly eight fields. Environment is authenticated by Evelyn from workload identity. */
export type EvelynVerifyRequest = {
  approvalReference: string; tenantId: string; actionId: string; actionType: string;
  resourceId: string; actionVersion: number; actionHash: string; correlationId: string;
};
export type EvelynVerificationStatus = "VALID" | "INVALID" | "PENDING" | "EXPIRED" | "REJECTED"
  | "VERSION_MISMATCH" | "ACTION_MISMATCH" | "TENANT_MISMATCH";
export type EvelynVerifiedApproval = {
  contractVersion: "approval-bridge-v1"; environment: "preview"; status: "VALID";
  approvalReference: string; correlationId: string;
};

/** Additive V2 bridge contract pinned to
 * novalure/evelyn@1de5e72d4f599f9fe9c05ddb9f8ab6db51f753fc. */
export type EvelynApprovalActionV2 = ApprovalActionV2Input;
export type EvelynPolicyEvidenceV2 = {
  financialTotalKnown: boolean; standardContract: boolean; approvedOffer: boolean;
  customerAccepted: boolean; approvedTemplate: boolean;
};
export type EvelynCreateApprovalRequestV2 = {
  contractVersion: "create-approval-request-v2"; requestId: string; correlationId: string;
  action: EvelynApprovalActionV2; actionHash: string;
  policyEvidence: EvelynPolicyEvidenceV2; policyReferences: EvelynPolicyReferences;
};
export type EvelynCreateApprovalStatusV2 = EvelynApprovalStatus | "NEEDS_REVIEW";
export type EvelynCreateApprovalResponseV2 = {
  contractVersion: "create-approval-request-v2"; environment: "preview";
  approvalReference: string; actionId: string; actionVersion: number; actionHash: string;
  financialSnapshotHash: string; requiredSteps: 0 | 1 | 2 | null;
  status: EvelynCreateApprovalStatusV2; auditReference: string; correlationId: string;
};
export type EvelynEconomicCommitmentV2 = { basis: "NET"; amount: MoneyV2 | null };
export type EvelynVerifyRequestV2 = {
  contractVersion: "verify-approval-v2"; approvalReference: string; tenantId: string;
  actionId: string; actionType: "contract.send"; resourceId: string; actionVersion: number;
  actionHash: string; financialSnapshotSchemaVersion: "financial-snapshot-v1";
  financialSnapshotHash: string; economicCommitment: EvelynEconomicCommitmentV2; correlationId: string;
};
export type EvelynVerificationStatusV2 = EvelynVerificationStatus | "NEEDS_REVIEW" | "POLICY_REQUIRED";
export type EvelynVerifiedApprovalV2 = {
  contractVersion: "approval-bridge-v2"; environment: "preview"; status: "VALID";
  approvalReference: string; correlationId: string;
};
export class EvelynApprovalError extends Error {
  constructor(readonly code: string) { super(code); this.name = "EvelynApprovalError"; }
}
function deny(code: string): never { throw new EvelynApprovalError(code); }
function check(condition: unknown, code = "INVALID_INPUT"): asserts condition { if (!condition) deny(code); }

export function assertEvelynApprovalV2RequestSize(input: EvelynCreateApprovalRequestV2): void {
  check(Buffer.byteLength(JSON.stringify(input)) <= 16_384, "REQUEST_TOO_LARGE");
}

function exact(value: unknown, keys: readonly string[], code = "INVALID_INPUT"): asserts value is Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value), code);
  check(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, code);
  const actual = Object.keys(value);
  check(actual.length === keys.length && actual.every(key => keys.includes(key)), code);
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
function uuid(value: unknown, code = "INVALID_INPUT") { check(typeof value === "string" && UUID.test(value), code); }
function hash(value: unknown, code = "INVALID_INPUT") { check(typeof value === "string" && HASH.test(value), code); }
function version(value: unknown, code = "INVALID_INPUT") { check(Number.isSafeInteger(value) && (value as number) > 0, code); }
function cents(value: unknown) { check(Number.isSafeInteger(value) && (value as number) >= 0); }

/** Evelyn src/domain/integrity.ts: recursively sorted object keys, unchanged array order. */
export function canonicalEvelynJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonicalEvelynJson).join(",") + "]";
  const object = value as Record<string, unknown>;
  return "{" + Object.keys(object).sort().map(key => JSON.stringify(key) + ":" + canonicalEvelynJson(object[key])).join(",") + "}";
}
function digest(value: unknown) { return createHash("sha256").update(canonicalEvelynJson(value)).digest("hex"); }
function validateAction(action: EvelynApprovalAction) {
  exact(action, ["actionId", "workflowId", "tenantId", "requestingActorId", "actionType", "resourceType", "resourceId",
    "actionVersion", "resourceVersion", "amount", "currency", "net", "payload"]);
  for (const id of [action.actionId, action.workflowId, action.tenantId, action.requestingActorId, action.resourceId]) uuid(id);
  check(action.actionType === "contract.send" && action.resourceType === "Contract" && action.currency === "EUR" && action.net === true);
  version(action.actionVersion); version(action.resourceVersion); cents(action.amount);
  exact(action.payload, ["recipient", "contract", "scope", "price"]);
  const { recipient, contract, scope, price } = action.payload;
  exact(recipient, ["id", "email"]); uuid(recipient.id);
  check(typeof recipient.email === "string" && recipient.email.length <= 254 && /^[^\s@]+@[^\s@]+\.invalid$/.test(recipient.email));
  exact(contract, ["id", "version", "content"]); uuid(contract.id); version(contract.version);
  check(typeof contract.content === "string" && contract.content.startsWith("SYNTHETIC") && contract.content.length <= 20_000);
  exact(scope, ["projectId", "description"]); uuid(scope.projectId);
  check(typeof scope.description === "string" && scope.description.startsWith("SYNTHETIC") && scope.description.length <= 5_000);
  exact(price, ["netCents", "currency"]); cents(price.netCents);
  check(price.currency === "EUR" && price.netCents === action.amount);
}
export function evelynActionHash(action: EvelynApprovalAction): string {
  validateAction(action);
  return digest({ ...action, environment: "preview", synthetic: true });
}
export function evelynRequestJti(nonce: string, body: unknown, operation: "create" | "verify"): string {
  uuid(nonce); check(operation === "create" || operation === "verify");
  return `${nonce}.${digest({ contractVersion: operation === "create" ? "evelyn-approval-request-v1" : "evelyn-approval-v1",
    method: "POST", path: operation === "create" ? "/api/v1/approvals/requests" : "/api/v1/approvals/verify", body })}`;
}
export function evelynRequestJtiV2(nonce: string, body: unknown, operation: "create" | "verify"): string {
  uuid(nonce); check(operation === "create" || operation === "verify");
  return `${nonce}.${digest({ contractVersion: operation === "create" ? "evelyn-approval-request-v2" : "evelyn-approval-v2",
    method: "POST", path: operation === "create" ? "/api/v2/approvals/requests" : "/api/v2/approvals/verify", body })}`;
}
function validateCreate(input: EvelynCreateApprovalRequest, tenantId: string) {
  exact(input, ["contractVersion", "requestId", "correlationId", "action", "actionHash", "policyEvidence", "policyReferences"]);
  check(input.contractVersion === "create-approval-request-v1"); uuid(input.requestId); uuid(input.correlationId);
  validateAction(input.action); check(input.action.tenantId === tenantId, "TENANT_MISMATCH"); hash(input.actionHash);
  check(evelynActionHash(input.action) === input.actionHash, "ACTION_MISMATCH");
  const evidence = input.policyEvidence, references = input.policyReferences;
  exact(evidence, ["financialTotalKnown", "standardContract", "approvedOffer", "customerAccepted", "approvedTemplate"]);
  check(evidence.financialTotalKnown === true);
  for (const field of ["standardContract", "approvedOffer", "customerAccepted", "approvedTemplate"] as const) check(typeof evidence[field] === "boolean");
  exact(references, ["approvedOfferId", "customerAcceptanceId", "approvedTemplateId"]);
  for (const reference of Object.values(references)) if (reference !== null) uuid(reference);
  check(!evidence.approvedOffer || references.approvedOfferId !== null);
  check(!evidence.customerAccepted || references.customerAcceptanceId !== null);
  check(!evidence.approvedTemplate || references.approvedTemplateId !== null);
}
function validateVerify(input: EvelynVerifyRequest, tenantId: string) {
  exact(input, ["approvalReference", "tenantId", "actionId", "actionType", "resourceId", "actionVersion", "actionHash", "correlationId"]);
  for (const id of [input.approvalReference, input.tenantId, input.actionId, input.resourceId, input.correlationId]) uuid(id);
  check(input.tenantId === tenantId, "TENANT_MISMATCH"); check(input.actionType === "contract.send");
  version(input.actionVersion); hash(input.actionHash);
}
function requiredSteps(input: EvelynCreateApprovalRequest): 0 | 1 | 2 {
  if (input.action.amount >= 500_000) return 2;
  const evidence = input.policyEvidence;
  return evidence.standardContract && evidence.approvedOffer && evidence.customerAccepted && evidence.approvedTemplate ? 0 : 1;
}
const approvalStatuses: readonly EvelynApprovalStatus[] = ["PENDING", "STEP_1_APPROVED", "APPROVED", "REJECTED", "CHANGES_REQUESTED", "EXPIRED", "CANCELLED", "INVALIDATED"];
const verificationStatuses: readonly EvelynVerificationStatus[] = ["VALID", "INVALID", "PENDING", "EXPIRED", "REJECTED", "VERSION_MISMATCH", "ACTION_MISMATCH", "TENANT_MISMATCH"];
function parseCreate(value: unknown, input: EvelynCreateApprovalRequest): EvelynCreateApprovalResponse {
  const code = "MALFORMED_RESPONSE";
  exact(value, ["contractVersion", "environment", "approvalReference", "actionId", "actionVersion", "actionHash", "requiredSteps", "status", "auditReference", "correlationId"], code);
  check(value.contractVersion === "create-approval-request-v1" && value.environment === "preview", code);
  uuid(value.approvalReference, code); uuid(value.auditReference, code);
  check(value.actionId === input.action.actionId && value.actionVersion === input.action.actionVersion
    && value.actionHash === input.actionHash && value.correlationId === input.correlationId, "RESPONSE_BINDING_MISMATCH");
  check(value.requiredSteps === requiredSteps(input) && approvalStatuses.includes(value.status as EvelynApprovalStatus), code);
  return value as EvelynCreateApprovalResponse;
}
function parseVerify(value: unknown, input: EvelynVerifyRequest): EvelynVerifiedApproval {
  const code = "MALFORMED_RESPONSE";
  exact(value, ["contractVersion", "environment", "status", "approvalReference", "correlationId"], code);
  check(value.contractVersion === "approval-bridge-v1" && value.environment === "preview"
    && verificationStatuses.includes(value.status as EvelynVerificationStatus), code);
  check(value.approvalReference === input.approvalReference && value.correlationId === input.correlationId, "RESPONSE_BINDING_MISMATCH");
  if (value.status !== "VALID") deny(value.status as EvelynVerificationStatus);
  return value as EvelynVerifiedApproval;
}

function validateCreateV2(input: EvelynCreateApprovalRequestV2, tenantId: string): EvelynApprovalActionV2 {
  exact(input, ["contractVersion", "requestId", "correlationId", "action", "actionHash", "policyEvidence", "policyReferences"]);
  check(input.contractVersion === "create-approval-request-v2"); uuid(input.requestId); uuid(input.correlationId);
  const parsedAction = approvalActionV2InputSchema.safeParse(input.action);
  check(parsedAction.success);
  check(parsedAction.data.tenantId === tenantId, "TENANT_MISMATCH");
  check(parsedAction.data.correlationId === input.correlationId, "ACTION_MISMATCH");
  check(parsedAction.data.payload.recipient.email.endsWith(".invalid")
    && parsedAction.data.payload.contract.content.startsWith("SYNTHETIC")
    && parsedAction.data.payload.scope.description.startsWith("SYNTHETIC"));
  hash(input.actionHash);
  check(approvalActionV2Hash({ ...parsedAction.data, environment: "preview", synthetic: true }) === input.actionHash, "ACTION_MISMATCH");
  const evidence = input.policyEvidence, references = input.policyReferences;
  exact(evidence, ["financialTotalKnown", "standardContract", "approvedOffer", "customerAccepted", "approvedTemplate"]);
  for (const field of ["financialTotalKnown", "standardContract", "approvedOffer", "customerAccepted", "approvedTemplate"] as const) {
    check(typeof evidence[field] === "boolean");
  }
  if (parsedAction.data.financialSnapshot.reviewState === "COMPLETE") check(evidence.financialTotalKnown === true);
  exact(references, ["approvedOfferId", "customerAcceptanceId", "approvedTemplateId"]);
  for (const reference of Object.values(references)) if (reference !== null) uuid(reference);
  check(!evidence.approvedOffer || references.approvedOfferId !== null);
  check(!evidence.customerAccepted || references.customerAcceptanceId !== null);
  check(!evidence.approvedTemplate || references.approvedTemplateId !== null);
  return parsedAction.data;
}
function validateVerifyV2(input: EvelynVerifyRequestV2, tenantId: string) {
  exact(input, ["contractVersion", "approvalReference", "tenantId", "actionId", "actionType", "resourceId", "actionVersion",
    "actionHash", "financialSnapshotSchemaVersion", "financialSnapshotHash", "economicCommitment", "correlationId"]);
  check(input.contractVersion === "verify-approval-v2");
  for (const id of [input.approvalReference, input.tenantId, input.actionId, input.resourceId, input.correlationId]) uuid(id);
  check(input.tenantId === tenantId, "TENANT_MISMATCH"); check(input.actionType === "contract.send");
  version(input.actionVersion); hash(input.actionHash); hash(input.financialSnapshotHash);
  check(input.financialSnapshotSchemaVersion === "financial-snapshot-v1");
  exact(input.economicCommitment, ["basis", "amount"]); check(input.economicCommitment.basis === "NET");
  if (input.economicCommitment.amount !== null) check(moneyV2Schema.safeParse(input.economicCommitment.amount).success);
}
function requiredStepsV2(input: EvelynCreateApprovalRequestV2): 0 | 1 | 2 | null {
  const context = v2ThresholdContext({ ...input.action, environment: "preview", synthetic: true });
  if (context.status === "NEEDS_REVIEW") return null;
  if (context.status === "POLICY_REQUIRED") deny("POLICY_REQUIRED");
  if (context.atLeast5000) return 2;
  const evidence = input.policyEvidence;
  return evidence.standardContract && evidence.approvedOffer && evidence.customerAccepted && evidence.approvedTemplate ? 0 : 1;
}
const createApprovalStatusesV2: readonly EvelynCreateApprovalStatusV2[] = [...approvalStatuses, "NEEDS_REVIEW"];
const verificationStatusesV2: readonly EvelynVerificationStatusV2[] = [...verificationStatuses, "NEEDS_REVIEW", "POLICY_REQUIRED"];
function parseCreateV2(value: unknown, input: EvelynCreateApprovalRequestV2): EvelynCreateApprovalResponseV2 {
  const code = "MALFORMED_RESPONSE";
  exact(value, ["contractVersion", "environment", "approvalReference", "actionId", "actionVersion", "actionHash",
    "financialSnapshotHash", "requiredSteps", "status", "auditReference", "correlationId"], code);
  check(value.contractVersion === "create-approval-request-v2" && value.environment === "preview", code);
  uuid(value.approvalReference, code); uuid(value.auditReference, code);
  check(value.actionId === input.action.actionId && value.actionVersion === input.action.actionVersion
    && value.actionHash === input.actionHash && value.financialSnapshotHash === input.action.financialSnapshotHash
    && value.correlationId === input.correlationId, "RESPONSE_BINDING_MISMATCH");
  const expectedSteps = requiredStepsV2(input);
  check(value.requiredSteps === expectedSteps && createApprovalStatusesV2.includes(value.status as EvelynCreateApprovalStatusV2), code);
  if (expectedSteps === null) check(["NEEDS_REVIEW", "INVALIDATED", "CANCELLED", "EXPIRED"].includes(value.status as string), code);
  else check(value.status !== "NEEDS_REVIEW", code);
  return value as EvelynCreateApprovalResponseV2;
}
function parseVerifyV2(value: unknown, input: EvelynVerifyRequestV2): EvelynVerifiedApprovalV2 {
  const code = "MALFORMED_RESPONSE";
  exact(value, ["contractVersion", "environment", "status", "approvalReference", "correlationId"], code);
  check(value.contractVersion === "approval-bridge-v2" && value.environment === "preview"
    && verificationStatusesV2.includes(value.status as EvelynVerificationStatusV2), code);
  check(value.approvalReference === input.approvalReference && value.correlationId === input.correlationId, "RESPONSE_BINDING_MISMATCH");
  if (value.status !== "VALID") deny(value.status as EvelynVerificationStatusV2);
  return value as EvelynVerifiedApprovalV2;
}
type TokenOptions = { audience: string; jti: string; skipCache: true };
export interface EvelynApprovalClient {
  requestApproval(input: EvelynCreateApprovalRequest): Promise<EvelynCreateApprovalResponse>;
  verifyApproval(input: EvelynVerifyRequest): Promise<EvelynVerifiedApproval>;
}
export interface EvelynApprovalV2Client {
  requestApprovalV2(input: EvelynCreateApprovalRequestV2): Promise<EvelynCreateApprovalResponseV2>;
  verifyApprovalV2(input: EvelynVerifyRequestV2): Promise<EvelynVerifiedApprovalV2>;
}
type Transport = {
  fetch: typeof globalThis.fetch;
  getToken: (options?: TokenOptions) => Promise<string>;
  nonce: () => string;
  timeoutMs: number;
  assertRuntime: () => void;
};
function createClient(tenantId: string, transport: Transport): EvelynApprovalClient {
  uuid(tenantId);
  check(Number.isSafeInteger(transport.timeoutMs) && transport.timeoutMs > 0 && transport.timeoutMs <= 12_000);
  async function call(input: unknown, operation: "create" | "verify"): Promise<unknown> {
    transport.assertRuntime();
    // Snapshot before the first await: browser/caller mutation cannot change signed bytes.
    const encoded = JSON.stringify(input);
    check(Buffer.byteLength(encoded) <= 16_384, "REQUEST_TOO_LARGE");
    const snapshot: unknown = JSON.parse(encoded), nonce = transport.nonce();
    const jti = evelynRequestJti(nonce, snapshot, operation);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new EvelynApprovalError("TIMEOUT")); }, transport.timeoutMs);
    });
    const request = async () => {
      const token = await transport.getToken({ audience: EVELYN_PREVIEW_AUDIENCE, jti, skipCache: true });
      const protection = await transport.getToken();
      check(typeof token === "string" && token.length > 0 && typeof protection === "string" && protection.length > 0, "SERVICE_IDENTITY_UNAVAILABLE");
      transport.assertRuntime();
      controller.signal.throwIfAborted();
      const response = await transport.fetch(EVELYN_PREVIEW_URL + (operation === "create" ? "/api/v1/approvals/requests" : "/api/v1/approvals/verify"), {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`,
          "x-vercel-trusted-oidc-idp-token": protection, "x-evelyn-request-nonce": nonce },
        body: encoded, cache: "no-store", redirect: "error", signal: controller.signal,
      });
      if (!response.ok) deny(`HTTP_${response.status}`);
      check(response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json", "MALFORMED_RESPONSE");
      check(Number(response.headers.get("content-length") ?? 0) <= 16_384, "MALFORMED_RESPONSE");
      const reader = response.body?.getReader(); check(reader, "MALFORMED_RESPONSE");
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 16_384) { await reader.cancel(); deny("MALFORMED_RESPONSE"); }
        chunks.push(chunk.value);
      }
      try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
      catch { deny("MALFORMED_RESPONSE"); }
    };
    try { return await Promise.race([request(), timeout]); }
    catch (error) { if (error instanceof EvelynApprovalError) throw error; deny("SERVICE_UNAVAILABLE"); }
    finally { if (timer) clearTimeout(timer); }
  }
  return Object.freeze({
    async requestApproval(input: EvelynCreateApprovalRequest) {
      validateCreate(input, tenantId);
      const snapshot = structuredClone(input);
      return parseCreate(await call(snapshot, "create"), snapshot);
    },
    async verifyApproval(input: EvelynVerifyRequest) {
      validateVerify(input, tenantId);
      const snapshot = structuredClone(input);
      return parseVerify(await call(snapshot, "verify"), snapshot);
    },
  });
}
function createV2Client(tenantId: string, transport: Transport): EvelynApprovalV2Client {
  uuid(tenantId);
  check(Number.isSafeInteger(transport.timeoutMs) && transport.timeoutMs > 0 && transport.timeoutMs <= 12_000);
  async function call(input: unknown, operation: "create" | "verify"): Promise<unknown> {
    transport.assertRuntime();
    // Snapshot and bound the exact signed bytes before the first token acquisition.
    const encoded = JSON.stringify(input);
    check(Buffer.byteLength(encoded) <= 16_384, "REQUEST_TOO_LARGE");
    const snapshot: unknown = JSON.parse(encoded), nonce = transport.nonce();
    const jti = evelynRequestJtiV2(nonce, snapshot, operation);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new EvelynApprovalError("TIMEOUT")); }, transport.timeoutMs);
    });
    const request = async () => {
      const token = await transport.getToken({ audience: EVELYN_PREVIEW_AUDIENCE, jti, skipCache: true });
      const protection = await transport.getToken();
      check(typeof token === "string" && token.length > 0 && typeof protection === "string" && protection.length > 0, "SERVICE_IDENTITY_UNAVAILABLE");
      transport.assertRuntime();
      controller.signal.throwIfAborted();
      const response = await transport.fetch(EVELYN_V2_PREVIEW_URL + (operation === "create" ? "/api/v2/approvals/requests" : "/api/v2/approvals/verify"), {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`,
          "x-vercel-trusted-oidc-idp-token": protection, "x-evelyn-request-nonce": nonce },
        body: encoded, cache: "no-store", redirect: "error", signal: controller.signal,
      });
      if (!response.ok) deny(`HTTP_${response.status}`);
      check(response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json", "MALFORMED_RESPONSE");
      check(Number(response.headers.get("content-length") ?? 0) <= 16_384, "MALFORMED_RESPONSE");
      const reader = response.body?.getReader(); check(reader, "MALFORMED_RESPONSE");
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 16_384) { await reader.cancel(); deny("MALFORMED_RESPONSE"); }
        chunks.push(chunk.value);
      }
      try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
      catch { deny("MALFORMED_RESPONSE"); }
    };
    try { return await Promise.race([request(), timeout]); }
    catch (error) { if (error instanceof EvelynApprovalError) throw error; deny("SERVICE_UNAVAILABLE"); }
    finally { if (timer) clearTimeout(timer); }
  }
  return Object.freeze({
    async requestApprovalV2(input: EvelynCreateApprovalRequestV2) {
      const action = validateCreateV2(input, tenantId);
      const snapshot = structuredClone({ ...input, action });
      requiredStepsV2(snapshot);
      assertEvelynApprovalV2RequestSize(snapshot);
      return parseCreateV2(await call(snapshot, "create"), snapshot);
    },
    async verifyApprovalV2(input: EvelynVerifyRequestV2) {
      validateVerifyV2(input, tenantId);
      const snapshot = structuredClone(input);
      return parseVerifyV2(await call(snapshot, "verify"), snapshot);
    },
  });
}
function assertLiveCrmPreview() {
  check(process.env.VERCEL === "1" && process.env.VERCEL_ENV === "preview"
    && (!process.env.VERCEL_TARGET_ENV || process.env.VERCEL_TARGET_ENV === "preview")
    && process.env.VERCEL_PROJECT_ID === CRM_VERCEL_PROJECT_ID, "REAL_CRM_PREVIEW_REQUIRED");
}
/** Only the platform SDK supplies identities. Evelyn verifies signed team/project claims. */
export function createEvelynApprovalClient(tenantId: string): EvelynApprovalClient {
  assertLiveCrmPreview();
  return createClient(tenantId, { fetch: globalThis.fetch, getToken: getVercelOidcToken,
    nonce: randomUUID, timeoutMs: 12_000, assertRuntime: assertLiveCrmPreview });
}
export function createEvelynApprovalV2Client(tenantId: string): EvelynApprovalV2Client {
  assertLiveCrmPreview();
  return createV2Client(tenantId, { fetch: globalThis.fetch, getToken: getVercelOidcToken,
    nonce: randomUUID, timeoutMs: 12_000, assertRuntime: assertLiveCrmPreview });
}
/** Explicit simulated transport port. This is unavailable in deployed/production runtimes. */
export function createEvelynApprovalClientForTests(tenantId: string, transport: Omit<Transport, "assertRuntime">): EvelynApprovalClient {
  const assertTestRuntime = () => check(process.env.NODE_ENV === "test" && process.env.VERCEL === undefined, "TEST_TRANSPORT_FORBIDDEN");
  assertTestRuntime();
  return createClient(tenantId, { ...transport, assertRuntime: assertTestRuntime });
}
export function createEvelynApprovalV2ClientForTests(tenantId: string, transport: Omit<Transport, "assertRuntime">): EvelynApprovalV2Client {
  const assertTestRuntime = () => check(process.env.NODE_ENV === "test" && process.env.VERCEL === undefined, "TEST_TRANSPORT_FORBIDDEN");
  assertTestRuntime();
  return createV2Client(tenantId, { ...transport, assertRuntime: assertTestRuntime });
}
