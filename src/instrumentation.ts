function isProductionRuntime() {
  const vercelEnvironment = process.env.VERCEL_ENV?.trim();
  if (vercelEnvironment) return vercelEnvironment === "production";
  return process.env.NODE_ENV === "production";
}

export async function register() {
  if (process.env.NEXT_RUNTIME === "edge" || !isProductionRuntime()) return;

  const [
    { assertOAuthStateSecretConfigured },
    { assertCsrfConfiguration },
    { assertPublicSubmissionAbuseConfiguration },
    { assertAuthSecurityConfiguration },
  ] = await Promise.all([
    import("@/lib/integrations/calendar-oauth-state"),
    import("@/lib/security/csrf"),
    import("@/lib/security/public-submission-abuse"),
    import("@/lib/auth/auth-security"),
  ]);
  assertOAuthStateSecretConfigured();
  assertCsrfConfiguration();
  assertPublicSubmissionAbuseConfiguration();
  assertAuthSecurityConfiguration();
}
