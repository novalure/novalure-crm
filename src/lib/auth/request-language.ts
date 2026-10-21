import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { getSessionFromHeaders } from "@/lib/auth/session";
import { getTrustedCrmCountry, resolveAutomaticCrmLanguage, resolveCrmLanguage, type LanguagePreference } from "@/lib/crm-language";
import { readAccountLanguagePreference } from "@/lib/db/language-preference-repository";

/** React cache deduplicates this only within a server request, never between accounts. */
export const getCrmRequestLanguage = cache(async () => {
  const requestHeaders = await headers();
  const session = await getSessionFromHeaders(requestHeaders);
  const country = getTrustedCrmCountry(requestHeaders, process.env.VERCEL === "1");
  let preference: LanguagePreference = "auto";
  let preferenceAvailable = !session;
  if (session?.authIdentityId && !session.serviceIdentity) {
    try {
      preference = await readAccountLanguagePreference(session);
      preferenceAvailable = true;
    } catch {
      // A missing migration or a temporary DB error must not import a browser's
      // previous account preference or claim that a personal choice was saved.
      preferenceAvailable = false;
    }
  }
  return {
    automaticLanguage: resolveAutomaticCrmLanguage(country),
    language: resolveCrmLanguage(preference, country),
    preference,
    preferenceAvailable,
    session,
  };
});
