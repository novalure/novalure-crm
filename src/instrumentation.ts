function isProductionRuntime() {
  const vercelEnvironment = process.env.VERCEL_ENV?.trim();
  if (vercelEnvironment) return vercelEnvironment === "production";
  return process.env.NODE_ENV === "production";
}

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (!isProductionRuntime()) return;
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
  } else if (process.env.NEXT_RUNTIME !== "edge" && isProductionRuntime()) {
    // Keep the existing explicit Edge exclusion; unknown production runtimes
    // fail closed instead of silently skipping the security configuration gates.
    throw new Error("Production security configuration cannot be verified for this runtime");
  }
}
