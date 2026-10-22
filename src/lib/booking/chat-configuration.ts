import "server-only";
import type { TenantTransactionOptions } from "@/lib/db/tenant-client";
import type { BookingChannelAuthority } from "./channel-bindings";
import { lookupBookingPublication, publicBookingPublication } from "./publication";
import { BookingError } from "./types";

/** Public display fields, after the caller's live chat grant was verified. */
export async function readTrustedChatBookingConfiguration(authority: BookingChannelAuthority, options: TenantTransactionOptions = {}) {
  const stored = await lookupBookingPublication(authority.publicId, options);
  if (stored.workspaceId !== authority.workspaceId) throw new BookingError("BOOKING_CHANNEL_FORBIDDEN", 403);
  const publication = await publicBookingPublication(stored, "chat", options);
  const types = publication.types.filter(type => authority.typeIds.includes(type.id));
  if (!types.length) throw new BookingError("PUBLICATION_NOT_FOUND", 404);
  return { title: publication.title, language: publication.language, types };
}
