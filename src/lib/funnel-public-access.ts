import "server-only";

import { timingSafeEqual } from "node:crypto";
import type { FunnelBlueprint } from "@/lib/funnel-schema";
import type { StoredFunnel } from "@/lib/funnel-store";

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function getStoredFunnelPublishToken(
  storedTracking: Record<string, unknown> | undefined,
) {
  return cleanString(storedTracking?.publishToken)
    || cleanString(storedTracking?.publicToken);
}

export function canUsePublicLiveFunnel(input: {
  blueprint: FunnelBlueprint;
  stored: StoredFunnel | null;
  token: string | null | undefined;
}) {
  if (!isStoredFunnelPubliclyLive(input)) return false;
  if (!input.stored) return false;

  const token = cleanString(input.token);
  const expectedToken = getStoredFunnelPublishToken(input.stored.tracking);
  if (!token || !expectedToken) return false;

  const actualBuffer = Buffer.from(token, "utf8");
  const expectedBuffer = Buffer.from(expectedToken, "utf8");
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function isStoredFunnelPubliclyLive(input: {
  blueprint: FunnelBlueprint;
  stored: StoredFunnel | null;
}) {
  return Boolean(
    input.stored &&
      input.stored.source === "database" &&
      input.stored.blueprintOrigin === "persisted" &&
      input.stored.status === "aktiv" &&
      input.blueprint.status === "aktiv",
  );
}
