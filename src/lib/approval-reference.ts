import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { assertCrmUuid, assertExpectedVersion, crmPayloadDigest, CrmCommandError } from "./crm-command";
export type ApprovalAction = "offer.send" | "contract.send" | "payment.execute" | "customer_data.delete" | "security.change" | "procurement.commit";
export type ApprovalScope = Readonly<{ workspaceId: string; projectId: string; resourceId: string; resourceVersion: number; actionVersion: number; action: ApprovalAction; contentDigest: string; recipient: string; totalNetCents: number; currency: "EUR"; taxBasis: "NET"; expiresAt: string }>;
export type ApprovalChannel = "evelyn_whatsapp" | "evelyn_web";
export type ApprovalTrust = Readonly<{ channel: ApprovalChannel; keyId: string; publicKey: KeyObject; actorId: string }>;
export type ApprovalEvidence = Readonly<{ environment: "simulation"; synthetic: true; approvalId: string; scopeDigest: string; actionDigest: string; actorId: string; channel: ApprovalChannel; keyId: string; decision: "APPROVE" | "REJECT" | "CHANGE"; nonce: string; challengeId: string; issuedAt: string; authenticatedAt: string; previousEvidenceDigest: string | null; signature: string }>;
const failure = (code: string): never => { throw new CrmCommandError(code, code, 409); };
const hashPattern = /^[0-9a-f]{64}$/;
function date(value: unknown): number { if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)) failure("INVALID_APPROVAL_TIME"); return Date.parse(value as string); }
export function approvalSteps(action: ApprovalAction, totalNetCents: number): 1 | 2 {
  if (!Number.isSafeInteger(totalNetCents) || totalNetCents < 0) failure("INVALID_APPROVAL_AMOUNT");
  if (["payment.execute", "customer_data.delete", "security.change"].includes(action)) return 2;
  if (["contract.send", "procurement.commit"].includes(action)) return totalNetCents >= 500000 ? 2 : 1;
  if (action === "offer.send") return 1;
  return failure("UNSUPPORTED_APPROVAL_ACTION");
}
export function approvalBinding(raw: ApprovalScope) {
  if (!raw || Object.keys(raw).sort().join(",") !== ["workspaceId", "projectId", "resourceId", "resourceVersion", "actionVersion", "action", "contentDigest", "recipient", "totalNetCents", "currency", "taxBasis", "expiresAt"].sort().join(",")) failure("INVALID_APPROVAL_SCOPE");
  assertCrmUuid(raw.workspaceId); assertCrmUuid(raw.projectId); assertCrmUuid(raw.resourceId); assertExpectedVersion(raw.resourceVersion); assertExpectedVersion(raw.actionVersion);
  if (!hashPattern.test(raw.contentDigest) || typeof raw.recipient !== "string" || !raw.recipient.trim() || raw.recipient.length > 254 || raw.currency !== "EUR" || raw.taxBasis !== "NET") failure("INVALID_APPROVAL_SCOPE");
  date(raw.expiresAt);
  const scope = Object.freeze({ ...raw });
  return Object.freeze({ scope, scopeDigest: crmPayloadDigest(scope), actionDigest: crmPayloadDigest({ action: scope.action, actionVersion: scope.actionVersion, resourceId: scope.resourceId, resourceVersion: scope.resourceVersion, contentDigest: scope.contentDigest, recipient: scope.recipient, totalNetCents: scope.totalNetCents, currency: scope.currency, taxBasis: scope.taxBasis }), requiredSteps: approvalSteps(scope.action, scope.totalNetCents) });
}
export function approvalEvidencePayload(evidence: Omit<ApprovalEvidence, "signature"> | ApprovalEvidence): string {
  const payload = Object.fromEntries(Object.entries(evidence).filter(([key]) => key !== "signature"));
  return crmPayloadDigest(payload);
}
export function validateApprovalTrust(trust: readonly ApprovalTrust[]) {
  if (trust.length !== 2 || new Set(trust.map(key => key.channel)).size !== 2 || !trust.some(key => key.channel === "evelyn_whatsapp") || !trust.some(key => key.channel === "evelyn_web") || new Set(trust.map(key => key.keyId)).size !== 2 || new Set(trust.map(key => key.actorId)).size !== 1) failure("INDEPENDENT_CHANNEL_TRUST_REQUIRED");
  const fingerprints = trust.map(key => {
    assertCrmUuid(key.actorId);
    if (key.publicKey.type !== "public" || key.publicKey.asymmetricKeyType !== "ed25519" || !key.keyId || key.keyId.length > 100) failure("INVALID_CHANNEL_TRUST");
    return createPublicKey({ key: key.publicKey.export({ format: "pem", type: "spki" }), format: "pem", type: "spki" }).export({ type: "spki", format: "der" }).toString("hex");
  });
  if (new Set(fingerprints).size !== 2) failure("INDEPENDENT_CHANNEL_TRUST_REQUIRED");
}
export function verifyApprovalEvidence(input: { scope: ApprovalScope; approvalId: string; challengeId: string; evidence: ApprovalEvidence; previous: ApprovalEvidence | null; trust: readonly ApprovalTrust[]; now: number; maxAuthenticationAgeMs: number; maxStepGapMs: number }) {
  validateApprovalTrust(input.trust);
  const binding = approvalBinding(input.scope), evidence = input.evidence;
  if (!Number.isSafeInteger(input.maxAuthenticationAgeMs) || input.maxAuthenticationAgeMs <= 0 || !Number.isSafeInteger(input.maxStepGapMs) || input.maxStepGapMs <= 0) failure("APPROVAL_TIMING_CONFIGURATION_REQUIRED");
  if (!evidence || Object.keys(evidence).sort().join(",") !== ["environment", "synthetic", "approvalId", "scopeDigest", "actionDigest", "actorId", "channel", "keyId", "decision", "nonce", "challengeId", "issuedAt", "authenticatedAt", "previousEvidenceDigest", "signature"].sort().join(",")) failure("INVALID_APPROVAL_EVIDENCE");
  const expectedChannel = input.previous ? "evelyn_web" : "evelyn_whatsapp";
  const key = input.trust.find(key => key.channel === expectedChannel);
  if (evidence.environment !== "simulation" || evidence.synthetic !== true || evidence.channel !== expectedChannel || evidence.keyId !== key?.keyId || evidence.actorId !== key?.actorId || evidence.approvalId !== input.approvalId || evidence.challengeId !== input.challengeId || evidence.scopeDigest !== binding.scopeDigest || evidence.actionDigest !== binding.actionDigest || !["APPROVE", "REJECT", "CHANGE"].includes(evidence.decision)) failure("APPROVAL_EVIDENCE_SCOPE_MISMATCH");
  assertCrmUuid(evidence.nonce); assertCrmUuid(evidence.challengeId);
  const issued = date(evidence.issuedAt), authenticated = date(evidence.authenticatedAt);
  if (date(input.scope.expiresAt) <= input.now || issued > input.now || authenticated > issued || input.now - authenticated > input.maxAuthenticationAgeMs) failure("APPROVAL_EXPIRED_OR_AUTHENTICATION_STALE");
  if (input.previous) {
    if (binding.requiredSteps !== 2 || evidence.previousEvidenceDigest !== crmPayloadDigest(input.previous) || evidence.nonce === input.previous.nonce || evidence.challengeId === input.previous.challengeId || issued < date(input.previous.issuedAt) || issued - date(input.previous.issuedAt) > input.maxStepGapMs || input.previous.decision !== "APPROVE") failure("APPROVAL_STEP_ORDER_INVALID");
  } else if (evidence.previousEvidenceDigest !== null) failure("APPROVAL_STEP_ORDER_INVALID");
  if (typeof evidence.signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(evidence.signature) || !verify(null, Buffer.from(approvalEvidencePayload(evidence)), key!.publicKey, Buffer.from(evidence.signature, "base64url"))) failure("UNTRUSTED_APPROVAL_SIGNATURE");
  return Object.freeze({ ...binding, evidenceDigest: crmPayloadDigest(evidence), decision: evidence.decision });
}
