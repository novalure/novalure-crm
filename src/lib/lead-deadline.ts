export function parseLeadDate(value: string | null | undefined) {
  if (!value?.trim()) return null;

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatLeadDateTime(
  value: string | null | undefined,
  locale: string,
  fallback = "-",
) {
  const parsed = parseLeadDate(value);
  if (!parsed) return fallback;

  return new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

export function minutesUntilLeadDeadline(
  value: string | null | undefined,
  nowMs = Date.now(),
) {
  const parsed = parseLeadDate(value);
  return parsed ? Math.round((parsed.getTime() - nowMs) / 60_000) : Number.POSITIVE_INFINITY;
}

export function compareLeadDeadlines(
  left: string | null | undefined,
  right: string | null | undefined,
) {
  const leftTime = parseLeadDate(left)?.getTime();
  const rightTime = parseLeadDate(right)?.getTime();

  if (leftTime === undefined) return rightTime === undefined ? 0 : 1;
  if (rightTime === undefined) return -1;
  return leftTime - rightTime;
}
