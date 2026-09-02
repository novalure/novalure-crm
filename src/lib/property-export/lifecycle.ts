import type {
  PropertyExportJobStatus,
  PropertyPublicationStatus,
} from "@/lib/property-export/types";

export const PROPERTY_EXPORT_MAX_SCHEDULE_DAYS = 90;

export const propertyExportChannelActions = [
  "pause",
  "resume",
  "withdraw",
  "mark_update_required",
] as const;

export type PropertyExportChannelAction = typeof propertyExportChannelActions[number];

export type PropertyExportSchedule = Readonly<{
  availableAt: string;
  immediate: boolean;
  scheduledAt: string | null;
}>;

type ValidationResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ message: string; ok: false }>;

const rfc3339Pattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

const publicationStatuses = new Set<PropertyPublicationStatus>([
  "draft",
  "preflight_failed",
  "ready",
  "queued",
  "exporting",
  "published",
  "partially_published",
  "update_required",
  "failed",
  "paused",
  "withdrawn",
]);

function validCalendarParts(match: RegExpMatchArray) {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? 0);
  const offset = match[8];
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }
  if (offset && offset !== "Z") {
    const offsetHour = Number(offset.slice(1, 3));
    const offsetMinute = Number(offset.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return true;
}

export function parsePropertyExportSchedule(
  value: unknown,
  now = new Date(),
  options: Readonly<{ enforceWindow?: boolean }> = {},
): ValidationResult<PropertyExportSchedule> {
  if (value === undefined || value === null || value === "") {
    return {
      ok: true,
      value: {
        availableAt: now.toISOString(),
        immediate: true,
        scheduledAt: null,
      },
    };
  }
  if (typeof value !== "string" || value.length > 64 || value !== value.trim()) {
    return { message: "scheduledAt must be a bounded RFC 3339 timestamp.", ok: false };
  }
  const match = value.match(rfc3339Pattern);
  if (!match || !validCalendarParts(match)) {
    return { message: "scheduledAt must be a valid RFC 3339 timestamp with a timezone.", ok: false };
  }
  const scheduledTime = Date.parse(value);
  const nowTime = now.getTime();
  if (Number.isNaN(scheduledTime) || Number.isNaN(nowTime)) {
    return { message: "scheduledAt is invalid.", ok: false };
  }
  if (options.enforceWindow !== false) {
    if (scheduledTime <= nowTime) {
      return { message: "scheduledAt must be in the future.", ok: false };
    }
    const maximumTime = nowTime + PROPERTY_EXPORT_MAX_SCHEDULE_DAYS * 24 * 60 * 60 * 1_000;
    if (scheduledTime > maximumTime) {
      return {
        message: `scheduledAt must be within ${PROPERTY_EXPORT_MAX_SCHEDULE_DAYS} days.`,
        ok: false,
      };
    }
  }
  const scheduledAt = new Date(scheduledTime).toISOString();
  return {
    ok: true,
    value: { availableAt: scheduledAt, immediate: false, scheduledAt },
  };
}

export function parsePropertyExportChannelAction(
  value: unknown,
): PropertyExportChannelAction | null {
  return typeof value === "string" && propertyExportChannelActions.includes(
    value as PropertyExportChannelAction,
  )
    ? value as PropertyExportChannelAction
    : null;
}

export function isPropertyPublicationStatus(value: unknown): value is PropertyPublicationStatus {
  return typeof value === "string" && publicationStatuses.has(value as PropertyPublicationStatus);
}

export function resolvePropertyExportChannelTransition(input: {
  action: PropertyExportChannelAction;
  channelStatus: PropertyPublicationStatus;
  jobStatus: PropertyExportJobStatus;
}): ValidationResult<PropertyPublicationStatus> {
  const { action, channelStatus, jobStatus } = input;
  if (action === "pause") {
    return (["queued", "ready", "update_required", "failed"] as PropertyPublicationStatus[])
      .includes(channelStatus)
      ? { ok: true, value: "paused" }
      : { message: `A channel in ${channelStatus} cannot be paused.`, ok: false };
  }
  if (action === "resume") {
    if (channelStatus !== "paused") {
      return { message: `A channel in ${channelStatus} cannot be resumed.`, ok: false };
    }
    if (jobStatus === "queued" || jobStatus === "retry") {
      return { ok: true, value: "queued" };
    }
    if (jobStatus === "completed") return { ok: true, value: "ready" };
    if (jobStatus === "failed" || jobStatus === "dead_letter") {
      return { ok: true, value: "failed" };
    }
    return { message: `A paused ${jobStatus} job cannot be resumed.`, ok: false };
  }
  if (action === "withdraw") {
    return (["queued", "ready", "update_required", "failed", "paused"] as PropertyPublicationStatus[])
      .includes(channelStatus)
      ? { ok: true, value: "withdrawn" }
      : { message: `A channel in ${channelStatus} cannot be withdrawn.`, ok: false };
  }
  if (channelStatus === "ready" && jobStatus === "completed") {
    return { ok: true, value: "update_required" };
  }
  return {
    message: "Only a completed, ready QA export can be marked as update-required.",
    ok: false,
  };
}
