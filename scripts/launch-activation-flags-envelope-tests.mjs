#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { brotliCompressSync } from "node:zlib";
import test from "node:test";

import {
  decodeLaunchActivationFlagsEnvelope,
  encodeLaunchActivationFlagsEnvelope,
  launchActivationFlagsEnvelopePrefix,
  launchActivationFlagsMaximumEncodedBytes,
} from "./lib/launch-activation-flags-envelope.mjs";
import "./launch-activation-flag-source-tests.mjs";
import "./launch-activation-trust-bundle-tests.mjs";

const fixture = Object.freeze({
  expected: Object.freeze({ candidateCommit: "a".repeat(40) }),
  productionCutoverDocument: Object.freeze({
    candidateCommit: "a".repeat(40),
    deployment: Object.freeze({
      rollback: Object.freeze({
        deploymentHost: "rollback.example.test",
        deploymentId: `dpl_${"R".repeat(20)}`,
      }),
    }),
    status: "PRE_ACTIVATION_READY",
    target: Object.freeze({
      stagedDeploymentHost: "staged.example.test",
      stagedDeploymentId: `dpl_${"S".repeat(20)}`,
    }),
  }),
  receipt: Object.freeze({ payloadSha256: "b".repeat(64) }),
});

test("signed launch envelope round-trips canonically within the Vercel Flags pack budget", () => {
  const encoded = encodeLaunchActivationFlagsEnvelope(fixture);
  assert.ok(encoded.value.startsWith(launchActivationFlagsEnvelopePrefix));
  assert.ok(encoded.valueBytes < launchActivationFlagsMaximumEncodedBytes);
  const decoded = decodeLaunchActivationFlagsEnvelope(encoded.value);
  assert.equal(decoded.envelopeSha256, encoded.envelopeSha256);
  assert.deepEqual(decoded.envelope.expected, fixture.expected);
  assert.deepEqual(decoded.envelope.productionCutoverDocument, fixture.productionCutoverDocument);
  assert.deepEqual(decoded.envelope.receipt, fixture.receipt);
});

test("flags envelope rejects transport tamper and non-canonical decoded JSON", () => {
  const encoded = encodeLaunchActivationFlagsEnvelope(fixture);
  const finalCharacter = encoded.value.at(-1);
  const tampered = `${encoded.value.slice(0, -1)}${finalCharacter === "A" ? "B" : "A"}`;
  assert.throws(
    () => decodeLaunchActivationFlagsEnvelope(tampered),
    /LAUNCH_FLAGS_ENVELOPE_(?:DECOMPRESSION_FAILED|ENCODING_INVALID|JSON_INVALID|NOT_CANONICAL)/u,
  );

  const nonCanonical = JSON.stringify({
    schemaVersion: 1,
    recordType: "NOVALURE_FLAGS_LAUNCH_ACTIVATION_ENVELOPE",
    receipt: fixture.receipt,
    productionCutoverDocument: fixture.productionCutoverDocument,
    expected: fixture.expected,
  });
  const nonCanonicalValue = `${launchActivationFlagsEnvelopePrefix}${brotliCompressSync(
    Buffer.from(nonCanonical, "utf8"),
  ).toString("base64url")}`;
  assert.throws(
    () => decodeLaunchActivationFlagsEnvelope(nonCanonicalValue),
    /LAUNCH_FLAGS_ENVELOPE_NOT_CANONICAL/u,
  );
});

test("Production runtime consumes the signed cutover rollback path and fails closed through instrumentation", async () => {
  const [flagSource, runtimeSource, instrumentationSource, scopeSource, channelSource] = await Promise.all([
    readFile(new URL("../src/lib/launch-activation-flag.server.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/launch-activation-runtime.server.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/instrumentation.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/launch-scope.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/launch-activation-channel.shared.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(
    flagSource,
    /productionLaunchActivationFlagKey\s*=\s*\n?\s*"novalure-production-launch-activation"/u,
  );
  assert.match(flagSource, /productionLaunchActivationFlagDefault\s*=\s*"OFF"/u);
  assert.match(flagSource, /createClient\(exactSdkKey\(environment\)/u);
  assert.match(flagSource, /client\.getDatafile\(\)/u);
  assert.match(flagSource, /evaluate<string>\(/u);
  assert.match(flagSource, /metrics\.source === "remote"/u);
  assert.match(flagSource, /metrics\.cacheStatus === "MISS"/u);
  assert.match(flagSource, /metrics\.mode === "offline"/u);
  assert.match(flagSource, /metrics\.connectionState === "disconnected"/u);
  assert.match(flagSource, /AbortSignal\.timeout\(controlPlaneRequestTimeoutMs\)/u);
  assert.match(flagSource, /polling: false/u);
  assert.match(flagSource, /stream: false/u);
  assert.doesNotMatch(flagSource, /clientState|client\.initialize\(/u);
  assert.doesNotMatch(flagSource, /flags\/next|cookies\(|headers\(/u);
  assert.match(runtimeSource, /channelRefreshIntervalMs\s*=\s*10_000/u);
  assert.match(runtimeSource, /channelFreshnessMs\s*=\s*30_000/u);
  assert.match(runtimeSource, /productionCutoverDocument\.deployment\.rollback/u);
  assert.match(runtimeSource, /productionRollback\.deploymentHost/u);
  assert.match(runtimeSource, /productionRollback\.deploymentId/u);
  assert.doesNotMatch(runtimeSource, /productionCutoverTarget\.rollbackDeployment/u);
  assert.match(runtimeSource, /verifyRuntimeProductionCutoverReceiptBundle/u);
  assert.match(runtimeSource, /verifyRuntimeLaunchActivationReceipt/u);
  assert.match(runtimeSource, /NOVALURE_LAUNCH_ACTIVATION_TRUST_BUNDLE_BASE64URL/u);
  assert.match(runtimeSource, /verifyLaunchActivationTrustBundle/u);
  assert.match(runtimeSource, /launchActivationPinnedRoot/u);
  assert.doesNotMatch(
    runtimeSource,
    /NOVALURE_LAUNCH_ACTIVATION_TRUST_ANCHOR_(?:BASE64URL|SHA256)/u,
  );
  for (const identityKey of [
    "VERCEL_GIT_COMMIT_SHA",
    "VERCEL_DEPLOYMENT_ID",
    "VERCEL_URL",
    "VERCEL_PROJECT_ID",
    "VERCEL_PROJECT_PRODUCTION_URL",
  ]) {
    assert.match(runtimeSource, new RegExp(`"${identityKey}"`, "u"));
  }
  assert.match(runtimeSource, /publicErrorCodePattern\.test\(candidateCode\)/u);
  assert.doesNotMatch(runtimeSource, /error\.message\.slice/u);
  assert.match(instrumentationSource, /await initializeProductionLaunchActivation\(\)/u);
  assert.match(scopeSource, /snapshot\.validUntilMonotonicMs <= performance\.now\(\)/u);
  assert.match(scopeSource, /ACTIVATION_CHANNEL_UNAVAILABLE/u);
  assert.match(scopeSource, /ACTIVATION_CHANNEL_OFF/u);
  assert.match(scopeSource, /ACTIVATION_CHANNEL_INVALID/u);
  assert.match(channelSource, /LAUNCH_ACTIVATION_CHANNEL_SNAPSHOT_INVALID/u);
  assert.match(channelSource, /maximumSnapshotFreshnessMs = 30_000/u);
});
