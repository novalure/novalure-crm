import type { BookingKind, BookingProviderName } from "./types";

export const bookingChannels = ["link", "inline", "popup", "form", "chat", "voice"] as const;
export type BookingChannel = typeof bookingChannels[number];
export type BookingPublicationAssignment = { id: string; kind: BookingKind; organizerId: string; provider: BookingProviderName; publicLocation?: string };
export type BookingPublicationConfig = {
  publicId: string; enabled: boolean; title: string; description: string;
  appearance: "light" | "dark"; language: "auto" | "de" | "en";
  allowedOrigins: string[]; channels: Record<BookingChannel, boolean>;
  assignments: BookingPublicationAssignment[];
  legacyMeetingPageIds?: string[];
};
export type BookingPublicationReadiness = {
  canPublish: boolean;
  assignments: Array<{ id: string; calendar: boolean; maps: boolean; mail: boolean; ready: boolean; errors: string[] }>;
};
export type PublicBookingPublication = {
  publicId: string; title: string; description: string; appearance: "light" | "dark"; language: "auto" | "de" | "en";
  allowedOrigins: string[]; channels: Record<BookingChannel, boolean>;
  types: Array<{ id: string; kind: BookingKind; organizerName: string; durationMinutes: number; timeZone: string; locationRequired: boolean; location: string }>;
};
export type PublicBookingRecord = {
  id: string; state: string; kind: BookingKind; startsAt: string; endsAt: string; timeZone: string;
  videoUrl: string | null; videoStatus: string; notificationStatus: string;
  location: string;
};
