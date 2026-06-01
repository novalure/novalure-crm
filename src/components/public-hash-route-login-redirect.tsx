"use client";

import { useEffect } from "react";
import type { LanguageCode } from "@/lib/i18n";

const appRouteHashes = new Set([
  "analysis",
  "analytics",
  "appointments",
  "bots",
  "buyer-leads",
  "buyers",
  "calendar",
  "consultations",
  "contacts",
  "customer-access",
  "daily-queue",
  "dailyqueue",
  "dashboard",
  "data-hygiene",
  "datahygiene",
  "deals",
  "developer-leads",
  "forms",
  "funnels",
  "lead-inbox",
  "leadinbox",
  "meetings",
  "newsletter",
  "onboarding",
  "pipeline",
  "projects",
  "reservations",
  "seller-leads",
  "sellers",
  "settings",
  "tasks",
  "units",
  "workspaces",
]);

type PublicHashRouteLoginRedirectProps = {
  language: LanguageCode;
};

export function PublicHashRouteLoginRedirect({ language }: PublicHashRouteLoginRedirectProps) {
  useEffect(() => {
    const rawHash = window.location.hash.replace(/^#/, "");
    if (!rawHash) return;

    const normalizedHash = decodeURIComponent(rawHash).split("?")[0]?.toLowerCase() ?? "";
    if (!appRouteHashes.has(normalizedHash)) return;

    const params = new URLSearchParams({
      lang: language,
      returnTo: `/#${rawHash}`,
    });

    window.location.replace(`/login?${params.toString()}`);
  }, [language]);

  return null;
}
