export const maxDealValueCents = 500_000_000 * 100;

export type DealInputValidationCode =
  | "close_date_invalid"
  | "close_date_past"
  | "close_date_required"
  | "value_invalid"
  | "value_required"
  | "value_too_high";

export function parseDealValueCents(value: unknown) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw || raw.includes("-")) return null;

  const isMillion = /mio\.?/.test(raw);
  const numeric = raw
    .replace(/mio\.?/g, "")
    .replace(/eur/g, "")
    .replace(/€/g, "")
    .replace(/\s/g, "");
  if (!/^\d+(?:[.,]\d+)*$/.test(numeric)) return null;

  const separators = [...numeric.matchAll(/[.,]/g)];
  let normalized = numeric;
  if (separators.length > 0) {
    const lastSeparatorIndex = separators.at(-1)?.index ?? -1;
    const fractionLength = numeric.length - lastSeparatorIndex - 1;
    const hasDecimalFraction = fractionLength === 1 || fractionLength === 2;
    normalized = hasDecimalFraction
      ? `${numeric.slice(0, lastSeparatorIndex).replace(/[.,]/g, "")}.${numeric.slice(lastSeparatorIndex + 1)}`
      : numeric.replace(/[.,]/g, "");
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round((isMillion ? parsed * 1_000_000 : parsed) * 100);
}

export function validateDealValue(
  value: unknown,
  options: { required: boolean },
): DealInputValidationCode | null {
  const raw = String(value ?? "").trim();
  if (!raw) return options.required ? "value_required" : null;

  const cents = parseDealValueCents(raw);
  if (!cents) return "value_invalid";
  return cents > maxDealValueCents ? "value_too_high" : null;
}

export function validateDealCloseDate(
  value: unknown,
  options: { allowHistorical?: boolean; required: boolean; todayDateKey: string },
): DealInputValidationCode | null {
  const dateKey = String(value ?? "").trim();
  if (!dateKey) return options.required ? "close_date_required" : null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return "close_date_invalid";

  const parsed = new Date(`${dateKey}T12:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dateKey) {
    return "close_date_invalid";
  }
  if (!options.allowHistorical && dateKey < options.todayDateKey) return "close_date_past";
  return null;
}
