import type { Instrumentation } from "next";

function isProductionRuntime() {
  const vercelEnvironment = process.env.VERCEL_ENV?.trim();
  if (vercelEnvironment) return vercelEnvironment === "production";
  return process.env.NODE_ENV === "production";
}

function safeLogToken(value: unknown, maxLength: number) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().slice(0, maxLength).replace(/[^a-zA-Z0-9_./:-]/g, "_");
  return normalized || undefined;
}

function createInternalRequestId() {
  return `internal:${globalThis.crypto.randomUUID()}`;
}

/**
 * Next.js invokes this for uncaught server errors. The record deliberately
 * excludes request URLs, query strings, headers and error messages so public
 * tokens, email addresses and customer data cannot enter the runtime log.
 */
export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  console.error(JSON.stringify({
    environment: safeLogToken(process.env.VERCEL_ENV, 24) ?? "unknown",
    errorType: safeLogToken(error instanceof Error ? error.name : typeof error, 80) ?? "unknown",
    event: "novalure.request.failed",
    level: "error",
    method: safeLogToken(request.method, 16) ?? "UNKNOWN",
    requestId: createInternalRequestId(),
    route: safeLogToken(context.routePath, 240) ?? "unknown",
    routeType: context.routeType,
    routerKind: context.routerKind,
  }));
};

export async function register() {
  if (process.env.NEXT_RUNTIME === "edge" || !isProductionRuntime()) return;

  const [
    { assertOAuthStateSecretConfigured },
    { assertCsrfConfiguration },
    { assertPublicSubmissionAbuseConfiguration },
    { assertAuthSecurityConfiguration },
    { initializeProductionLaunchActivation },
  ] = await Promise.all([
    import("@/lib/integrations/calendar-oauth-state"),
    import("@/lib/security/csrf"),
    import("@/lib/security/public-submission-abuse"),
    import("@/lib/auth/auth-security"),
    import("@/lib/launch-activation-runtime.server"),
  ]);
  assertOAuthStateSecretConfigured();
  assertCsrfConfiguration();
  assertPublicSubmissionAbuseConfiguration();
  assertAuthSecurityConfiguration();
  await initializeProductionLaunchActivation();

  console.info(JSON.stringify({
    commitSha: safeLogToken(process.env.VERCEL_GIT_COMMIT_SHA, 40),
    environment: safeLogToken(process.env.VERCEL_ENV, 24) ?? "production",
    event: "novalure.runtime.ready",
    level: "info",
    runtime: safeLogToken(process.env.NEXT_RUNTIME, 24) ?? "nodejs",
  }));
}
