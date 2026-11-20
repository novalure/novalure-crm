/** Exact hundredths parsing for EUR amounts and percentage inputs; no binary-float rounding. */
export function parseSalesHundredths(raw: string): number {
  const value = raw.trim().replace(",", ".");
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw Error("INVALID_HUNDREDTHS");
  const [whole, fraction = ""] = value.split("."), result = BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0"));
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw Error("UNSAFE_HUNDREDTHS"); return Number(result);
}
export function salesHundredthsInput(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw Error("INVALID_HUNDREDTHS");
  const amount = BigInt(value); return `${amount / BigInt(100)}.${String(amount % BigInt(100)).padStart(2, "0")}`;
}
export function formatSalesPercent(value: unknown, language: string): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return language === "de" ? "Unbekannt" : "Unknown";
  return `${value < 0 ? "−" : ""}${salesHundredthsInput(Math.abs(value)).replace(".", language === "de" ? "," : ".")} %`;
}
export function formatSalesMinor(value: unknown, language: string, unknownLabel = language === "de" ? "Unbekannt" : "Unknown"): string {
  if (typeof value !== "bigint" && (typeof value !== "number" || !Number.isSafeInteger(value))) return unknownLabel;
  const amount = typeof value === "bigint" ? value : BigInt(value), negative = amount < BigInt(0), magnitude = negative ? -amount : amount;
  const integer = new Intl.NumberFormat(language === "de" ? "de-AT" : "en-IE", { maximumFractionDigits: 0 }).format(magnitude / BigInt(100));
  return `${negative ? "−" : ""}${integer}${language === "de" ? "," : "."}${String(magnitude % BigInt(100)).padStart(2, "0")} €`;
}
export function salesLocalDateTime(value: string): string {
  const date = new Date(value); if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
