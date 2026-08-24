import {
  productionLaunchActivationFlagsEnvironment,
  readProductionLaunchActivationFlag,
  type ProductionLaunchActivationFlagRead,
} from "@/lib/launch-activation-flag.server";
import {
  publishLaunchActivationChannelSnapshot,
  type LaunchActivationChannelSnapshot,
} from "@/lib/launch-activation-channel";

// These audited release contracts are shared with the offline verifier so the
// runtime cannot silently accept a weaker receipt format.
import {
  canonicalJson,
} from "../../scripts/lib/external-gate-receipts-runtime.mjs";
import { decodeLaunchActivationFlagsEnvelope } from "../../scripts/lib/launch-activation-flags-envelope.mjs";
import {
  launchActivationMaximumIssuanceLeadMs,
  verifyLaunchActivationReceipt,
} from "../../scripts/lib/launch-activation-receipt.mjs";
import {
  productionCutoverReceiptRoles,
  verifyProductionCutoverReceiptBundle,
} from "../../scripts/lib/production-cutover-receipt-runtime.mjs";
import {
  decodeLaunchActivationTrustBundle,
  verifyLaunchActivationTrustBundle,
} from "../../scripts/lib/launch-activation-trust-bundle.mjs";
import { launchActivationPinnedRoot } from "@/lib/launch-activation-root-trust.server";
import { launchActivationMinimumGeneration } from "@/lib/launch-activation-contract.shared.mjs";

const channelRefreshIntervalMs = 10_000;
const channelFreshnessMs = 30_000;
const publicErrorCodePattern = /^[A-Z][A-Z0-9_]{0,119}$/u;

type RuntimeTrustContext = Readonly<{
  anchor: unknown;
  expectedSha256: string;
}>;

type RuntimeProductionCutoverVerification = Readonly<{
  candidateCommit: string;
  evidenceSha256: string;
  productionDeploymentHost: string;
  productionDeploymentId: string;
  receiptSha256ByRole: Readonly<Record<string, string>>;
  status: string;
}>;

const verifyRuntimeProductionCutoverReceiptBundle =
  verifyProductionCutoverReceiptBundle as unknown as (input: {
    document: unknown;
    expectedCandidateCommit: unknown;
    expectedTarget: Readonly<{
      rollbackDeploymentHost: unknown;
      rollbackDeploymentId: unknown;
      stagedDeploymentHost: unknown;
      stagedDeploymentId: unknown;
    }>;
    nowEpochMs?: number;
    trustContext: RuntimeTrustContext;
  }) => RuntimeProductionCutoverVerification;

const verifyRuntimeLaunchActivationReceipt =
  verifyLaunchActivationReceipt as unknown as (input: {
    expected: unknown;
    nowEpochMs?: number;
    productionCutoverVerification: RuntimeProductionCutoverVerification;
    receipt: unknown;
    trustContext: RuntimeTrustContext;
  }) => Readonly<{
    activation?: Readonly<{
      active: boolean;
      binding: Readonly<Record<string, string>>;
    }>;
    status: string;
  }>;

let refreshPromise: Promise<void> | null = null;
let refreshTimer: NodeJS.Timeout | null = null;

function invariant(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value
      && typeof value === "object"
      && !Array.isArray(value)
      && Object.getPrototypeOf(value) === Object.prototype,
  );
}

function runtimeTrustContext(environment: NodeJS.ProcessEnv) {
  const encoded = environment.NOVALURE_LAUNCH_ACTIVATION_TRUST_BUNDLE_BASE64URL;
  invariant(
    typeof encoded === "string"
      && encoded.length > 0
      && encoded === encoded.trim(),
    "LAUNCH_FLAGS_TRUST_BUNDLE_MISSING",
  );
  const requiredRoles = [
    "launch-activation-attestor",
    ...Object.values(productionCutoverReceiptRoles),
  ];
  return verifyLaunchActivationTrustBundle({
    bundle: decodeLaunchActivationTrustBundle(encoded),
    pinnedRoot: launchActivationPinnedRoot,
    requiredRoles,
  }) as RuntimeTrustContext;
}

function exactRuntimeValue(environment: NodeJS.ProcessEnv, key: string) {
  const value = environment[key];
  return typeof value === "string" && value.length > 0 && value === value.trim()
    ? value
    : null;
}

function assertRealProductionRuntime(expected: Record<string, unknown>, environment: NodeJS.ProcessEnv) {
  invariant(environment.VERCEL === "1" && environment.VERCEL_ENV === "production", "LAUNCH_FLAGS_RUNTIME_NOT_PRODUCTION");
  invariant(expected.candidateCommit === exactRuntimeValue(environment, "VERCEL_GIT_COMMIT_SHA"), "LAUNCH_FLAGS_RUNTIME_CANDIDATE_MISMATCH");
  invariant(expected.productionDeploymentId === exactRuntimeValue(environment, "VERCEL_DEPLOYMENT_ID"), "LAUNCH_FLAGS_RUNTIME_DEPLOYMENT_MISMATCH");
  invariant(expected.productionDeploymentHost === exactRuntimeValue(environment, "VERCEL_URL"), "LAUNCH_FLAGS_RUNTIME_DEPLOYMENT_HOST_MISMATCH");
  invariant(expected.projectId === exactRuntimeValue(environment, "VERCEL_PROJECT_ID"), "LAUNCH_FLAGS_RUNTIME_PROJECT_MISMATCH");
  invariant(expected.productionHost === exactRuntimeValue(environment, "VERCEL_PROJECT_PRODUCTION_URL"), "LAUNCH_FLAGS_RUNTIME_PRODUCTION_HOST_MISMATCH");
}

export function verifyProductionLaunchActivationEnvelope({
  environment = process.env,
  flagObservation,
  nowEpochMs = Date.now(),
  value,
}: {
  environment?: NodeJS.ProcessEnv;
  flagObservation: ProductionLaunchActivationFlagRead;
  nowEpochMs?: number;
  value: unknown;
}) {
  const decoded = decodeLaunchActivationFlagsEnvelope(value);
  const envelope = decoded.envelope;
  invariant(isPlainObject(envelope.expected), "LAUNCH_FLAGS_EXPECTED_INVALID");
  invariant(
    isPlainObject(envelope.productionCutoverDocument)
      && isPlainObject(envelope.productionCutoverDocument.target)
      && isPlainObject(envelope.productionCutoverDocument.deployment)
      && isPlainObject(envelope.productionCutoverDocument.deployment.rollback),
    "LAUNCH_FLAGS_PRODUCTION_CUTOVER_INVALID",
  );
  const productionRollback = envelope.productionCutoverDocument.deployment.rollback;
  invariant(Number.isSafeInteger(nowEpochMs) && nowEpochMs > 0, "LAUNCH_FLAGS_CLOCK_INVALID");
  const activationNotBefore = Date.parse(String(envelope.expected.activationNotBefore ?? ""));
  const activationExpiresAt = Date.parse(String(envelope.expected.activationExpiresAt ?? ""));
  invariant(
    Number.isFinite(activationNotBefore)
      && Number.isFinite(activationExpiresAt)
      && nowEpochMs >= activationNotBefore
      && nowEpochMs < activationExpiresAt,
    "LAUNCH_FLAGS_LEASE_INACTIVE",
  );
  invariant(
    flagObservation.environment === productionLaunchActivationFlagsEnvironment
      && envelope.expected.flagsEnvironment === productionLaunchActivationFlagsEnvironment,
    "LAUNCH_FLAGS_CONTROL_PLANE_ENVIRONMENT_MISMATCH",
  );
  invariant(
    Number.isSafeInteger(envelope.expected.flagsRevisionFloor)
      && flagObservation.revision > Number(envelope.expected.flagsRevisionFloor),
    "LAUNCH_FLAGS_CONTROL_PLANE_REVISION_NOT_ADVANCED",
  );
  invariant(
    Number.isSafeInteger(envelope.expected.activationGeneration)
      && Number(envelope.expected.activationGeneration) >= launchActivationMinimumGeneration,
    "LAUNCH_FLAGS_ACTIVATION_GENERATION_REVOKED",
  );
  invariant(
    flagObservation.configUpdatedAtEpochMs
      >= activationNotBefore - launchActivationMaximumIssuanceLeadMs,
    "LAUNCH_FLAGS_CONTROL_PLANE_CONFIG_PREDATES_LEASE",
  );
  assertRealProductionRuntime(envelope.expected, environment);
  const trustContext = runtimeTrustContext(environment);
  const productionCutoverVerification = verifyRuntimeProductionCutoverReceiptBundle({
    document: envelope.productionCutoverDocument,
    expectedCandidateCommit: envelope.expected.candidateCommit,
    expectedTarget: {
      rollbackDeploymentHost: productionRollback.deploymentHost,
      rollbackDeploymentId: productionRollback.deploymentId,
      stagedDeploymentHost: envelope.expected.productionDeploymentHost,
      stagedDeploymentId: envelope.expected.productionDeploymentId,
    },
    nowEpochMs,
    trustContext,
  });
  const verified = verifyRuntimeLaunchActivationReceipt({
    expected: envelope.expected,
    nowEpochMs,
    productionCutoverVerification,
    receipt: envelope.receipt,
    trustContext,
  });
  invariant(verified.status === "VERIFIED" && verified.activation?.active, "LAUNCH_FLAGS_ACTIVATION_NOT_VERIFIED");
  return Object.freeze({
    binding: verified.activation.binding,
    envelopeSha256: decoded.envelopeSha256,
  });
}

function publishState(
  state: LaunchActivationChannelSnapshot["state"],
  {
    binding = null,
    envelopeSha256 = null,
    flagConfigUpdatedAtEpochMs = null,
    flagRevision = null,
    monotonicNow = performance.now(),
    now = Date.now(),
  }: {
    binding?: Readonly<Record<string, string>> | null;
    envelopeSha256?: string | null;
    flagConfigUpdatedAtEpochMs?: number | null;
    flagRevision?: number | null;
    monotonicNow?: number;
    now?: number;
  } = {},
) {
  publishLaunchActivationChannelSnapshot(Object.freeze({
    binding,
    checkedAtEpochMs: now,
    checkedAtMonotonicMs: monotonicNow,
    envelopeSha256,
    flagConfigUpdatedAtEpochMs,
    flagRevision,
    requestRefresh: () => { void refreshProductionLaunchActivation(); },
    schemaVersion: 1,
    state,
    validUntilMonotonicMs: monotonicNow + channelFreshnessMs,
  }));
}

export async function refreshProductionLaunchActivation({
  environment = process.env,
  readFlag = readProductionLaunchActivationFlag,
}: {
  environment?: NodeJS.ProcessEnv;
  readFlag?: (environment: NodeJS.ProcessEnv) => Promise<ProductionLaunchActivationFlagRead>;
} = {}) {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const observation = await readFlag(environment);
      invariant(isPlainObject(observation), "LAUNCH_FLAGS_OBSERVATION_INVALID");
      const observationKeys = Object.keys(observation).sort();
      invariant(
        canonicalJson(observationKeys) === canonicalJson([
          "configUpdatedAtEpochMs",
          "environment",
          "revision",
          "value",
        ]),
        "LAUNCH_FLAGS_OBSERVATION_KEYS_INVALID",
      );
      invariant(
        Number.isSafeInteger(observation.revision) && Number(observation.revision) > 0,
        "LAUNCH_FLAGS_OBSERVATION_REVISION_INVALID",
      );
      invariant(
        Number.isSafeInteger(observation.configUpdatedAtEpochMs)
          && Number(observation.configUpdatedAtEpochMs) > 0
          && Number(observation.configUpdatedAtEpochMs) <= Date.now() + 5 * 60_000,
        "LAUNCH_FLAGS_OBSERVATION_TIMESTAMP_INVALID",
      );
      invariant(
        typeof observation.environment === "string"
          && observation.environment.length > 0
          && observation.environment.length <= 160
          && /^[A-Za-z0-9_-]+$/u.test(observation.environment),
        "LAUNCH_FLAGS_OBSERVATION_ENVIRONMENT_INVALID",
      );
      const value = observation.value;
      if (value === "OFF") {
        publishState("OFF", {
          flagConfigUpdatedAtEpochMs: Number(observation.configUpdatedAtEpochMs),
          flagRevision: Number(observation.revision),
        });
        return;
      }
      const verified = verifyProductionLaunchActivationEnvelope({
        environment,
        flagObservation: observation as ProductionLaunchActivationFlagRead,
        value,
      });
      publishState("ACTIVE", {
        ...verified,
        flagConfigUpdatedAtEpochMs: Number(observation.configUpdatedAtEpochMs),
        flagRevision: Number(observation.revision),
      });
    } catch (error) {
      publishState("INVALID");
      const candidateCode = error instanceof Error ? error.message : "";
      console.error(JSON.stringify({
        code: publicErrorCodePattern.test(candidateCode)
          ? candidateCode
          : "LAUNCH_FLAGS_REFRESH_FAILED",
        event: "novalure.launch_activation.invalid",
        level: "error",
      }));
    }
  })().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

export async function initializeProductionLaunchActivation() {
  publishState("OFF");
  await refreshProductionLaunchActivation();
  if (!refreshTimer) {
    refreshTimer = setInterval(() => {
      void refreshProductionLaunchActivation();
    }, channelRefreshIntervalMs);
    refreshTimer.unref();
  }
}
