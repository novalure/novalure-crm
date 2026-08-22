import { createHash, randomUUID } from "node:crypto";

/**
 * Public booking writes must remain disabled until provider and local
 * mutations run through a durable, resumable saga/outbox with reconciliation.
 * Constants checked in routes, repositories and UI keep this boundary explicit
 * and fail-closed instead of depending on mutable environment configuration.
 */
export const bookingCreationLaunchEnabled = false;
export const bookingCreationLaunchOffCode = "BOOKING_CREATION_LAUNCH_OFF";
export const publicBookingCreationLaunchEnabled = bookingCreationLaunchEnabled;
export const publicBookingCreationLaunchOffCode = bookingCreationLaunchOffCode;
export const publicBookingLifecycleMutationsLaunchEnabled = false;
export const publicBookingLifecycleLaunchOffCode = "PUBLIC_BOOKING_LIFECYCLE_LAUNCH_OFF";

const correlationIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

type ZonedParts = {
  day: number;
  hour: number;
  minute: number;
  month: number;
  second: number;
  year: number;
};

function getZonedParts(value: Date, timeZone: string): ZonedParts | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      second: "2-digit",
      timeZone,
      year: "numeric",
    }).formatToParts(value);
    const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const result = {
      day: Number(lookup.day),
      hour: Number(lookup.hour),
      minute: Number(lookup.minute),
      month: Number(lookup.month),
      second: Number(lookup.second),
      year: Number(lookup.year),
    };

    return Object.values(result).every(Number.isFinite) ? result : null;
  } catch {
    return null;
  }
}

function sameZonedParts(left: ZonedParts | null, right: ZonedParts) {
  return Boolean(
    left &&
      left.day === right.day &&
      left.hour === right.hour &&
      left.minute === right.minute &&
      left.month === right.month &&
      left.second === right.second &&
      left.year === right.year,
  );
}

function getOffsetMilliseconds(value: Date, timeZone: string) {
  const parts = getZonedParts(value, timeZone);
  if (!parts) return null;

  return (
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) -
    value.getTime()
  );
}

export function normalizeBookingCorrelationId(value?: string | null) {
  const normalized = value?.trim() ?? "";
  return correlationIdPattern.test(normalized) ? normalized : null;
}

export function resolveBookingCorrelationId(value?: string | null) {
  return normalizeBookingCorrelationId(value) ?? randomUUID();
}

export function createProviderEventKey(correlationId: string) {
  return `novalure${createHash("sha256").update(correlationId).digest("hex").slice(0, 40)}`;
}

export function zonedDateTimeToUtc(input: {
  date: string;
  time: string;
  timeZone: string;
}): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(input.date) || !/^\d{2}:\d{2}$/u.test(input.time)) {
    return null;
  }

  const [year, month, day] = input.date.split("-").map(Number);
  const [hour, minute] = input.time.split(":").map(Number);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  const expected: ZonedParts = { day, hour, minute, month, second: 0, year };
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const offsets = new Set(
    [-36, -24, -12, 0, 12, 24, 36]
      .map((hours) => getOffsetMilliseconds(new Date(utcGuess.getTime() + hours * 60 * 60_000), input.timeZone))
      .filter((offset): offset is number => offset !== null),
  );
  const matches = [...offsets]
    .map((offset) => new Date(utcGuess.getTime() - offset))
    .filter((candidate) => sameZonedParts(getZonedParts(candidate, input.timeZone), expected))
    .sort((left, right) => left.getTime() - right.getTime());

  // A missing local wall-clock time during the spring DST transition is invalid.
  // An ambiguous autumn time resolves deterministically to the first occurrence.
  return matches[0] ?? null;
}
