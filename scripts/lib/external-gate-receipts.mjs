import {
  createHash,
  createPublicKey,
  verify as verifyDetachedSignature,
} from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const externalGateReceiptRoles = Object.freeze([
  "accessibility-owner",
  "accessibility-product-owner",
  "accessibility-release-owner",
  "blob-migration-attestor",
  "github-actions-attestor",
  "observability-owner",
  "runtime-logs-owner",
  "cleanup-owner",
  "supply-chain-owner",
  "company-profile-approver",
  "provider-resend-domain-owner",
  "provider-calendar-owner",
  "provider-final-cleanup-attestor",
  "performance-manual-owner",
  "performance-rum-attestor",
  "performance-budget-product",
  "performance-budget-engineering",
  "performance-budget-operations",
  "launch-activation-attestor",
  "production-funnel-token-cutover-attestor",
  "production-cutover-dba",
  "production-cutover-platform-operations",
  "production-cutover-release-observer",
]);

export const externalGateTrustAnchorRecordType =
  "NOVALURE_RELEASE_APPROVAL_TRUST_ANCHOR";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const trustAnchorIdPattern = /^ta_[A-Za-z0-9_-]{8,120}$/u;
const keyIdPattern = /^key_[A-Za-z0-9_-]{8,120}$/u;
const receiptIdPattern = /^grc_[a-f0-9]{32,64}$/u;
const signerSubjectPattern = /^subject:[A-Za-z0-9][A-Za-z0-9._:@/-]{7,240}$/u;
const recordTypePattern = /^NOVALURE_[A-Z0-9_]{8,120}$/u;
const maximumTrustAnchorBytes = 64 * 1024;

function invariant(condition, code) {
  if (!condition) throw new Error(code);
}

export function isPlainObject(value) {
  return Boolean(
    value
      && typeof value === "object"
      && !Array.isArray(value)
      && Object.getPrototypeOf(value) === Object.prototype,
  );
}

export function assertExactObjectKeys(value, expectedKeys, code) {
  invariant(isPlainObject(value), `${code}_OBJECT_REQUIRED`);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  invariant(
    actual.length === expected.length
      && actual.every((key, index) => key === expected[index]),
    `${code}_KEYS_INVALID`,
  );
}

export function canonicalJson(value) {
  const normalize = (input) => {
    if (Array.isArray(input)) return input.map(normalize);
    if (!isPlainObject(input)) return input;
    return Object.fromEntries(
      Object.keys(input).sort().map((key) => [key, normalize(input[key])]),
    );
  };
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function requireSha256(value, code) {
  invariant(sha256Pattern.test(value ?? ""), code);
  return value;
}

export function requireIsoTimestamp(value, code) {
  const parsed = typeof value === "string" ? new Date(value) : null;
  const canonicalValue = typeof value === "string" && !value.includes(".")
    ? value.replace(/Z$/u, ".000Z")
    : value;
  invariant(
    typeof value === "string"
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
      && parsed !== null
      && !Number.isNaN(parsed.getTime())
      && parsed.toISOString() === canonicalValue,
    code,
  );
  return value;
}

export function requireSafeText(value, code, {
  maximumLength = 240,
  pattern = /^[A-Za-z0-9][A-Za-z0-9 ._:@/+()-]*$/u,
} = {}) {
  invariant(
    typeof value === "string"
      && value.length > 0
      && value.length <= maximumLength
      && !/[\u0000-\u001f\u007f]/u.test(value)
      && pattern.test(value),
    code,
  );
  return value;
}

export function validateExternalGateRuntimeBinding(runtime, expectedRuntime = null) {
  assertExactObjectKeys(runtime, [
    "candidateCommit",
    "databaseBranchId",
    "deploymentHost",
    "deploymentId",
    "gitBranch",
    "productionMutationPerformed",
  ], "EXTERNAL_GATE_RUNTIME");
  invariant(commitPattern.test(runtime.candidateCommit ?? ""), "EXTERNAL_GATE_RUNTIME_CANDIDATE_INVALID");
  invariant(
    /^br-[A-Za-z0-9-]{8,128}$/u.test(runtime.databaseBranchId ?? ""),
    "EXTERNAL_GATE_RUNTIME_DATABASE_BRANCH_INVALID",
  );
  invariant(
    /^dpl_[A-Za-z0-9]{20,80}$/u.test(runtime.deploymentId ?? ""),
    "EXTERNAL_GATE_RUNTIME_DEPLOYMENT_INVALID",
  );
  invariant(
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.vercel\.app$/u
      .test(runtime.deploymentHost ?? ""),
    "EXTERNAL_GATE_RUNTIME_HOST_INVALID",
  );
  invariant(
    typeof runtime.gitBranch === "string"
      && runtime.gitBranch.startsWith("codex/")
      && runtime.gitBranch.length <= 250
      && !/[\u0000-\u001f\u007f]/u.test(runtime.gitBranch),
    "EXTERNAL_GATE_RUNTIME_BRANCH_INVALID",
  );
  invariant(
    runtime.productionMutationPerformed === false,
    "EXTERNAL_GATE_RUNTIME_PRODUCTION_MUTATION_RECORDED",
  );
  if (expectedRuntime !== null) {
    assertExactObjectKeys(expectedRuntime, Object.keys(runtime), "EXTERNAL_GATE_EXPECTED_RUNTIME");
    for (const key of Object.keys(runtime)) {
      invariant(runtime[key] === expectedRuntime[key], `EXTERNAL_GATE_RUNTIME_${key.toUpperCase()}_MISMATCH`);
    }
  }
  return runtime;
}

function validatePublicKey(key) {
  assertExactObjectKeys(key, [
    "algorithm",
    "keyId",
    "publicKeyPem",
    "role",
    "signerSubject",
    "status",
  ], "EXTERNAL_GATE_TRUST_KEY");
  invariant(key.algorithm === "Ed25519", "EXTERNAL_GATE_TRUST_KEY_ALGORITHM_INVALID");
  invariant(keyIdPattern.test(key.keyId ?? ""), "EXTERNAL_GATE_TRUST_KEY_ID_INVALID");
  requireSafeText(key.role, "EXTERNAL_GATE_TRUST_KEY_ROLE_INVALID", {
    maximumLength: 80,
    pattern: /^[a-z][a-z0-9-]{2,79}$/u,
  });
  invariant(
    signerSubjectPattern.test(key.signerSubject ?? ""),
    "EXTERNAL_GATE_TRUST_KEY_SUBJECT_INVALID",
  );
  invariant(key.status === "ACTIVE", "EXTERNAL_GATE_TRUST_KEY_INACTIVE");
  invariant(
    typeof key.publicKeyPem === "string"
      && key.publicKeyPem.length <= 1_024
      && /^-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/]{1,64}={0,2}\r?\n)+-----END PUBLIC KEY-----\r?\n?$/u
        .test(key.publicKeyPem),
    "EXTERNAL_GATE_TRUST_KEY_PUBLIC_KEY_INVALID",
  );
  let publicKey;
  try {
    publicKey = createPublicKey(key.publicKeyPem);
  } catch {
    invariant(false, "EXTERNAL_GATE_TRUST_KEY_PUBLIC_KEY_INVALID");
  }
  invariant(publicKey.asymmetricKeyType === "ed25519", "EXTERNAL_GATE_TRUST_KEY_TYPE_INVALID");
  return publicKey;
}

export function validateExternalGateTrustContext(
  trustContext,
  { requiredRoles = [] } = {},
) {
  invariant(isPlainObject(trustContext), "EXTERNAL_GATE_TRUST_CONTEXT_REQUIRED");
  const { anchor, expectedSha256 } = trustContext;
  requireSha256(expectedSha256, "EXTERNAL_GATE_TRUST_EXPECTED_DIGEST_REQUIRED");
  assertExactObjectKeys(anchor, [
    "keys",
    "recordType",
    "schemaVersion",
    "trustAnchorId",
  ], "EXTERNAL_GATE_TRUST_ANCHOR");
  invariant(anchor.schemaVersion === 1, "EXTERNAL_GATE_TRUST_ANCHOR_SCHEMA_INVALID");
  invariant(
    anchor.recordType === externalGateTrustAnchorRecordType,
    "EXTERNAL_GATE_TRUST_ANCHOR_TYPE_INVALID",
  );
  invariant(
    trustAnchorIdPattern.test(anchor.trustAnchorId ?? ""),
    "EXTERNAL_GATE_TRUST_ANCHOR_ID_INVALID",
  );
  invariant(Array.isArray(anchor.keys) && anchor.keys.length > 0, "EXTERNAL_GATE_TRUST_ANCHOR_KEYS_MISSING");
  const roles = new Set();
  const keyIds = new Set();
  for (const key of anchor.keys) {
    validatePublicKey(key);
    invariant(!roles.has(key.role), "EXTERNAL_GATE_TRUST_ROLE_DUPLICATED");
    invariant(!keyIds.has(key.keyId), "EXTERNAL_GATE_TRUST_KEY_REUSED");
    roles.add(key.role);
    keyIds.add(key.keyId);
  }
  invariant(
    requiredRoles.every((role) => externalGateReceiptRoles.includes(role) && roles.has(role)),
    "EXTERNAL_GATE_TRUST_REQUIRED_ROLE_MISSING",
  );
  return trustContext;
}

export function assertExternalGateRoleIndependence(trustContext, requiredRoles) {
  validateExternalGateTrustContext(trustContext, { requiredRoles });
  const signerSubjects = new Set();
  const publicKeyFingerprints = new Set();
  for (const role of requiredRoles) {
    const key = trustContext.anchor.keys.find((candidate) => candidate.role === role);
    invariant(key, "EXTERNAL_GATE_TRUST_REQUIRED_ROLE_MISSING");
    const publicKey = validatePublicKey(key);
    const publicKeyFingerprint = sha256(publicKey.export({ format: "der", type: "spki" }));
    invariant(
      !signerSubjects.has(key.signerSubject),
      "EXTERNAL_GATE_TRUST_SIGNER_SUBJECT_REUSED",
    );
    invariant(
      !publicKeyFingerprints.has(publicKeyFingerprint),
      "EXTERNAL_GATE_TRUST_PUBLIC_KEY_REUSED",
    );
    signerSubjects.add(key.signerSubject);
    publicKeyFingerprints.add(publicKeyFingerprint);
  }
  return trustContext;
}

function isOutsideDirectory(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent.startsWith(`..${sep}`) || pathFromParent === ".." || isAbsolute(pathFromParent);
}

export async function loadExternalGateTrustContext({
  anchorPath,
  expectedSha256,
  repositoryRoot = process.cwd(),
  requiredRoles = [],
}) {
  invariant(typeof anchorPath === "string" && isAbsolute(anchorPath), "EXTERNAL_GATE_TRUST_PATH_ABSOLUTE_REQUIRED");
  requireSha256(expectedSha256, "EXTERNAL_GATE_TRUST_EXPECTED_DIGEST_REQUIRED");
  const resolvedAnchor = resolve(anchorPath);
  const state = await lstat(resolvedAnchor);
  invariant(
    state.isFile()
      && !state.isSymbolicLink()
      && state.nlink === 1
      && state.size > 0
      && state.size <= maximumTrustAnchorBytes,
    "EXTERNAL_GATE_TRUST_ANCHOR_NOT_BOUNDED_REGULAR_FILE",
  );
  const [realAnchor, realRepository] = await Promise.all([
    realpath(resolvedAnchor),
    realpath(resolve(repositoryRoot)),
  ]);
  invariant(
    isOutsideDirectory(realRepository, realAnchor),
    "EXTERNAL_GATE_TRUST_ANCHOR_MUST_BE_OUTSIDE_REPOSITORY",
  );
  const source = await readFile(realAnchor);
  invariant(sha256(source) === expectedSha256, "EXTERNAL_GATE_TRUST_ANCHOR_DIGEST_MISMATCH");
  let anchor;
  try {
    anchor = JSON.parse(source.toString("utf8"));
  } catch {
    invariant(false, "EXTERNAL_GATE_TRUST_ANCHOR_JSON_INVALID");
  }
  invariant(
    source.toString("utf8") === canonicalJson(anchor),
    "EXTERNAL_GATE_TRUST_ANCHOR_NOT_CANONICAL",
  );
  return Object.freeze(validateExternalGateTrustContext(
    { anchor, expectedSha256 },
    { requiredRoles },
  ));
}

function signatureReference(receipt) {
  return [
    "urn:novalure:gate-receipt:v1",
    receipt.trustAnchorId,
    receipt.keyId,
    receipt.role,
    receipt.recordType,
    receipt.payloadSha256,
  ].join(":");
}

export function buildExternalGateReceiptSigningPayload(receipt) {
  return canonicalJson({
    keyId: receipt.keyId,
    payload: receipt.payload,
    payloadSha256: receipt.payloadSha256,
    receiptId: receipt.receiptId,
    recordType: receipt.recordType,
    role: receipt.role,
    schemaVersion: receipt.schemaVersion,
    signatureAlgorithm: receipt.signatureAlgorithm,
    signatureReference: receipt.signatureReference,
    signedAt: receipt.signedAt,
    signerSubject: receipt.signerSubject,
    trustAnchorId: receipt.trustAnchorId,
    trustAnchorSha256: receipt.trustAnchorSha256,
  });
}

function decodeDetachedSignature(value) {
  invariant(
    typeof value === "string" && /^[A-Za-z0-9+/]{86}==$/u.test(value),
    "EXTERNAL_GATE_RECEIPT_SIGNATURE_INVALID",
  );
  const decoded = Buffer.from(value, "base64");
  invariant(
    decoded.length === 64 && decoded.toString("base64") === value,
    "EXTERNAL_GATE_RECEIPT_SIGNATURE_INVALID",
  );
  return decoded;
}

export function verifyExternalGateReceipt({
  expectedRecordType,
  expectedRole,
  receipt,
  trustContext,
}) {
  invariant(
    externalGateReceiptRoles.includes(expectedRole),
    "EXTERNAL_GATE_RECEIPT_EXPECTED_ROLE_INVALID",
  );
  invariant(recordTypePattern.test(expectedRecordType ?? ""), "EXTERNAL_GATE_RECEIPT_EXPECTED_TYPE_INVALID");
  validateExternalGateTrustContext(trustContext, { requiredRoles: [expectedRole] });
  assertExactObjectKeys(receipt, [
    "detachedSignature",
    "keyId",
    "payload",
    "payloadSha256",
    "receiptId",
    "recordType",
    "role",
    "schemaVersion",
    "signatureAlgorithm",
    "signatureReference",
    "signedAt",
    "signerSubject",
    "trustAnchorId",
    "trustAnchorSha256",
  ], "EXTERNAL_GATE_RECEIPT");
  invariant(receipt.schemaVersion === 1, "EXTERNAL_GATE_RECEIPT_SCHEMA_INVALID");
  invariant(receipt.recordType === expectedRecordType, "EXTERNAL_GATE_RECEIPT_TYPE_MISMATCH");
  invariant(receiptIdPattern.test(receipt.receiptId ?? ""), "EXTERNAL_GATE_RECEIPT_ID_INVALID");
  invariant(receipt.role === expectedRole, "EXTERNAL_GATE_RECEIPT_ROLE_MISMATCH");
  invariant(receipt.signatureAlgorithm === "Ed25519", "EXTERNAL_GATE_RECEIPT_ALGORITHM_INVALID");
  requireIsoTimestamp(receipt.signedAt, "EXTERNAL_GATE_RECEIPT_SIGNED_AT_INVALID");
  invariant(isPlainObject(receipt.payload), "EXTERNAL_GATE_RECEIPT_PAYLOAD_INVALID");
  invariant(
    sha256(canonicalJson(receipt.payload)) === requireSha256(
      receipt.payloadSha256,
      "EXTERNAL_GATE_RECEIPT_PAYLOAD_DIGEST_INVALID",
    ),
    "EXTERNAL_GATE_RECEIPT_PAYLOAD_DIGEST_MISMATCH",
  );
  invariant(
    receipt.trustAnchorId === trustContext.anchor.trustAnchorId,
    "EXTERNAL_GATE_RECEIPT_TRUST_ANCHOR_MISMATCH",
  );
  invariant(
    receipt.trustAnchorSha256 === trustContext.expectedSha256,
    "EXTERNAL_GATE_RECEIPT_TRUST_DIGEST_MISMATCH",
  );
  invariant(
    receipt.signatureReference === signatureReference(receipt),
    "EXTERNAL_GATE_RECEIPT_REFERENCE_INVALID",
  );
  const trustedKey = trustContext.anchor.keys.find((key) => key.role === expectedRole);
  invariant(trustedKey, "EXTERNAL_GATE_RECEIPT_TRUSTED_KEY_MISSING");
  invariant(receipt.keyId === trustedKey.keyId, "EXTERNAL_GATE_RECEIPT_KEY_MISMATCH");
  invariant(receipt.signerSubject === trustedKey.signerSubject, "EXTERNAL_GATE_RECEIPT_SUBJECT_MISMATCH");
  const verified = verifyDetachedSignature(
    null,
    Buffer.from(buildExternalGateReceiptSigningPayload(receipt), "utf8"),
    validatePublicKey(trustedKey),
    decodeDetachedSignature(receipt.detachedSignature),
  );
  invariant(verified, "EXTERNAL_GATE_RECEIPT_SIGNATURE_VERIFICATION_FAILED");
  return receipt;
}
