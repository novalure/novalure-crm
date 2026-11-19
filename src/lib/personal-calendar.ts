export type PersonalCalendarState = "processing" | "uncertain" | "synced" | "conflict" | "cancelled" | "failed";
export type PersonalCalendarDraft = {
  title: string; startsAt: string; endsAt: string; timeZone: string; location: string;
  projectId: string | null; attendees: Array<{ email: string; name: string }>;
};
export type PersonalCalendarRemoteSnapshot = {
  verifiedAt: string; eventId: string; etag: string | null; cancelled: boolean;
  title: string; startsAt: string; endsAt: string; timeZone: string; location: string;
  attendees: Array<{ email: string; name: string }>;
};
export type PersonalCalendarEvent = {
  id: string; origin: "personal_standalone"; provider: "microsoft" | "google";
  event: PersonalCalendarDraft; version: number; state: PersonalCalendarState;
  providerEventId: string | null; providerEtag: string | null;
  remoteSnapshot: PersonalCalendarRemoteSnapshot | null; errorCode: string | null;
  canEdit: boolean; canCancel: boolean; canImport: boolean;
};
