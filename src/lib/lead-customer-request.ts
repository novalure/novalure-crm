export const customerRequestPurposes = ["contact_details", "search_profile", "purchasing_power"] as const;
export type CustomerRequestPurpose = typeof customerRequestPurposes[number];
export type CustomerRequestLanguage = "de" | "en" | "es";
export type CustomerRequestUpload = { id: string; workspaceId: string; leadId: string; requestId: string; provider: "local" | "vercel-blob"; pathname: string; name: string; mime: string; size: number; hash: string };
export type CustomerRequestRecord = { id: string; purpose: CustomerRequestPurpose; language: CustomerRequestLanguage; expiresAt: string; expired: boolean; revokedAt: string | null; submitted: boolean; path: string | null };
export type CustomerRequestSubmission = { id: string; requestId: string; purpose: CustomerRequestPurpose; payload: Record<string, unknown>; fileName: string | null; filePurgeEligible: boolean; filePurgeStarted: boolean; filePurgedAt: string|null; status: "pending" | "accepted" | "rejected"; reason: string | null; version: number; createdAt: string };
export type CustomerRequestState = { settings: { controller: string; privacyUrl: string } | null; canConfigure: boolean; requests: CustomerRequestRecord[]; submissions: CustomerRequestSubmission[] };
export function normalizeCustomerRequestPayload(purpose: CustomerRequestPurpose, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request data");
  const input = value as Record<string, unknown>;
  if (input.privacyRead !== true || input.website) throw new Error("Please acknowledge the privacy information.");
  const string = (key: string, max: number, required = true) => { const v = typeof input[key] === "string" ? input[key].trim() : ""; if (v.length > max || (required && !v)) throw new Error(`Invalid ${key}`); return v; };
  if (purpose === "contact_details") {
    const name = string("name", 200), email = string("email", 254).toLowerCase(), phone = string("phone", 50, false);
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) || /[\r\n]/.test(phone)) throw new Error("Invalid email or phone");
    return { name, email, phone, privacyRead: true, noticeVersion: "lead-request-1" };
  }
  if (purpose === "search_profile") {
    const countryCode = string("countryCode", 2), location = string("location", 300), propertyType = string("propertyType", 100);
    if (!["AT", "DE", "ES", "IE"].includes(countryCode) || !["Wohnung", "Haus", "Neubau", "Zinshaus", "Gewerbe", "Grundstück", "Portfolio"].includes(propertyType)) throw new Error("Invalid search location or property type");
    const from = input.budgetFromCents, to = input.budgetToCents;
    if (typeof from !== "number" || typeof to !== "number" || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= 0 || from > to) throw new Error("Invalid budget range");
    const optional = (key: string, max: number) => { const val = input[key]; if (val === null || val === "" || val === undefined) return null; if (typeof val !== "number" || !Number.isFinite(val) || val <= 0 || val > max) throw new Error(`Invalid ${key}`); return val; };
    return { countryCode, location, propertyType, budgetFromCents: from, budgetToCents: to, areaSqm: optional("areaSqm", 10000000), rooms: optional("rooms", 1000), privacyRead: true, noticeVersion: "lead-request-1" };
  }
  return { note: string("note", 2000, false), privacyRead: true, noticeVersion: "lead-request-1" };
}
