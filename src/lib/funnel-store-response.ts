import "server-only";

import type { StoredFunnel } from "@/lib/funnel-store";

/**
 * Explicit response boundary for authenticated blueprint APIs.
 * StoredFunnel.tracking contains publication credentials for server-side access
 * checks and must never cross an HTTP/serialization boundary.
 */
export function toFunnelBlueprintResponse(stored: StoredFunnel) {
  return {
    blueprint: stored.blueprint,
    blueprintOrigin: stored.blueprintOrigin,
    blueprintRevision: stored.blueprintRevision,
    source: stored.source,
    updatedAt: stored.updatedAt,
    versions: stored.versions,
  };
}
