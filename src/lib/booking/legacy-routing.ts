import "server-only";
import type { TenantTransactionOptions } from "@/lib/db/tenant-client";
import { bookingBootstrapRows, lookupActiveWorkspaceBookingPublication } from "./publication";

/**
 * A predecessor database has no publication registry and therefore no migrated
 * customer scopes. Once installed, published organizer scopes and explicit page
 * mappings remain on the common service, including after a later disable.
 * Unexpected database errors propagate; an activated scope never falls back.
 */
export async function getLegacyBookingReplacement(workspaceId: string, meetingPageId?: string, options: TenantTransactionOptions = {}) {
  const installed = (await bookingBootstrapRows<{ installed: boolean }>(
    "select to_regprocedure('public.booking_workspace_publication_lookup(uuid,uuid)') is not null as installed", [], options))[0]?.installed;
  if (!installed) return null;
  return lookupActiveWorkspaceBookingPublication(workspaceId, meetingPageId, options);
}

export function replacementBookingPath(publicId: string) { return `/appointments/${encodeURIComponent(publicId)}`; }
