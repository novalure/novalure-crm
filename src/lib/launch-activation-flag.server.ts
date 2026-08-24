import {
  createClient,
  evaluate,
  Reason,
  type Datafile,
  type EvaluationResult,
} from "@vercel/flags-core";
import { launchActivationProductionFlagsEnvironment } from "./launch-activation-contract.shared.mjs";

export const productionLaunchActivationFlagKey =
  "novalure-production-launch-activation" as const;
export const productionLaunchActivationFlagDefault = "OFF" as const;
export const productionLaunchActivationVercelProjectId =
  "prj_R32Okl6AHijTohvuKmryuTLjWMsk" as const;
export const productionLaunchActivationFlagsEnvironment =
  launchActivationProductionFlagsEnvironment;

export type ProductionLaunchActivationFlagRead = Readonly<{
  configUpdatedAtEpochMs: number;
  environment: string;
  revision: number;
  value: string;
}>;

const controlPlaneRequestTimeoutMs = 2_000;

function invariant(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

function exactSdkKey(environment: NodeJS.ProcessEnv) {
  const value = environment.FLAGS;
  invariant(
    typeof value === "string"
      && value.length >= 16
      && value.length <= 8_192
      && value === value.trim(),
    "LAUNCH_FLAGS_SDK_KEY_MISSING",
  );
  return value;
}

function freshControlPlaneFetch(fetchImplementation: typeof globalThis.fetch) {
  return ((input: RequestInfo | URL, init: RequestInit = {}) => {
    const deadlineSignal = AbortSignal.timeout(controlPlaneRequestTimeoutMs);
    const signal = init.signal
      ? AbortSignal.any([init.signal, deadlineSignal])
      : deadlineSignal;
    return fetchImplementation(input, { ...init, cache: "no-store", signal });
  }) satisfies typeof globalThis.fetch;
}

function configTimestamp(value: number | string | undefined) {
  const parsed = typeof value === "number" ? value : Number(value);
  invariant(
    Number.isSafeInteger(parsed) && parsed > 0,
    "LAUNCH_FLAGS_CONFIG_TIMESTAMP_INVALID",
  );
  return parsed;
}

function assertOneShotRemoteMetrics(metrics: Datafile["metrics"] | undefined) {
  invariant(metrics, "LAUNCH_FLAGS_REMOTE_FRESHNESS_METRICS_MISSING");
  invariant(
    metrics.source === "remote"
      && metrics.cacheStatus === "MISS"
      && metrics.mode === "offline"
      && metrics.connectionState === "disconnected",
    "LAUNCH_FLAGS_REMOTE_FRESHNESS_UNPROVEN",
  );
}

/**
 * Fetch the Production datafile once through a brand-new request-free Core
 * client, evaluate that immutable response, then discard the client. No stream,
 * poller, SDK cache or bundled definition is permitted to renew the runtime
 * channel's freshness lease.
 */
export async function readProductionLaunchActivationFlag(
  environment: NodeJS.ProcessEnv = process.env,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): Promise<ProductionLaunchActivationFlagRead> {
  const client = createClient(exactSdkKey(environment), {
    buildStep: false,
    clientName: "novalure-production-launch-activation",
    disableMetrics: true,
    fetch: freshControlPlaneFetch(fetchImplementation),
    polling: false,
    stream: false,
  });
  try {
    // Deliberately do not call initialize(): a fresh getDatafile() must prove a
    // one-shot remote MISS. Embedded/bundled or cached data fails validation.
    const datafile = await client.getDatafile();
    const definition = datafile.definitions[productionLaunchActivationFlagKey];
    invariant(definition, "LAUNCH_FLAGS_DEFINITION_MISSING");
    const result = evaluate<string>({
      defaultValue: productionLaunchActivationFlagDefault,
      definition,
      entities: {},
      environment: datafile.environment,
      segments: datafile.segments,
    });
    return validateProductionLaunchActivationFlagRead({ datafile, result });
  } finally {
    await Promise.resolve(client.shutdown()).catch(() => undefined);
  }
}

export function validateProductionLaunchActivationFlagRead({
  datafile,
  result,
}: {
  datafile: Datafile;
  result: EvaluationResult<string>;
}): ProductionLaunchActivationFlagRead {
  assertOneShotRemoteMetrics(datafile.metrics);
  invariant(result.reason !== Reason.ERROR, "LAUNCH_FLAGS_EVALUATION_ERROR");
  invariant(
    typeof result.value === "string"
      && result.value.length > 0
      && result.value === result.value.trim(),
    "LAUNCH_FLAGS_VALUE_INVALID",
  );
  invariant(
    datafile.projectId === productionLaunchActivationVercelProjectId,
    "LAUNCH_FLAGS_PROJECT_MISMATCH",
  );
  invariant(
    datafile.environment === productionLaunchActivationFlagsEnvironment,
    "LAUNCH_FLAGS_ENVIRONMENT_MISMATCH",
  );
  invariant(
    Number.isSafeInteger(datafile.revision) && Number(datafile.revision) > 0,
    "LAUNCH_FLAGS_REVISION_INVALID",
  );
  return Object.freeze({
    configUpdatedAtEpochMs: configTimestamp(datafile.configUpdatedAt),
    environment: datafile.environment,
    revision: Number(datafile.revision),
    value: result.value,
  });
}
