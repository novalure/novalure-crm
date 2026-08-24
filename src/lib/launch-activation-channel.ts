import {
  launchActivationChannelSymbol,
  publishLaunchActivationChannelSnapshot as publishSharedSnapshot,
  readLaunchActivationChannelSnapshot as readSharedSnapshot,
} from "./launch-activation-channel.shared.mjs";

export { launchActivationChannelSymbol };

export type LaunchActivationChannelSnapshot = Readonly<{
  binding: Readonly<Record<string, string>> | null;
  checkedAtEpochMs: number;
  checkedAtMonotonicMs: number;
  envelopeSha256: string | null;
  flagConfigUpdatedAtEpochMs: number | null;
  flagRevision: number | null;
  requestRefresh: () => void;
  schemaVersion: 1;
  state: "ACTIVE" | "INVALID" | "OFF";
  validUntilMonotonicMs: number;
}>;

export function readLaunchActivationChannelSnapshot() {
  return readSharedSnapshot() as LaunchActivationChannelSnapshot | null;
}

export function publishLaunchActivationChannelSnapshot(
  snapshot: LaunchActivationChannelSnapshot,
) {
  publishSharedSnapshot(snapshot);
}
