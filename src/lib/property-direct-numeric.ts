const moneyFields = ["price", "publicPrice", "rentPrice", "rentNet", "monthlyCostsGross", "purchaseAncillaryCosts"] as const;
const costAmountFields = ["monthlyNet", "monthlyVat", "monthlyGross", "oneTimeNet", "oneTimeVat", "oneTimeGross"] as const;
type NumericField = "areaSqm" | "rooms" | "yearBuilt" | typeof moneyFields[number];
type CostAmounts = Partial<Record<typeof costAmountFields[number], string>>;

export type DirectPropertyNumericDraft = Partial<Record<NumericField, string>> & {
  costItems?: readonly CostAmounts[];
};
export type DirectPropertyNumericErrorCode = "INVALID_FORMAT" | "UNSUPPORTED_EXPONENT" | "EXCESS_PRECISION" | "NEGATIVE_VALUE" | "UNSAFE_CENTS";

export class DirectPropertyNumericDraftError extends Error {
  constructor(
    public readonly code: DirectPropertyNumericErrorCode,
    public readonly field: string,
    public readonly scale: number,
  ) {
    super(`Invalid direct numeric input: ${field} (${code}).`);
    this.name = "DirectPropertyNumericDraftError";
  }
}

/** Native number inputs expose dot-decimal strings, including trailing zeros.
 * Normalize those lexical values before the EUR text parser can mistake three
 * fractional digits for grouping. This is deliberately not a text-input parser.
 * Keep amounts as strings: Number(value) can lose a cent near the safe limit. */
function normalize(value: string, field: string, scale: number, money = false) {
  const fail = (code: DirectPropertyNumericErrorCode): never => { throw new DirectPropertyNumericDraftError(code, field, scale); };
  if (typeof value !== "string") return fail("INVALID_FORMAT");
  const raw = value.trim();
  if (!raw) return "";
  if (raw.length > 128) return fail("INVALID_FORMAT");
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)[eE][+-]?\d*$/.test(raw)) return fail("UNSUPPORTED_EXPONENT");
  if (!/^-?(?:\d+|\d*\.\d+)$/.test(raw)) return fail("INVALID_FORMAT");
  const [integer = "", digits = ""] = raw.replace(/^-/, "").split(".");
  const whole = integer.replace(/^0+/, "") || "0";
  const fraction = digits.replace(/0+$/, "");
  if (raw.startsWith("-") && (whole !== "0" || fraction)) return fail("NEGATIVE_VALUE");
  if (fraction.length > scale) return fail("EXCESS_PRECISION");
  if (money && BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0")) > BigInt(Number.MAX_SAFE_INTEGER)) return fail("UNSAFE_CENTS");
  return whole + (fraction ? "." + fraction : "");
}

/** Copy only the direct form's numeric fields; preserve all extra typed fields
 * and their references. Guided/editor German text inputs must not use this. */
export function normalizeDirectPropertyNumericDraft<T extends DirectPropertyNumericDraft>(draft: T): T {
  const result = { ...draft };
  for (const [field, scale] of [["areaSqm", 2], ["rooms", 1], ["yearBuilt", 0]] as const) {
    if (draft[field] !== undefined) result[field] = normalize(draft[field], field, scale);
  }
  for (const field of moneyFields) {
    if (draft[field] !== undefined) result[field] = normalize(draft[field], field, 2, true);
  }
  if (draft.costItems !== undefined) {
    result.costItems = draft.costItems.map((item, index) => {
      const cost = { ...item };
      for (const field of costAmountFields) {
        if (item[field] !== undefined) cost[field] = normalize(item[field], `costItems.${index}.${field}`, 2, true);
      }
      return cost;
    });
  }
  return result;
}
