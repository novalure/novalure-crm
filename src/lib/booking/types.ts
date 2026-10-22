import type { TenantScope } from "@/lib/db/tenant-client";
import type { BookingTravelSettings } from "./setup-types";
export type BookingKind = "phone" | "teams" | "meet" | "office" | "onsite";
export type BookingProviderName = "microsoft" | "google";
export type BusyInterval = { startsAt: string; endsAt: string; eventId?: string; calendarId?: string; location?: string | null };
export type ProviderEvent = { eventId: string; etag: string | null; startsAt: string; endsAt: string; onlineMeetingUrl: string | null; videoStatus: "ready" | "pending" | "unavailable" | "none"; cancelled: boolean };
export type ProviderWrite = { operationId: string; bookingId: string; title: string; startsAt: string; endsAt: string; timeZone: string; kind: BookingKind; location: string };
export interface BookingProvider {
  listBusy(input: { startsAt: string; endsAt: string; excludeEventId?: string; includeLocations?: boolean }): Promise<BusyInterval[]>;
  create(input: ProviderWrite): Promise<ProviderEvent>;
  lookup(input: { operationId: string; bookingId: string; eventId?: string }): Promise<ProviderEvent | null>;
  update(input: ProviderWrite & { eventId: string; etag: string | null }): Promise<ProviderEvent>;
  delete(input: { bookingId: string; operationId: string; eventId: string; etag: string | null }): Promise<void>;
}
export type BookingProviderFactory = (scope: TenantScope, provider: BookingProviderName) => Promise<BookingProvider>;
export type BookingRules = {
  durationMinutes: number; preparationMinutes: number; followupMinutes: number; timeZone: string;
  minNoticeMinutes: number; maxAdvanceDays: number; gridMinutes: number; maxPerDay: number | null;
  cancelNoticeMinutes: number; rescheduleNoticeMinutes: number; location: string; locationConfirmed?: boolean; propertyId?: string | null;
  workingHours: Array<{ day: number; start: string; end: string }>;
  breaks: Array<{ day: number; start: string; end: string }>;
  absences: BusyInterval[];
  travel: { policy: "deferred"; required: boolean } | (BookingTravelSettings & { policy: "google_maps"; required: boolean });
};
export type BookingRecord = {
  id: string; workspaceId: string; organizerId: string; provider: BookingProviderName; kind: BookingKind;
  title: string; startsAt: string; endsAt: string; blockedStartsAt: string; blockedEndsAt: string;
  state: "held" | "expired" | "processing" | "confirmed" | "uncertain" | "cancelled" | "conflict";
  expiresAt: string; rules: BookingRules; calendarId: string; connectionId: string; connectionRevision: number;
  providerEventId: string | null; providerEtag: string | null; videoUrl: string | null; videoStatus: string;
  operationId: string | null; operationKind: "create" | "reschedule" | "cancel" | null;
  operationTarget: { startsAt: string; endsAt: string; blockedStartsAt: string; blockedEndsAt: string; rules?: BookingRules } | null;
  notificationStatus: "not_requested" | "pending" | "sent" | "failed";
  revision: number; requestHash: string;
  recipientEmail?: string | null; recipientName?: string; communicationLanguage?: "de" | "en";
  messageVersion?: number; messageSnapshot?: Record<string, unknown>;
};
export class BookingError extends Error {
  constructor(public code: string, public status = 400) { super(code); this.name = "BookingError"; }
}
