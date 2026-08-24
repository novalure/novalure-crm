import {
  createPublicKey,
  verify as verifyDetachedSignature,
} from "node:crypto";

import {
  assertExternalGateRoleIndependence,
  assertExactObjectKeys,
  canonicalJson,
  sha256,
} from "./external-gate-receipts-runtime.mjs";

export const launchActivationTrustBundleRecordType =
  "NOVALURE_LAUNCH_ACTIVATION_TRUST_BUNDLE";
export const launchActivationTrustBundleMaximumBytes = 128 * 1024;

const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const rootKeyIdPattern = /^root_[A-Za-z0-9_-]{8,120}$/u;

function invariant(condition, code) {
  if (!condition) throw new Error(code);
}

function decodeSignature(value) {
  invariant(
    typeof value === "string" && /^[A-Za-z0-9+/]{86}==$/u.test(value),
    "LAUNCH_TRUST_BUNDLE_SIGNATURE_INVALID",
  );
  const bytes = Buffer.from(value, "base64");
  invariant(
    bytes.length === 64 && bytes.toString("base64") === value,
    "LAUNCH_TRUST_BUNDLE_SIGNATURE_INVALID",
  );
  return bytes;
}

function validatePinnedRoot(root) {
  assertExactObjectKeys(root, [
    "algorithm",
    "keyId",
    "minimumAnchorGeneration",
    "publicKeyPem",
    "publicKeySha256",
    "status",
  ], "LAUNCH_PINNED_ROOT");
  invariant(root.status === "ACTIVE", "LAUNCH_PINNED_ROOT_NOT_ACTIVE");
  invariant(root.algorithm === "Ed25519", "LAUNCH_PINNED_ROOT_ALGORITHM_INVALID");
  invariant(rootKeyIdPattern.test(root.keyId ?? ""), "LAUNCH_PINNED_ROOT_KEY_ID_INVALID");
  invariant(
    Number.isSafeInteger(root.minimumAnchorGeneration)
      && root.minimumAnchorGeneration > 0,
    "LAUNCH_PINNED_ROOT_GENERATION_INVALID",
  );
  invariant(
    typeof root.publicKeyPem === "string"
      && root.publicKeyPem.length <= 1_024
      && /^-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/]{1,64}={0,2}\r?\n)+-----END PUBLIC KEY-----\r?\n?$/u.test(root.publicKeyPem),
    "LAUNCH_PINNED_ROOT_PUBLIC_KEY_INVALID",
  );
  invariant(
    digestPattern.test(root.publicKeySha256 ?? "")
      && sha256(Buffer.from(root.publicKeyPem, "utf8")) === root.publicKeySha256,
    "LAUNCH_PINNED_ROOT_PUBLIC_KEY_DIGEST_MISMATCH",
  );
  let publicKey;
  try {
    publicKey = createPublicKey(root.publicKeyPem);
  } catch {
    invariant(false, "LAUNCH_PINNED_ROOT_PUBLIC_KEY_INVALID");
  }
  invariant(publicKey.asymmetricKeyType === "ed25519", "LAUNCH_PINNED_ROOT_KEY_TYPE_INVALID");
  return publicKey;
}

export function buildLaunchActivationTrustBundleSigningPayload(bundle) {
  return canonicalJson({
    anchor: bundle.anchor,
    anchorGeneration: bundle.anchorGeneration,
    anchorSha256: bundle.anchorSha256,
    recordType: bundle.recordType,
    rootKeyId: bundle.rootKeyId,
    schemaVersion: bundle.schemaVersion,
    signatureAlgorithm: bundle.signatureAlgorithm,
  });
}

export function decodeLaunchActivationTrustBundle(value) {
  invariant(
    typeof value === "string"
      && value.length > 0
      && value.length <= Math.ceil(launchActivationTrustBundleMaximumBytes * 4 / 3)
      && base64UrlPattern.test(value),
    "LAUNCH_TRUST_BUNDLE_ENCODING_INVALID",
  );
  const source = Buffer.from(value, "base64url");
  invariant(
    source.length > 0
      && source.length <= launchActivationTrustBundleMaximumBytes
      && source.toString("base64url") === value,
    "LAUNCH_TRUST_BUNDLE_ENCODING_INVALID",
  );
  let bundle;
  try {
    bundle = JSON.parse(source.toString("utf8"));
  } catch {
    invariant(false, "LAUNCH_TRUST_BUNDLE_JSON_INVALID");
  }
  invariant(
    canonicalJson(bundle) === source.toString("utf8"),
    "LAUNCH_TRUST_BUNDLE_NOT_CANONICAL",
  );
  return bundle;
}

export function verifyLaunchActivationTrustBundle({
  bundle,
  pinnedRoot,
  requiredRoles,
}) {
  const publicKey = validatePinnedRoot(pinnedRoot);
  assertExactObjectKeys(bundle, [
    "anchor",
    "anchorGeneration",
    "anchorSha256",
    "detachedSignature",
    "recordType",
    "rootKeyId",
    "schemaVersion",
    "signatureAlgorithm",
  ], "LAUNCH_TRUST_BUNDLE");
  invariant(bundle.schemaVersion === 1, "LAUNCH_TRUST_BUNDLE_SCHEMA_INVALID");
  invariant(
    bundle.recordType === launchActivationTrustBundleRecordType,
    "LAUNCH_TRUST_BUNDLE_TYPE_INVALID",
  );
  invariant(bundle.signatureAlgorithm === "Ed25519", "LAUNCH_TRUST_BUNDLE_ALGORITHM_INVALID");
  invariant(bundle.rootKeyId === pinnedRoot.keyId, "LAUNCH_TRUST_BUNDLE_ROOT_KEY_MISMATCH");
  invariant(
    Number.isSafeInteger(bundle.anchorGeneration)
      && bundle.anchorGeneration >= pinnedRoot.minimumAnchorGeneration,
    "LAUNCH_TRUST_BUNDLE_GENERATION_REVOKED",
  );
  invariant(
    digestPattern.test(bundle.anchorSha256 ?? "")
      && sha256(canonicalJson(bundle.anchor)) === bundle.anchorSha256,
    "LAUNCH_TRUST_BUNDLE_ANCHOR_DIGEST_MISMATCH",
  );
  invariant(
    verifyDetachedSignature(
      null,
      Buffer.from(buildLaunchActivationTrustBundleSigningPayload(bundle), "utf8"),
      publicKey,
      decodeSignature(bundle.detachedSignature),
    ),
    "LAUNCH_TRUST_BUNDLE_SIGNATURE_VERIFICATION_FAILED",
  );
  const trustContext = assertExternalGateRoleIndependence(
    { anchor: bundle.anchor, expectedSha256: bundle.anchorSha256 },
    requiredRoles,
  );
  const rootPublicKeyFingerprint = sha256(
    publicKey.export({ format: "der", type: "spki" }),
  );
  for (const key of trustContext.anchor.keys) {
    const childPublicKey = createPublicKey(key.publicKeyPem);
    invariant(
      sha256(childPublicKey.export({ format: "der", type: "spki" }))
        !== rootPublicKeyFingerprint,
      "LAUNCH_TRUST_BUNDLE_ROOT_KEY_REUSED_AS_ROLE_KEY",
    );
  }
  return Object.freeze(trustContext);
}
