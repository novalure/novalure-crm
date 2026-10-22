"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  defaultLanguage,
  languageCookieName,
  languageStorageKeys,
  resolveLanguage,
  type LanguageCode,
} from "@/lib/i18n";
import { isPublicLanguageCode, type PublicLanguageCode } from "@/lib/public-language";

type LanguageChangeEvent = CustomEvent<{ language?: LanguageCode }>;

function applyDocumentLanguage(language: PublicLanguageCode) {
  document.documentElement.lang = language;
  document.cookie = `${languageCookieName}=${language}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

function readStoredSystemLanguage() {
  try {
    return resolveLanguage(window.localStorage.getItem(languageStorageKeys.system), defaultLanguage);
  } catch {
    return defaultLanguage;
  }
}

function readPageLanguage() {
  // The authenticated server render is authoritative over query/cookie values
  // from the public site and over another account's old browser preference.
  const crmLanguage = document.querySelector<HTMLElement>("[data-crm-language-preference]")?.getAttribute("lang");
  if (isPublicLanguageCode(crmLanguage)) return crmLanguage;
  const loginLanguage = document.querySelector<HTMLElement>("[data-crm-login-language]")?.getAttribute("lang");
  if (isPublicLanguageCode(loginLanguage)) return loginLanguage;
  const queryLanguage = new URLSearchParams(window.location.search).get("lang");
  if (isPublicLanguageCode(queryLanguage)) return queryLanguage;

  const pageLanguage =
    document.querySelector<HTMLElement>("[data-public-language]")?.getAttribute("data-public-language") ??
    document.querySelector<HTMLElement>("main[lang]")?.getAttribute("lang");
  return isPublicLanguageCode(pageLanguage) ? pageLanguage : readStoredSystemLanguage();
}

export function LanguageHtmlSync() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  useEffect(() => {
    if (document.querySelector("[data-crm-language-preference]")) {
      document.documentElement.lang = readPageLanguage();
    } else {
      applyDocumentLanguage(readPageLanguage());
    }

    function handleStorage(event: StorageEvent) {
      if (document.querySelector("[data-crm-language-preference], [data-crm-login-language]")) return;
      if (event.key === languageStorageKeys.system) {
        applyDocumentLanguage(resolveLanguage(event.newValue, defaultLanguage));
      }
    }

    function handleLanguageChange(event: Event) {
      const language = (event as LanguageChangeEvent).detail?.language;
      if (document.querySelector("[data-crm-language-preference]")) {
        document.documentElement.lang = resolveLanguage(language, defaultLanguage);
      } else {
        applyDocumentLanguage(resolveLanguage(language, defaultLanguage));
      }
    }

    window.addEventListener("storage", handleStorage);
    window.addEventListener("novalure:language-change", handleLanguageChange);

    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("novalure:language-change", handleLanguageChange);
    };
  }, [pathname, search]);

  return null;
}
