import "server-only";
import { BookingError, type BookingProviderName } from "./types";

export type BookingRuntimeMode = "preview" | "production" | "disabled";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Production never derives its authority from a request Host or a preview URL. */
export function bookingProductionOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.NOVALURE_APP_ORIGIN?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      url.pathname !== "/" || url.hostname === "localhost" || url.hostname.endsWith(".localhost") ||
      url.hostname.endsWith(".invalid") || url.hostname.endsWith(".test") || /^[\d.]+$/.test(url.hostname) ||
      url.hostname.startsWith("[")) return null;
    return url.origin;
  } catch { return null; }
}

export function bookingProductionConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const origin = bookingProductionOrigin(env);
  const activationId = env.BOOKING_PRODUCTION_ACTIVATION_ID?.trim() || "";
  const activatedAt = env.BOOKING_PRODUCTION_ACTIVATED_AT?.trim() || "";
  const validTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(activatedAt) &&
    Number.isFinite(Date.parse(activatedAt)) && Date.parse(activatedAt) <= Date.now();
  if (!origin || !uuid.test(activationId) || !validTime) return null;
  return { origin, activationId, activatedAt: new Date(activatedAt).toISOString() };
}

/** Environment enablement alone never grants access to a production calendar. */
export function bookingRuntimeMode(env: NodeJS.ProcessEnv = process.env): BookingRuntimeMode {
  if (env.BOOKING_ENGINE_ENABLED !== "1") return "disabled";
  if (env.VERCEL_ENV === "production") {
    if (env.BOOKING_PRODUCTION_ENABLED !== "1" ||
      env.BOOKING_TEST_BINDINGS_JSON !== undefined || env.BOOKING_MAIL_TEST_BINDINGS_JSON !== undefined ||
      !bookingProductionConfiguration(env)) return "disabled";
    return "production";
  }
  if (env.BOOKING_PRODUCTION_ENABLED === "1") return "disabled";
  if (env.VERCEL_ENV === "preview" || !env.VERCEL_ENV && ["test", "development"].includes(env.NODE_ENV || "")) return "preview";
  return "disabled";
}

export function assertBookingRuntime(env: NodeJS.ProcessEnv = process.env) {
  const mode = bookingRuntimeMode(env);
  if (mode === "disabled") throw new BookingError("BOOKING_NOT_ENABLED", 403);
  return mode;
}

export type BookingOAuthReadiness = {
  configured: boolean;
  authorityCompatible: boolean | null;
  externalCustomerReady: boolean;
  status: "not_configured" | "configuration_invalid" | "external_not_verified" | "external_verified";
  /** Application credentials have no trustworthy expiry date in the runtime config. */
  credentialExpiry: "not_verified";
};

/** Operator declarations reflect independently checked provider metadata, never a client claim. */
export function bookingOAuthReadiness(provider: BookingProviderName, env: NodeJS.ProcessEnv = process.env): BookingOAuthReadiness {
  const configured = Boolean(env[provider === "google" ? "GOOGLE_CLIENT_ID" : "MICROSOFT_CLIENT_ID"]?.trim() &&
    env[provider === "google" ? "GOOGLE_CLIENT_SECRET" : "MICROSOFT_CLIENT_SECRET"]?.trim());
  let authorityCompatible: boolean | null = null;
  let externalCustomerReady = false;
  if (provider === "google") {
    const status = env.BOOKING_GOOGLE_OAUTH_STATUS;
    authorityCompatible = status === undefined ? null : ["testing", "internal", "production"].includes(status);
    externalCustomerReady = configured && status === "production" && env.BOOKING_GOOGLE_EXTERNAL_OAUTH_VERIFIED === "1";
  } else {
    const authority = env.BOOKING_MICROSOFT_AUTHORITY?.trim() || "common";
    const accountType = env.BOOKING_MICROSOFT_ACCOUNT_TYPE;
    authorityCompatible = accountType === undefined ? null :
      accountType === "single_tenant" ? uuid.test(authority) :
      accountType === "organizations" ? authority === "organizations" :
      accountType === "organizations_and_personal" ? authority === "common" :
      accountType === "personal" ? authority === "consumers" : false;
    externalCustomerReady = configured && authorityCompatible === true && accountType !== "single_tenant" &&
      env.BOOKING_MICROSOFT_EXTERNAL_OAUTH_VERIFIED === "1";
  }
  return { configured, authorityCompatible, externalCustomerReady,
    status: !configured ? "not_configured" : authorityCompatible === false ? "configuration_invalid" :
      externalCustomerReady ? "external_verified" : "external_not_verified", credentialExpiry: "not_verified" };
}

export function assertBookingOAuthConfiguration(provider: BookingProviderName, env: NodeJS.ProcessEnv = process.env) {
  assertBookingRuntime(env);
  if (bookingRuntimeMode(env) !== "production") return;
  const readiness = bookingOAuthReadiness(provider, env);
  if (!readiness.configured || readiness.authorityCompatible !== true)
    throw new BookingError("BOOKING_OAUTH_CONFIGURATION_REQUIRED", 503);
}
