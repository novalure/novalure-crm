"use client";

import { useEffect } from "react";
import {
  defaultLanguage,
  languageCookieName,
  languageStorageKeys,
  resolveLanguage,
  type LanguageCode,
} from "@/lib/i18n";

type LanguageChangeEvent = CustomEvent<{ language?: LanguageCode }>;

function applyDocumentLanguage(language: LanguageCode) {
  document.documentElement.lang = language;
  document.cookie = `${languageCookieName}=${language}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

function readStoredSystemLanguage() {
  return resolveLanguage(window.localStorage.getItem(languageStorageKeys.system), defaultLanguage);
}

function readPageLanguage() {
  const queryLanguage = new URLSearchParams(window.location.search).get("lang");
  if (queryLanguage) return resolveLanguage(queryLanguage, defaultLanguage);

  const pageLanguage = document.querySelector<HTMLElement>("main[lang]")?.getAttribute("lang");
  return resolveLanguage(pageLanguage, readStoredSystemLanguage());
}

export function LanguageHtmlSync() {
  useEffect(() => {
    applyDocumentLanguage(readPageLanguage());

    function handleStorage(event: StorageEvent) {
      if (event.key === languageStorageKeys.system) {
        applyDocumentLanguage(resolveLanguage(event.newValue, defaultLanguage));
      }
    }

    function handleLanguageChange(event: Event) {
      const language = (event as LanguageChangeEvent).detail?.language;
      applyDocumentLanguage(resolveLanguage(language, defaultLanguage));
    }

    window.addEventListener("storage", handleStorage);
    window.addEventListener("novalure:language-change", handleLanguageChange);

    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("novalure:language-change", handleLanguageChange);
    };
  }, []);

  return null;
}
