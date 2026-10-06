import { CrmCommandError } from "./crm-command";

export type ExactCostValue = Readonly<{
  minorUnits: string;
  provided: boolean;
  source: "EURO_DECIMAL" | "MINOR_UNITS" | "MISSING";
}>;

export type ReconciledCostTriplet = Readonly<{
  net: string;
  tax: string;
  gross: string;
  evidence: Readonly<{
    net: string;
    tax: string;
    gross: string;
    complete: boolean;
    provided: Readonly<{ net: boolean; tax: boolean; gross: boolean }>;
    derived: readonly string[];
  }>;
}>;

const maximumPgBigint = BigInt("9223372036854775807");

function present(value: unknown) {
  return value !== null && value !== undefined && value !== "";
}

function boundedMinorUnits(value: bigint, label: string) {
  if (value < BigInt(0) || value > maximumPgBigint) {
    throw new CrmCommandError("INVALID_MONEY", `${label} is outside the supported nonnegative bigint range`, 400);
  }
  return value.toString();
}

function parseMinorUnits(value: unknown, label: string) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new CrmCommandError("INVALID_MONEY", `${label} must be exact minor units`, 400);
    }
    return String(value);
  }
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,18})$/.test(value)) {
    throw new CrmCommandError("INVALID_MONEY", `${label} must be a canonical nonnegative minor-unit integer`, 400);
  }
  return boundedMinorUnits(BigInt(value), label);
}

function parseEuroDecimal(value: unknown, label: string) {
  const decimal = typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : value;
  if (typeof decimal !== "string" || !/^(?:0|[1-9][0-9]{0,16})(?:\.[0-9]{1,2})?$/.test(decimal)) {
    throw new CrmCommandError("INVALID_MONEY", `${label} must be an exact decimal with at most two fraction digits`, 400);
  }
  const [whole, fraction = ""] = decimal.split(".");
  return boundedMinorUnits(BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0")), label);
}

/** Boundary adapter for legacy property-cost forms. It never rounds or guesses units. */
export function exactCostMinorUnits(euroValue: unknown, centsValue: unknown, label: string): ExactCostValue {
  const hasEuro = present(euroValue);
  const hasCents = present(centsValue);
  if (!hasEuro && !hasCents) return Object.freeze({ minorUnits: "0", provided: false, source: "MISSING" });
  const euro = hasEuro ? parseEuroDecimal(euroValue, label) : null;
  const cents = hasCents ? parseMinorUnits(centsValue, label) : null;
  if (euro !== null && cents !== null && euro !== cents) {
    throw new CrmCommandError("MONEY_REPRESENTATION_MISMATCH", `${label} representations disagree`, 400);
  }
  return Object.freeze({ minorUnits: euro ?? cents!, provided: true,
    source: euro !== null ? "EURO_DECIMAL" : "MINOR_UNITS" });
}

/** Validate a complete net/tax/gross triple or derive exactly one absent value. */
export function reconcileCostTriplet(
  values: { net: ExactCostValue; tax: ExactCostValue; gross: ExactCostValue },
  label: string,
): ReconciledCostTriplet {
  let net = BigInt(values.net.minorUnits);
  let tax = BigInt(values.tax.minorUnits);
  let gross = BigInt(values.gross.minorUnits);
  const supplied = [values.net.provided, values.tax.provided, values.gross.provided];
  const derived: string[] = [];
  if (supplied.filter(Boolean).length === 2) {
    if (!values.gross.provided) { gross = net + tax; derived.push("gross"); }
    else if (!values.tax.provided) {
      if (gross < net) throw new CrmCommandError("MONEY_TOTAL_MISMATCH", `${label} gross is below net`, 400);
      tax = gross - net; derived.push("tax");
    } else {
      if (gross < tax) throw new CrmCommandError("MONEY_TOTAL_MISMATCH", `${label} gross is below tax`, 400);
      net = gross - tax; derived.push("net");
    }
  }
  const complete = supplied.every(Boolean) || supplied.filter(Boolean).length === 2;
  if (complete && net + tax !== gross) {
    throw new CrmCommandError("MONEY_TOTAL_MISMATCH", `${label} net plus tax must equal gross`, 400);
  }
  const result = {
    net: boundedMinorUnits(net, `${label}.net`),
    tax: boundedMinorUnits(tax, `${label}.tax`),
    gross: boundedMinorUnits(gross, `${label}.gross`),
    evidence: {
      net: net.toString(), tax: tax.toString(), gross: gross.toString(), complete,
      provided: { net: values.net.provided, tax: values.tax.provided, gross: values.gross.provided },
      derived,
    },
  };
  return Object.freeze(result);
}
