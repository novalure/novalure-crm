type MoneyParseOptions = { allowNegative?: boolean };

export function isEmptyMoneyInput(value: unknown) {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

/**
 * Parse an explicitly EUR-denominated amount, never infer cents from its size.
 * Numbers and ungrouped dot decimals use decimal notation. Strings additionally
 * accept German grouping/decimal notation and an optional EUR/€ affix. A string
 * such as "1.000" means 1,000 EUR; use a number for an ambiguous dot decimal.
 * Round decimal digits half away from zero, without binary floating-point maths.
 * Missing, malformed, disallowed negative and unsafe-cent amounts return null.
 */
export function parsePropertyEuroCents(value: unknown, options: MoneyParseOptions = {}): number | null {
  let normalized: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER / 100) return null;
    normalized = expandNumberDecimal(value);
  } else if (typeof value === "string") {
    let raw = value.trim();
    if (!raw || raw.length > 128) return null;
    raw = raw.replace(/^(?:EUR|€)\s*/i, "").replace(/\s*(?:EUR|€)$/i, "").trim();
    const sign = raw.startsWith("-") ? "-" : "";
    raw = raw.replace(/^[+-]/, "");

    // Grouping spaces must separate complete thousands, not arbitrary digits.
    if (/[\s\u00a0\u202f]/.test(raw)) {
      if (!/^\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[,.]\d+)?$/.test(raw)) return null;
      raw = raw.replace(/[ \u00a0\u202f]/g, "");
    }
    if (raw.includes(",")) {
      if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+),\d+$/.test(raw)) return null;
      normalized = raw.replace(/\./g, "").replace(",", ".");
    } else if (/^\d{1,3}(?:\.\d{3})+$/.test(raw)) {
      normalized = raw.replace(/\./g, "");
    } else {
      if (!/^\d+(?:\.\d+)?$/.test(raw)) return null;
      normalized = raw;
    }
    normalized = sign + normalized;
  } else {
    return null;
  }

  const negative = normalized.startsWith("-");
  if (negative && !options.allowNegative) return null;
  const [whole, fraction = ""] = normalized.replace(/^-/, "").split(".");
  const absoluteCents = BigInt(whole) * BigInt(100)
    + BigInt(fraction.slice(0, 2).padEnd(2, "0"))
    + BigInt((fraction[2] ?? "0") >= "5" ? 1 : 0);
  if (absoluteCents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(negative ? -absoluteCents : absoluteCents);
}

/** Already-cent values are safe integer cents; never multiply or round them. */
export function parsePropertyIntegerCents(value: unknown, options: MoneyParseOptions = {}): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && (options.allowNegative || value >= 0) ? value : null;
  }
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.length > 32 || !/^[+-]?\d+$/.test(raw)) return null;
  const cents = BigInt(raw);
  if ((!options.allowNegative && cents < BigInt(0)) || cents > BigInt(Number.MAX_SAFE_INTEGER) || cents < -BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(cents);
}

function expandNumberDecimal(value: number) {
  const raw = String(value);
  if (!/[eE]/.test(raw)) return raw;
  const negative = raw.startsWith("-");
  const [mantissa, exponent] = raw.replace(/^-/, "").split(/[eE]/);
  const [whole, fraction = ""] = mantissa.split(".");
  const digits = whole + fraction;
  const point = whole.length + Number(exponent);
  const decimal = point <= 0
    ? `0.${"0".repeat(-point)}${digits}`
    : point >= digits.length
      ? digits + "0".repeat(point - digits.length)
      : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return (negative ? "-" : "") + decimal;
}
