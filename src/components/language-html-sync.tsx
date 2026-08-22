"use client";

import { useEffect } from "react";
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
  const persistedLanguage = document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(`${languageCookieName}=`))
    ?.slice(languageCookieName.length + 1);
  if (persistedLanguage !== language) {
    document.cookie = `${languageCookieName}=${language}; Path=/; Max-Age=31536000; SameSite=Lax`;
  }
}

function readStoredSystemLanguage() {
  return resolveLanguage(window.localStorage.getItem(languageStorageKeys.system), defaultLanguage);
}

function readRenderedPageLanguage() {
  const pageLanguage =
    document.querySelector<HTMLElement>("[data-public-language]")?.getAttribute("data-public-language") ??
    document.querySelector<HTMLElement>("main[lang]")?.getAttribute("lang");
  return isPublicLanguageCode(pageLanguage) ? pageLanguage : null;
}

function readPageLanguage() {
  const renderedLanguage = readRenderedPageLanguage();
  if (renderedLanguage) return renderedLanguage;

  const queryLanguage = new URLSearchParams(window.location.search).get("lang");
  if (isPublicLanguageCode(queryLanguage)) return queryLanguage;

  return readStoredSystemLanguage();
}

export function LanguageHtmlSync() {
  useEffect(() => {
    applyDocumentLanguage(readPageLanguage());

    const observer = new MutationObserver(() => {
      const renderedLanguage = readRenderedPageLanguage();
      if (renderedLanguage) applyDocumentLanguage(renderedLanguage);
    });
    observer.observe(document.body, {
      attributeFilter: ["data-public-language", "lang"],
      attributes: true,
      childList: true,
      subtree: true,
    });

    function handleStorage(event: StorageEvent) {
      if (event.key === languageStorageKeys.system) {
        applyDocumentLanguage(readRenderedPageLanguage() ?? resolveLanguage(event.newValue, defaultLanguage));
      }
    }

    function handleLanguageChange(event: Event) {
      const language = (event as LanguageChangeEvent).detail?.language;
      applyDocumentLanguage(readRenderedPageLanguage() ?? resolveLanguage(language, defaultLanguage));
    }

    window.addEventListener("storage", handleStorage);
    window.addEventListener("novalure:language-change", handleLanguageChange);

    return () => {
      observer.disconnect();
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("novalure:language-change", handleLanguageChange);
    };
  }, []);

  return null;
}
