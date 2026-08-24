export const launchActivationChannelSymbol = Symbol.for(
  "novalure.launch-activation-channel.v1",
);

const digestPattern = /^[a-f0-9]{64}$/u;
const maximumSnapshotFreshnessMs = 30_000;
const snapshotKeys = Object.freeze([
  "binding",
  "checkedAtEpochMs",
  "checkedAtMonotonicMs",
  "envelopeSha256",
  "flagConfigUpdatedAtEpochMs",
  "flagRevision",
  "requestRefresh",
  "schemaVersion",
  "state",
  "validUntilMonotonicMs",
].sort());

function isPlainObject(value) {
  return Boolean(
    value
      && typeof value === "object"
      && !Array.isArray(value)
      && Object.getPrototypeOf(value) === Object.prototype,
  );
}

function isOptionalPositiveInteger(value) {
  return value === null || (Number.isSafeInteger(value) && value > 0);
}

export function isValidLaunchActivationChannelSnapshot(snapshot) {
  if (!isPlainObject(snapshot)) return false;
  const keys = Object.keys(snapshot).sort();
  if (
    keys.length !== snapshotKeys.length
    || !keys.every((key, index) => key === snapshotKeys[index])
  ) return false;
  if (
    snapshot.schemaVersion !== 1
    || !["ACTIVE", "INVALID", "OFF"].includes(snapshot.state)
    || typeof snapshot.requestRefresh !== "function"
    || !Number.isSafeInteger(snapshot.checkedAtEpochMs)
    || snapshot.checkedAtEpochMs <= 0
    || !Number.isFinite(snapshot.checkedAtMonotonicMs)
    || snapshot.checkedAtMonotonicMs < 0
    || !Number.isFinite(snapshot.validUntilMonotonicMs)
    || snapshot.validUntilMonotonicMs <= snapshot.checkedAtMonotonicMs
    || snapshot.validUntilMonotonicMs
      > snapshot.checkedAtMonotonicMs + maximumSnapshotFreshnessMs
    || !isOptionalPositiveInteger(snapshot.flagConfigUpdatedAtEpochMs)
    || !isOptionalPositiveInteger(snapshot.flagRevision)
  ) return false;

  if (snapshot.state === "ACTIVE") {
    return isPlainObject(snapshot.binding)
      && Object.values(snapshot.binding).every(
        (value) => typeof value === "string" && value.length > 0,
      )
      && typeof snapshot.envelopeSha256 === "string"
      && digestPattern.test(snapshot.envelopeSha256)
      && snapshot.flagConfigUpdatedAtEpochMs !== null
      && snapshot.flagRevision !== null;
  }
  return snapshot.binding === null && snapshot.envelopeSha256 === null;
}

export function readLaunchActivationChannelSnapshot() {
  const snapshot = globalThis[launchActivationChannelSymbol] ?? null;
  return isValidLaunchActivationChannelSnapshot(snapshot) ? snapshot : null;
}

export function publishLaunchActivationChannelSnapshot(snapshot) {
  if (!isValidLaunchActivationChannelSnapshot(snapshot)) {
    throw new Error("LAUNCH_ACTIVATION_CHANNEL_SNAPSHOT_INVALID");
  }
  globalThis[launchActivationChannelSymbol] = snapshot;
}
