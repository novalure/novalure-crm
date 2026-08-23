import {
  calendarProviderReadUnavailableCode,
  getCalendarAccessToken,
  getCalendarReadAccessToken,
} from "@/lib/integrations/calendar-connections";
import { evaluateLaunchScope } from "@/lib/launch-scope";
import { createProviderEventKey } from "@/lib/meetings/booking-lifecycle";

export type GoogleCalendarResult = {
  error?: string | null;
  eventId?: string | null;
  onlineMeetingUrl?: string | null;
  provider: "google-workspace" | "mock";
  status: "failed" | "pending" | "synced";
  webLink?: string | null;
};

export type GoogleCalendarMutationResult = {
  error?: string | null;
  eventId?: string | null;
  provider: "google-workspace" | "mock";
  status: "failed" | "pending" | "synced";
  webLink?: string | null;
};

export type BusyTimeRange = {
  end: string;
  start: string;
};

function googleErrorMessage(responseStatus: number, rawBody: string) {
  if (!rawBody) return `Google Calendar returned ${responseStatus}`;

  try {
    const data = JSON.parse(rawBody) as {
      error?: { message?: string; status?: string };
    };
    if (data.error?.message) return `${data.error.status ? `${data.error.status}: ` : ""}${data.error.message}`;
  } catch {
    // Fall through to raw response body.
  }

  return rawBody.slice(0, 700);
}

function getMeetUrl(data: {
  conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
  hangoutLink?: string;
}) {
  return (
    data.hangoutLink ||
    data.conferenceData?.entryPoints?.find((entryPoint) => entryPoint.entryPointType === "video")?.uri ||
    null
  );
}

export async function syncGoogleCalendarEvent(input: {
  attendees?: string[];
  body?: string;
  correlationId?: string;
  createOnlineMeeting?: boolean;
  endsAt: string;
  location?: string;
  startsAt: string;
  subject: string;
  timeZone?: string;
  workspaceId: string;
}): Promise<GoogleCalendarResult> {
  const launchScope = evaluateLaunchScope("calendarProviderMutation");
  if (!launchScope.allowed) {
    return {
      error: "calendar_provider_mutation_launch_off",
      provider: "mock",
      status: "failed",
    };
  }

  const accessToken = await getCalendarAccessToken({
    provider: "google",
    workspaceId: input.workspaceId,
  }).catch((error) => {
    throw error;
  });

  if (!accessToken) {
    return {
      error: "Google calendar is not connected",
      provider: "mock",
      status: "pending",
    };
  }

  try {
    const eventKey = input.correlationId ? createProviderEventKey(input.correlationId) : undefined;
    const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
    if (input.createOnlineMeeting) url.searchParams.set("conferenceDataVersion", "1");
    url.searchParams.set("sendUpdates", "all");

    const response = await fetch(url, {
      body: JSON.stringify({
        attendees: input.attendees?.map((email) => ({ email: email.trim() })),
        conferenceData: input.createOnlineMeeting
          ? {
              createRequest: {
                conferenceSolutionKey: { type: "hangoutsMeet" },
                requestId: eventKey ?? `novalure-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              },
            }
          : undefined,
        description: input.body ?? "",
        end: { dateTime: input.endsAt, timeZone: input.timeZone ?? "UTC" },
        extendedProperties: input.correlationId
          ? { private: { novalureCorrelationId: input.correlationId } }
          : undefined,
        id: eventKey,
        location: input.location,
        start: { dateTime: input.startsAt, timeZone: input.timeZone ?? "UTC" },
        summary: input.subject,
      }),
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    const rawBody = await response.text();
    const data = rawBody
      ? (JSON.parse(rawBody) as {
          conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
          hangoutLink?: string;
          htmlLink?: string;
          id?: string;
        })
      : {};

    if (response.status === 409 && eventKey) {
      const existingUrl = new URL(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventKey)}`,
      );
      const existingResponse = await fetch(existingUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const existingBody = await existingResponse.text();
      const existing = existingBody
        ? (JSON.parse(existingBody) as {
            conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
            hangoutLink?: string;
            htmlLink?: string;
            id?: string;
          })
        : {};
      if (existingResponse.ok) {
        return {
          eventId: existing.id ?? eventKey,
          onlineMeetingUrl: getMeetUrl(existing),
          provider: "google-workspace",
          status: "synced",
          webLink: existing.htmlLink ?? null,
        };
      }
    }

    if (!response.ok) {
      return {
        error: googleErrorMessage(response.status, rawBody),
        eventId: data.id ?? null,
        provider: "google-workspace",
        status: "failed",
      };
    }

    return {
      eventId: data.id ?? null,
      onlineMeetingUrl: getMeetUrl(data),
      provider: "google-workspace",
      status: "synced",
      webLink: data.htmlLink ?? null,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Google Calendar request failed",
      provider: "google-workspace",
      status: "failed",
    };
  }
}

export async function listGoogleBusyTimes(input: {
  timeMax: string;
  timeMin: string;
  timeZone?: string;
  workspaceId: string;
}): Promise<BusyTimeRange[]> {
  if (!evaluateLaunchScope("calendarProviderRead").allowed) {
    throw new Error(calendarProviderReadUnavailableCode);
  }
  const accessToken = await getCalendarReadAccessToken({
    provider: "google",
    workspaceId: input.workspaceId,
  });
  if (!accessToken) throw new Error(calendarProviderReadUnavailableCode);

  const response = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    body: JSON.stringify({
      items: [{ id: "primary" }],
      timeMax: input.timeMax,
      timeMin: input.timeMin,
      timeZone: input.timeZone || "Europe/Vienna",
    }),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  const data = (await response.json().catch(() => ({}))) as {
    calendars?: Record<string, { busy?: BusyTimeRange[] }>;
  };

  if (!response.ok) throw new Error(`Google Calendar busy-time request returned ${response.status}`);
  return Object.values(data.calendars ?? {}).flatMap((calendar) => calendar.busy ?? []);
}

export async function updateGoogleCalendarEvent(input: {
  body?: string;
  endsAt: string;
  eventId: string;
  location?: string;
  startsAt: string;
  subject: string;
  timeZone?: string;
  workspaceId: string;
}): Promise<GoogleCalendarMutationResult> {
  const launchScope = evaluateLaunchScope("calendarProviderMutation");
  if (!launchScope.allowed) {
    return {
      error: "calendar_provider_mutation_launch_off",
      eventId: input.eventId,
      provider: "mock",
      status: "failed",
    };
  }

  const accessToken = await getCalendarAccessToken({
    provider: "google",
    workspaceId: input.workspaceId,
  });

  if (!accessToken) {
    return {
      error: "Google calendar is not connected",
      provider: "mock",
      status: "pending",
    };
  }

  try {
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(input.eventId)}`,
    );
    url.searchParams.set("sendUpdates", "all");

    const response = await fetch(url, {
      body: JSON.stringify({
        description: input.body ?? "",
        end: { dateTime: input.endsAt, timeZone: input.timeZone ?? "UTC" },
        location: input.location,
        start: { dateTime: input.startsAt, timeZone: input.timeZone ?? "UTC" },
        summary: input.subject,
      }),
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      method: "PATCH",
    });
    const rawBody = await response.text();
    const data = rawBody
      ? (JSON.parse(rawBody) as {
          htmlLink?: string;
          id?: string;
        })
      : {};

    if (!response.ok) {
      return {
        error: googleErrorMessage(response.status, rawBody),
        eventId: data.id ?? input.eventId,
        provider: "google-workspace",
        status: "failed",
      };
    }

    return {
      eventId: data.id ?? input.eventId,
      provider: "google-workspace",
      status: "synced",
      webLink: data.htmlLink ?? null,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Google Calendar update failed",
      eventId: input.eventId,
      provider: "google-workspace",
      status: "failed",
    };
  }
}

export async function deleteGoogleCalendarEvent(input: {
  eventId: string;
  workspaceId: string;
}): Promise<GoogleCalendarMutationResult> {
  const launchScope = evaluateLaunchScope("calendarProviderMutation");
  if (!launchScope.allowed) {
    return {
      error: "calendar_provider_mutation_launch_off",
      eventId: input.eventId,
      provider: "mock",
      status: "failed",
    };
  }

  const accessToken = await getCalendarAccessToken({
    provider: "google",
    workspaceId: input.workspaceId,
  });

  if (!accessToken) {
    return {
      error: "Google calendar is not connected",
      provider: "mock",
      status: "pending",
    };
  }

  try {
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(input.eventId)}`,
    );
    url.searchParams.set("sendUpdates", "all");

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      method: "DELETE",
    });
    const rawBody = await response.text();

    if (!response.ok && response.status !== 404 && response.status !== 410) {
      return {
        error: googleErrorMessage(response.status, rawBody),
        eventId: input.eventId,
        provider: "google-workspace",
        status: "failed",
      };
    }

    return {
      eventId: input.eventId,
      provider: "google-workspace",
      status: "synced",
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Google Calendar delete failed",
      eventId: input.eventId,
      provider: "google-workspace",
      status: "failed",
    };
  }
}
