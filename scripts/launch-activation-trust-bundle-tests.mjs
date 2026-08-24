#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign,
} from "node:crypto";
import test from "node:test";

import {
  canonicalJson,
  externalGateTrustAnchorRecordType,
  sha256,
} from "./lib/external-gate-receipts-runtime.mjs";
import {
  buildLaunchActivationTrustBundleSigningPayload,
  decodeLaunchActivationTrustBundle,
  launchActivationTrustBundleRecordType,
  verifyLaunchActivationTrustBundle,
} from "./lib/launch-activation-trust-bundle.mjs";

const requiredRoles = Object.freeze([
  "launch-activation-attestor",
  "production-cutover-dba",
  "production-cutover-platform-operations",
  "production-cutover-release-observer",
]);

function createFixture() {
  const keys = requiredRoles.map((role, index) => {
    const pair = generateKeyPairSync("ed25519");
    return {
      algorithm: "Ed25519",
      keyId: `key_launch_runtime_${index}_20260824`,
      publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
      role,
      signerSubject: `subject:novalure-${role}-owner`,
      status: "ACTIVE",
    };
  });
  const anchor = {
    keys,
    recordType: externalGateTrustAnchorRecordType,
    schemaVersion: 1,
    trustAnchorId: "ta_launch_runtime_20260824",
  };
  const rootPair = generateKeyPairSync("ed25519");
  const rootPublicKeyPem = rootPair.publicKey
    .export({ format: "pem", type: "spki" })
    .toString();
  const pinnedRoot = {
    algorithm: "Ed25519",
    keyId: "root_launch_activation_20260824",
    minimumAnchorGeneration: 7,
    publicKeyPem: rootPublicKeyPem,
    publicKeySha256: sha256(Buffer.from(rootPublicKeyPem, "utf8")),
    status: "ACTIVE",
  };
  const bundle = {
    anchor,
    anchorGeneration: 7,
    anchorSha256: sha256(canonicalJson(anchor)),
    detachedSignature: "",
    recordType: launchActivationTrustBundleRecordType,
    rootKeyId: pinnedRoot.keyId,
    schemaVersion: 1,
    signatureAlgorithm: "Ed25519",
  };
  bundle.detachedSignature = sign(
    null,
    Buffer.from(buildLaunchActivationTrustBundleSigningPayload(bundle), "utf8"),
    rootPair.privateKey,
  ).toString("base64");
  return { bundle, pinnedRoot, rootPrivateKey: rootPair.privateKey };
}

function resignBundle(bundle, privateKey) {
  bundle.anchorSha256 = sha256(canonicalJson(bundle.anchor));
  bundle.detachedSignature = sign(
    null,
    Buffer.from(buildLaunchActivationTrustBundleSigningPayload(bundle), "utf8"),
    privateKey,
  ).toString("base64");
}

test("a code-pinned offline root authenticates the complete runtime trust anchor", () => {
  const fixture = createFixture();
  const encoded = Buffer.from(canonicalJson(fixture.bundle), "utf8").toString("base64url");
  const decoded = decodeLaunchActivationTrustBundle(encoded);
  const trustContext = verifyLaunchActivationTrustBundle({
    bundle: decoded,
    pinnedRoot: fixture.pinnedRoot,
    requiredRoles,
  });
  assert.deepEqual(trustContext.anchor, fixture.bundle.anchor);
  assert.equal(trustContext.expectedSha256, fixture.bundle.anchorSha256);
});

test("root substitution, revoked generations, bundle tamper and pending pins fail closed", () => {
  const fixture = createFixture();

  const revoked = structuredClone(fixture.bundle);
  revoked.anchorGeneration = fixture.pinnedRoot.minimumAnchorGeneration - 1;
  assert.throws(
    () => verifyLaunchActivationTrustBundle({
      bundle: revoked,
      pinnedRoot: fixture.pinnedRoot,
      requiredRoles,
    }),
    /LAUNCH_TRUST_BUNDLE_GENERATION_REVOKED/u,
  );

  const tampered = structuredClone(fixture.bundle);
  tampered.anchor.trustAnchorId = "ta_tampered_runtime_20260824";
  assert.throws(
    () => verifyLaunchActivationTrustBundle({
      bundle: tampered,
      pinnedRoot: fixture.pinnedRoot,
      requiredRoles,
    }),
    /LAUNCH_TRUST_BUNDLE_ANCHOR_DIGEST_MISMATCH/u,
  );

  const unrelatedPair = generateKeyPairSync("ed25519");
  const unrelatedPem = unrelatedPair.publicKey
    .export({ format: "pem", type: "spki" })
    .toString();
  assert.throws(
    () => verifyLaunchActivationTrustBundle({
      bundle: fixture.bundle,
      pinnedRoot: {
        ...fixture.pinnedRoot,
        publicKeyPem: unrelatedPem,
        publicKeySha256: sha256(Buffer.from(unrelatedPem, "utf8")),
      },
      requiredRoles,
    }),
    /LAUNCH_TRUST_BUNDLE_SIGNATURE_VERIFICATION_FAILED/u,
  );

  assert.throws(
    () => verifyLaunchActivationTrustBundle({
      bundle: fixture.bundle,
      pinnedRoot: {
        ...fixture.pinnedRoot,
        keyId: null,
        publicKeyPem: null,
        publicKeySha256: null,
        status: "PENDING_SECURITY_OWNER_KEY",
      },
      requiredRoles,
    }),
    /LAUNCH_PINNED_ROOT_NOT_ACTIVE/u,
  );
});

test("all four launch and cutover roles require independent identities and keys", () => {
  for (const [mutate, expectedError] of [
    [
      (anchor) => { anchor.keys[1].signerSubject = anchor.keys[0].signerSubject; },
      /EXTERNAL_GATE_TRUST_SIGNER_SUBJECT_REUSED/u,
    ],
    [
      (anchor) => { anchor.keys[1].publicKeyPem = anchor.keys[0].publicKeyPem; },
      /EXTERNAL_GATE_TRUST_PUBLIC_KEY_REUSED/u,
    ],
  ]) {
    const fixture = createFixture();
    const bundle = structuredClone(fixture.bundle);
    mutate(bundle.anchor);
    resignBundle(bundle, fixture.rootPrivateKey);
    assert.throws(
      () => verifyLaunchActivationTrustBundle({
        bundle,
        pinnedRoot: fixture.pinnedRoot,
        requiredRoles,
      }),
      expectedError,
    );
  }
});

test("the code-pinned root key cannot also sign a launch or cutover role", () => {
  const fixture = createFixture();
  const bundle = structuredClone(fixture.bundle);
  bundle.anchor.keys[0].publicKeyPem = fixture.pinnedRoot.publicKeyPem;
  resignBundle(bundle, fixture.rootPrivateKey);
  assert.throws(
    () => verifyLaunchActivationTrustBundle({
      bundle,
      pinnedRoot: fixture.pinnedRoot,
      requiredRoles,
    }),
    /LAUNCH_TRUST_BUNDLE_ROOT_KEY_REUSED_AS_ROLE_KEY/u,
  );
});

test("the trust-bundle transport accepts only canonical unpadded base64url JSON", () => {
  const fixture = createFixture();
  const canonical = canonicalJson(fixture.bundle);
  const encoded = Buffer.from(canonical, "utf8").toString("base64url");
  assert.deepEqual(decodeLaunchActivationTrustBundle(encoded), fixture.bundle);
  assert.throws(
    () => decodeLaunchActivationTrustBundle(`${encoded}=`),
    /LAUNCH_TRUST_BUNDLE_ENCODING_INVALID/u,
  );
  const nonCanonical = Buffer.from(JSON.stringify(fixture.bundle), "utf8").toString("base64url");
  assert.throws(
    () => decodeLaunchActivationTrustBundle(nonCanonical),
    /LAUNCH_TRUST_BUNDLE_NOT_CANONICAL/u,
  );
});
