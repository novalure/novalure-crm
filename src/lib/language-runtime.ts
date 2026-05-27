export type LanguageCode = "en" | "de";

export const defaultLanguage: LanguageCode = "de";
export const fallbackLanguage: LanguageCode = defaultLanguage;
export const languageCookieName = "novalure.system-language";
export const languageRequestHeaderName = "x-novalure-language";

export function isLanguageCode(value: unknown): value is LanguageCode {
  return value === "en" || value === "de";
}

export function resolveLanguage(value: unknown, fallback = defaultLanguage): LanguageCode {
  return isLanguageCode(value) ? value : fallback;
}
