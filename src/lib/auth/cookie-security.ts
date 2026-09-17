/** Vercel Preview uses HTTPS; keep its cookie transport separate from auth policy. */
export function shouldUseSecureAuthCookies() {
  const environment = process.env.VERCEL_ENV?.trim();
  if (environment) return environment === "production"
    || (process.env.VERCEL === "1" && environment === "preview");
  return process.env.NODE_ENV === "production";
}
