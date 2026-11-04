/** Public commercial catalog. Prices are proposals until an individual booking is confirmed. */
export const AI_CATALOG_VERSION = "2026-11-04-draft-v1";

export type AiPlanId = "included" | "ai_plus" | "ai_pro";
export type AiTopupId = "credits_5000" | "credits_20000";
export type AiBookingKind = "plan" | "topup" | "website";
export type WebsiteService = "website_creation" | "hosting" | "maintenance" | "content_updates";

export const AI_PLAN_CATALOG = Object.freeze([
  { id: "included", name: "KI inklusive", monthlyCredits: 1_000, priceCents: 0, provisional: true },
  { id: "ai_plus", name: "KI Plus", monthlyCredits: 21_000, priceCents: 9_900, provisional: true },
  { id: "ai_pro", name: "KI Pro", monthlyCredits: 51_000, priceCents: 19_900, provisional: true },
] as const);

export const AI_TOPUP_CATALOG = Object.freeze([
  { id: "credits_5000", credits: 5_000, priceCents: 2_900, provisional: true },
  { id: "credits_20000", credits: 20_000, priceCents: 9_900, provisional: true },
] as const);

export const WEBSITE_SERVICE_CATALOG = Object.freeze({
  id: "real_estate_website", priceCents: null, pricing: "on_request", customerSpecialPrice: true,
  services: ["website_creation", "hosting", "maintenance", "content_updates"] as readonly WebsiteService[],
});

export function getAiPlan(id: unknown) {
  return AI_PLAN_CATALOG.find((plan) => plan.id === id) ?? null;
}

export function getAiTopup(id: unknown) {
  return AI_TOPUP_CATALOG.find((pack) => pack.id === id) ?? null;
}
