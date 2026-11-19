/** Format configured integer minor units without rounding through a JS number. */
export function formatWebchatMoney(amountMinor: string, currency: string, language: string) {
  if (!/^\d+$/u.test(amountMinor) || !/^[A-Z]{3}$/u.test(currency)) return "—";
  const formatter = new Intl.NumberFormat(language, { style: "currency", currency });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  const divisor = BigInt(10) ** BigInt(digits);
  const value = BigInt(amountMinor);
  const fraction = (value % divisor).toString().padStart(digits, "0");
  return formatter.formatToParts(value / divisor).map(part => part.type === "fraction" ? fraction : part.value).join("");
}
