import { getCalendarAccessToken } from "@/lib/integrations/calendar-connections";

export type MicrosoftCalendarResult = {
  provider: "microsoft-365" | "mock";
  status: "synced" | "failed" | "pending";
  eventId?: string | null;
  onlineMeetingUrl?: string | null;
  webLink?: string | null;
  error?: string | null;
};

export type MicrosoftCalendarMutationResult = {
  provider: "microsoft-365" | "mock";
  status: "synced" | "failed" | "pending";
  eventId?: string | null;
  webLink?: string | null;
  error?: string | null;
};

export type MicrosoftCalendarProviderStatus = {
  configured: boolean;
  provider: "microsoft-365" | "mock";
  external: boolean;
  accountLabel: string | null;
  mode: "access-token" | "client-credentials" | "not-configured";
  reason: string | null;
  scopes: string[];
};

type GraphToken = {
  calendarViewEndpoint: string;
  eventEndpoint: string;
  token: string;
};

function envValue(name: string) {
  return process.env[name]?.trim();
}

function normalizeGraphDateTime(value: string) {
  return value.trim().replace(/Z$/, "");
}

function graphErrorMessage(responseStatus: number, rawBody: string) {
  if (!rawBody) return `Microsoft Graph returned ${responseStatus}`;

  try {
    const data = JSON.parse(rawBody) as {
      error?: { code?: string; message?: string; innerError?: unknown };
    };
    const code = data.error?.code ? `${data.error.code}: ` : "";
    const message = data.error?.message;

    if (message) return `${code}${message}`;
  } catch {
    // Fall through to the raw response body below.
  }

  return rawBody.slice(0, 700);
}

export function getMicrosoftCalendarProviderStatus(): MicrosoftCalendarProviderStatus {
  const token = envValue("MICROSOFT_GRAPH_ACCESS_TOKEN");
  const tenantId = envValue("MICROSOFT_TENANT_ID");
  const clientId = envValue("MICROSOFT_CLIENT_ID");
  const clientSecret = envValue("MICROSOFT_CLIENT_SECRET");
  const calendarUserId = envValue("MICROSOFT_CALENDAR_USER_ID") || envValue("MICROSOFT_GRAPH_USER_ID");
  const hasClientCredentials = Boolean(tenantId && clientId && clientSecret && calendarUserId);

  if (token) {
    return {
      configured: true,
      provider: "microsoft-365",
      external: true,
      accountLabel: "me",
      mode: "access-token",
      reason: null,
      scopes: ["Calendars.ReadWrite"],
    };
  }

  if (hasClientCredentials) {
    return {
      configured: true,
      provider: "microsoft-365",
      external: true,
      accountLabel: calendarUserId ?? null,
      mode: "client-credentials",
      reason: null,
      scopes: ["https://graph.microsoft.com/.default"],
    };
  }

  return {
    configured: false,
    provider: "mock",
    external: false,
    accountLabel: null,
    mode: "not-configured",
    reason:
      "Configure MICROSOFT_GRAPH_ACCESS_TOKEN or MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET and MICROSOFT_CALENDAR_USER_ID.",
    scopes: [],
  };
}

async function getGraphToken(workspaceId?: string): Promise<GraphToken | null> {
  if (workspaceId) {
    const token = await getCalendarAccessToken({ provider: "microsoft", workspaceId }).catch(() => null);

    if (token) {
      return {
        calendarViewEndpoint: "https://graph.microsoft.com/v1.0/me/calendarView",
        eventEndpoint: "https://graph.microsoft.com/v1.0/me/calendar/events",
        token,
      };
    }
  }

  const directToken = envValue("MICROSOFT_GRAPH_ACCESS_TOKEN");

  if (directToken) {
    return {
      calendarViewEndpoint: "https://graph.microsoft.com/v1.0/me/calendarView",
      eventEndpoint: "https://graph.microsoft.com/v1.0/me/calendar/events",
      token: directToken,
    };
  }

  const tenantId = envValue("MICROSOFT_TENANT_ID");
  const clientId = envValue("MICROSOFT_CLIENT_ID");
  const clientSecret = envValue("MICROSOFT_CLIENT_SECRET");
  const calendarUserId = envValue("MICROSOFT_CALENDAR_USER_ID") || envValue("MICROSOFT_GRAPH_USER_ID");

  if (!tenantId || !clientId || !clientSecret || !calendarUserId) {
    return null;
  }

  const response = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
      scope: "https://graph.microsoft.com/.default",
    }),
  });
  const data = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    error_description?: string;
  };

  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || `Microsoft token request returned ${response.status}`);
  }

  return {
    calendarViewEndpoint: `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(calendarUserId)}/calendarView`,
    eventEndpoint: `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(calendarUserId)}/calendar/events`,
    token: data.access_token,
  };
}

export async function syncMicrosoftCalendarEvent(input: {
  subject: string;
  startsAt: string;
  endsAt: string;
  body?: string;
  createOnlineMeeting?: boolean;
  location?: string;
  attendees?: string[];
  workspaceId?: string;
}): Promise<MicrosoftCalendarResult> {
  const providerStatus = getMicrosoftCalendarProviderStatus();

  if (!providerStatus.configured && !input.workspaceId) {
    return {
      provider: "mock",
      status: "pending",
      error: providerStatus.reason,
    };
  }

  try {
    const graph = await getGraphToken(input.workspaceId);

    if (!graph) {
      return {
        provider: "mock",
        status: "pending",
        error: providerStatus.reason,
      };
    }

    const timeZone = envValue("MICROSOFT_CALENDAR_TIME_ZONE") || "W. Europe Standard Time";
    const response = await fetch(graph.eventEndpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${graph.token}`,
        "Content-Type": "application/json",
        Prefer: `outlook.timezone="${timeZone}"`,
      },
      body: JSON.stringify({
        subject: input.subject,
        body: {
          contentType: "HTML",
          content: input.body ?? "",
        },
        start: {
          dateTime: normalizeGraphDateTime(input.startsAt),
          timeZone,
        },
        end: {
          dateTime: normalizeGraphDateTime(input.endsAt),
          timeZone,
        },
        location: input.location ? { displayName: input.location } : undefined,
        attendees: input.attendees?.length
          ? input.attendees.map((email) => ({
              emailAddress: { address: email.trim() },
              type: "required",
            }))
          : undefined,
        isOnlineMeeting: input.createOnlineMeeting || undefined,
        onlineMeetingProvider: input.createOnlineMeeting ? "teamsForBusiness" : undefined,
      }),
    });

    const rawBody = await response.text();
    const data = ((): {
      id?: string;
      onlineMeeting?: { joinUrl?: string };
      webLink?: string;
      error?: { message?: string };
    } => {
      if (!rawBody) return {};

      try {
        return JSON.parse(rawBody) as {
          id?: string;
          onlineMeeting?: { joinUrl?: string };
          webLink?: string;
          error?: { message?: string };
        };
      } catch {
        return {};
      }
    })();

    if (!response.ok) {
      return {
        provider: "microsoft-365",
        status: "failed",
        eventId: data.id ?? null,
        error: graphErrorMessage(response.status, rawBody),
      };
    }

    return {
      provider: "microsoft-365",
      status: "synced",
      eventId: data.id ?? null,
      onlineMeetingUrl: data.onlineMeeting?.joinUrl ?? null,
      webLink: data.webLink ?? null,
    };
  } catch (error) {
    return {
      provider: "microsoft-365",
      status: "failed",
      error: error instanceof Error ? error.message : "Microsoft Graph request failed",
    };
  }
}

export async function listMicrosoftBusyTimes(input: {
  timeMax: string;
  timeMin: string;
  workspaceId?: string;
}): Promise<Array<{ end: string; start: string }>> {
  const graph = await getGraphToken(input.workspaceId);
  if (!graph) return [];

  const url = new URL(graph.calendarViewEndpoint);
  url.searchParams.set("startDateTime", input.timeMin);
  url.searchParams.set("endDateTime", input.timeMax);
  url.searchParams.set("$select", "start,end,showAs");
  url.searchParams.set("$top", "100");

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${graph.token}`,
      Prefer: 'outlook.timezone="UTC"',
    },
  });
  const data = (await response.json().catch(() => ({}))) as {
    value?: Array<{
      end?: { dateTime?: string; timeZone?: string };
      showAs?: string;
      start?: { dateTime?: string; timeZone?: string };
    }>;
  };

  if (!response.ok) return [];

  return (data.value ?? [])
    .filter((event) => event.showAs !== "free")
    .map((event) => ({
      end: event.end?.dateTime ? `${event.end.dateTime}Z` : "",
      start: event.start?.dateTime ? `${event.start.dateTime}Z` : "",
    }))
    .filter((event) => event.start && event.end);
}

export async function updateMicrosoftCalendarEvent(input: {
  body?: string;
  endsAt: string;
  eventId: string;
  location?: string;
  startsAt: string;
  subject: string;
  workspaceId?: string;
}): Promise<MicrosoftCalendarMutationResult> {
  const providerStatus = getMicrosoftCalendarProviderStatus();

  if (!providerStatus.configured && !input.workspaceId) {
    return {
      provider: "mock",
      status: "pending",
      error: providerStatus.reason,
    };
  }

  try {
    const graph = await getGraphToken(input.workspaceId);

    if (!graph) {
      return {
        provider: "mock",
        status: "pending",
        error: providerStatus.reason,
      };
    }

    const timeZone = envValue("MICROSOFT_CALENDAR_TIME_ZONE") || "W. Europe Standard Time";
    const eventUrl = graph.eventEndpoint.replace(/\/events$/, `/events/${encodeURIComponent(input.eventId)}`);
    const response = await fetch(eventUrl, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${graph.token}`,
        "Content-Type": "application/json",
        Prefer: `outlook.timezone="${timeZone}"`,
      },
      body: JSON.stringify({
        subject: input.subject,
        body: {
          contentType: "HTML",
          content: input.body ?? "",
        },
        start: {
          dateTime: normalizeGraphDateTime(input.startsAt),
          timeZone,
        },
        end: {
          dateTime: normalizeGraphDateTime(input.endsAt),
          timeZone,
        },
        location: input.location ? { displayName: input.location } : undefined,
      }),
    });
    const rawBody = await response.text();
    const data = rawBody
      ? (JSON.parse(rawBody) as {
          id?: string;
          webLink?: string;
        })
      : {};

    if (!response.ok) {
      return {
        provider: "microsoft-365",
        status: "failed",
        eventId: data.id ?? input.eventId,
        error: graphErrorMessage(response.status, rawBody),
      };
    }

    return {
      provider: "microsoft-365",
      status: "synced",
      eventId: data.id ?? input.eventId,
      webLink: data.webLink ?? null,
    };
  } catch (error) {
    return {
      provider: "microsoft-365",
      status: "failed",
      eventId: input.eventId,
      error: error instanceof Error ? error.message : "Microsoft Graph update failed",
    };
  }
}

export async function deleteMicrosoftCalendarEvent(input: {
  eventId: string;
  workspaceId?: string;
}): Promise<MicrosoftCalendarMutationResult> {
  const providerStatus = getMicrosoftCalendarProviderStatus();

  if (!providerStatus.configured && !input.workspaceId) {
    return {
      provider: "mock",
      status: "pending",
      error: providerStatus.reason,
    };
  }

  try {
    const graph = await getGraphToken(input.workspaceId);

    if (!graph) {
      return {
        provider: "mock",
        status: "pending",
        error: providerStatus.reason,
      };
    }

    const eventUrl = graph.eventEndpoint.replace(/\/events$/, `/events/${encodeURIComponent(input.eventId)}`);
    const response = await fetch(eventUrl, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${graph.token}` },
    });
    const rawBody = await response.text();

    if (!response.ok && response.status !== 404) {
      return {
        provider: "microsoft-365",
        status: "failed",
        eventId: input.eventId,
        error: graphErrorMessage(response.status, rawBody),
      };
    }

    return {
      provider: "microsoft-365",
      status: "synced",
      eventId: input.eventId,
    };
  } catch (error) {
    return {
      provider: "microsoft-365",
      status: "failed",
      eventId: input.eventId,
      error: error instanceof Error ? error.message : "Microsoft Graph delete failed",
    };
  }
}
