import "server-only";
import { createHash } from "node:crypto";

/** Fingerprint of reviewed code constants only; no knowledge or visitor data. */
export function webchatBehaviorFingerprint(behavior: Readonly<{ version: number; instruction: string }>): string {
  return createHash("sha256").update(JSON.stringify(["shared-behavior-webchat-v1", behavior.version, behavior.instruction])).digest("hex");
}
