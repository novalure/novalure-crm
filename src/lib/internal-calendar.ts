import type { CalendarEvent } from "@/lib/crm-types";

export function isUpcomingCalendarEvent(event: CalendarEvent, from: Date) {
  return event.status !== "abgesagt" && !event.archived
    && new Date(event.startsAt).getTime() >= from.getTime();
}

export function calendarLocalDateTime(instant: string) {
  const date = new Date(instant);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, -1);
}

/** A title edit must preserve seconds and the original offset in a repeated DST hour. */
export function calendarDraftInstant(value: string, original?: string) {
  return original && value === calendarLocalDateTime(original) ? original : new Date(value).toISOString();
}

export type InternalCalendarDraft = {
  contactId: string; endsAt: string; leadId: string; location: CalendarEvent["location"];
  meetingProvider: NonNullable<CalendarEvent["meetingProvider"]>; notes: string; outcomeGoal: string;
  ownerUserId: string; projectId: string; startsAt: string; status: CalendarEvent["status"]; title: string;
};

/** The editor has no preparation control: editing notes must preserve that independent field. */
export function internalCalendarWriteBody(draft: InternalCalendarDraft, existing?: CalendarEvent | null) {
  return {
    ...(existing ? { expectedRevision: existing.revision } : {}),
    event: {
      ...(existing ? { id: existing.id } : {}),
      contactId: draft.contactId || undefined,
      endsAt: calendarDraftInstant(draft.endsAt, existing?.endsAt),
      leadId: draft.leadId || undefined,
      location: draft.location,
      meetingProvider: draft.meetingProvider,
      notes: draft.notes.trim(),
      outcomeGoal: draft.outcomeGoal.trim(),
      ownerUserId: draft.ownerUserId || undefined,
      ...(!existing ? { preparation: draft.notes.trim() ? [draft.notes.trim()] : [] } : {}),
      projectId: draft.projectId || undefined,
      startsAt: calendarDraftInstant(draft.startsAt, existing?.startsAt),
      status: draft.status,
      title: draft.title.trim(),
    },
  };
}
