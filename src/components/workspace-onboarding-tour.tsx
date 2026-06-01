"use client";

import { useEffect, useMemo, useState } from "react";
import type { LanguageCode } from "@/lib/i18n";
import type { ProductRole } from "@/lib/product-model";

type WorkspaceOnboardingTourProps = {
  language: LanguageCode;
  productRole: ProductRole;
  userName: string;
  workspaceName: string;
};

type TourStep = {
  body: string;
  title: string;
};

type TourCopy = {
  close: string;
  complete: string;
  fallbackSave: string;
  help: string;
  loading: string;
  repeat: string;
  roleFocus: string;
  steps: TourStep[];
  subtitle: string;
  title: string;
};

const fallbackStoragePrefix = "novalure_onboarding_completed";

const roleFocusCopy: Partial<Record<ProductRole, Record<LanguageCode, string>>> = {
  assistant_backoffice: {
    de: "Platzhalter zur Freigabe: Assistenzrollen starten bei Aufgaben, Terminen und sauberer Übergabe.",
    en: "Approval placeholder: assistant roles start with tasks, appointments and clean handover.",
  },
  broker_agent: {
    de: "Platzhalter zur Freigabe: Maklerrollen starten bei Lead-Zentrale, Tagesqueue und Pipeline.",
    en: "Approval placeholder: broker roles start with Lead Center, Daily Queue and pipeline.",
  },
  customer_owner: {
    de: "Platzhalter zur Freigabe: Kundenverantwortliche starten bei Pipeline, Zuständigkeiten und offenen Risiken.",
    en: "Approval placeholder: customer owners start with pipeline, ownership and open risks.",
  },
  developer_sales: {
    de: "Platzhalter zur Freigabe: Bauträger-Teams starten bei Projektübersicht, Einheiten, Reservierungen und Pipeline.",
    en: "Approval placeholder: developer teams start with project overview, units, reservations and pipeline.",
  },
  novalureAdmin: {
    de: "Platzhalter zur Freigabe: Admins starten bei Nutzerrechten, Datenhygiene und Integrationen.",
    en: "Approval placeholder: admins start with user rights, data hygiene and integrations.",
  },
  novalureGrowth: {
    de: "Platzhalter zur Freigabe: Growth startet bei Lead-Zentrale, Funnels, Follow-up und Pipeline.",
    en: "Approval placeholder: growth starts with Lead Center, funnels, follow-up and pipeline.",
  },
  novalure_onboarding: {
    de: "Platzhalter zur Freigabe: Onboarding startet bei Kunden-Setup, Risiken und nächsten Aktivierungsschritten.",
    en: "Approval placeholder: onboarding starts with customer setup, risks and next activation steps.",
  },
  novalure_sales: {
    de: "Platzhalter zur Freigabe: Vertrieb startet in der Tagesqueue mit heißen Leads, Rückrufen und heutigen Terminen.",
    en: "Approval placeholder: sales starts in the daily queue with hot leads, callbacks and today's appointments.",
  },
  project_sales_member: {
    de: "Platzhalter zur Freigabe: Projektvertrieb startet bei Lead-Zentrale, Terminen und Projektpipeline.",
    en: "Approval placeholder: project sales starts with Lead Center, appointments and project pipeline.",
  },
  workspace_admin: {
    de: "Platzhalter zur Freigabe: Workspace-Admins starten bei Nutzerrechten, Datenhygiene und Integrationen.",
    en: "Approval placeholder: workspace admins start with user rights, data hygiene and integrations.",
  },
};

const copyByLanguage: Record<LanguageCode, Omit<TourCopy, "roleFocus">> = {
  de: {
    close: "Später",
    complete: "Tour verstanden",
    fallbackSave: "Wird für diese Sitzung gemerkt, bis die Profilmigration aktiv ist.",
    help: "Hilfe",
    loading: "Nach Bestätigung wird dies im Nutzerprofil gespeichert.",
    repeat: "Tour wiederholen",
    steps: [
      {
        title: "Was siehst du hier?",
        body: "Platzhalter zur Freigabe: Das Cockpit bündelt Leads, Aufgaben, Termine, Pipeline und Auswertungen passend zu deiner Rolle.",
      },
      {
        title: "Wo fängst du an?",
        body: "Platzhalter zur Freigabe: Starte in der Lead-Zentrale oder Tagesqueue und arbeite zuerst Leads mit nächster Aktion ab.",
      },
      {
        title: "Sprache und Profil",
        body: "Platzhalter zur Freigabe: Sprache und Arbeitsprofil findest du oben im Cockpit; der Rollenwechsel lädt den passenden Startbereich.",
      },
      {
        title: "Wo findest du Hilfe?",
        body: "Platzhalter zur Freigabe: Öffne Hilfe und wiederhole diese Tour; Wissensquellen und Support-Hinweise folgen nach Freigabe.",
      },
    ],
    subtitle:
      "Platzhaltertexte zur Freigabe. Diese Einführung erscheint einmal pro Nutzerprofil und kann später über Hilfe erneut geöffnet werden.",
    title: "Willkommen im Novalure CRM",
  },
  en: {
    close: "Later",
    complete: "Got it",
    fallbackSave: "Remembered for this session until the profile migration is active.",
    help: "Help",
    loading: "Confirming stores this in the user profile.",
    repeat: "Repeat tour",
    steps: [
      {
        title: "What are you seeing?",
        body: "Approval placeholder: the cockpit brings leads, tasks, appointments, pipeline and analysis together for your role.",
      },
      {
        title: "Where do you start?",
        body: "Approval placeholder: start in Lead Center or Daily Queue and work leads with a clear next action first.",
      },
      {
        title: "Language and profile",
        body: "Approval placeholder: language and work profile live at the top of the cockpit; profile changes load the matching start area.",
      },
      {
        title: "Where do you get help?",
        body: "Approval placeholder: open Help and repeat this tour; knowledge-source and support text follows after approval.",
      },
    ],
    subtitle:
      "Approval placeholder text. This introduction appears once per user profile and can be reopened from Help later.",
    title: "Welcome to Novalure CRM",
  },
};

function getRoleFocus(productRole: ProductRole, language: LanguageCode) {
  return (
    roleFocusCopy[productRole]?.[language] ??
    (language === "de"
      ? "Platzhalter zur Freigabe: Dein Arbeitsprofil bestimmt, welche Module und Startansichten zuerst sichtbar sind."
      : "Approval placeholder: your work profile controls which modules and start views are visible first.")
  );
}

export function WorkspaceOnboardingTour({
  language,
  productRole,
  userName,
  workspaceName,
}: WorkspaceOnboardingTourProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [source, setSource] = useState<"database" | "fallback" | "migration_pending" | "unknown">("unknown");
  const copy = useMemo<TourCopy>(
    () => ({
      ...copyByLanguage[language],
      roleFocus: getRoleFocus(productRole, language),
    }),
    [language, productRole],
  );
  const fallbackStorageKey = `${fallbackStoragePrefix}:${workspaceName}:${userName}:${productRole}`;

  useEffect(() => {
    let active = true;

    async function loadStatus() {
      try {
        const response = await fetch("/api/auth/onboarding", { cache: "no-store" });
        if (!active) return;

        if (!response.ok) {
          setSource("fallback");
          setIsOpen(localStorage.getItem(fallbackStorageKey) !== "1");
          return;
        }

        const payload = (await response.json()) as {
          completedAt?: string | null;
          source?: "database" | "fallback" | "migration_pending";
        };
        const nextSource = payload.source ?? "unknown";
        setSource(nextSource);
        setIsOpen(!payload.completedAt && localStorage.getItem(fallbackStorageKey) !== "1");
      } catch {
        if (!active) return;
        setSource("fallback");
        setIsOpen(localStorage.getItem(fallbackStorageKey) !== "1");
      }
    }

    void loadStatus();

    return () => {
      active = false;
    };
  }, [fallbackStorageKey]);

  async function completeTour() {
    if (isSaving) return;
    setIsSaving(true);

    try {
      const response = await fetch("/api/auth/onboarding", { method: "POST" });
      if (!response.ok) {
        localStorage.setItem(fallbackStorageKey, "1");
      }
    } catch {
      localStorage.setItem(fallbackStorageKey, "1");
    } finally {
      setIsSaving(false);
      setIsOpen(false);
      setIsMenuOpen(false);
    }
  }

  return (
    <>
      <div className="relative">
        <button
          aria-expanded={isMenuOpen}
          className="min-h-12 rounded-md border border-stone-300 bg-white px-4 py-2.5 text-center text-sm font-semibold leading-5 text-slate-800 hover:bg-stone-100"
          onClick={() => setIsMenuOpen((current) => !current)}
          type="button"
        >
          {copy.help}
        </button>
        {isMenuOpen ? (
          <div className="absolute right-0 top-full z-40 mt-2 w-56 rounded-lg border border-stone-200 bg-white p-2 text-sm shadow-lg">
            <button
              className="w-full rounded-md px-3 py-2 text-left font-semibold text-slate-800 hover:bg-stone-100"
              onClick={() => {
                setIsOpen(true);
                setIsMenuOpen(false);
              }}
              type="button"
            >
              {copy.repeat}
            </button>
          </div>
        ) : null}
      </div>

      {isOpen ? (
        <div className="fixed inset-0 z-[90] overflow-y-auto bg-slate-950/55 px-4 py-6 backdrop-blur-sm">
          <section
            aria-labelledby="workspace-onboarding-title"
            aria-modal="true"
            className="mx-auto w-full max-w-2xl rounded-lg border border-stone-200 bg-white p-5 text-slate-950 shadow-2xl"
            role="dialog"
          >
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
                  {workspaceName}
                </p>
                <h2 className="mt-2 text-2xl font-semibold leading-tight" id="workspace-onboarding-title">
                  {copy.title}
                </h2>
                <p className="mt-3 break-words text-sm leading-6 text-stone-600">{copy.subtitle}</p>
              </div>
              <button
                className="rounded-md border border-stone-300 px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-stone-100"
                onClick={() => setIsOpen(false)}
                type="button"
              >
                {copy.close}
              </button>
            </div>

            <div className="mt-5 rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm font-semibold leading-6 text-emerald-950">
              {copy.roleFocus}
            </div>

            <div className="mt-5 grid gap-3">
              {copy.steps.map((step, index) => (
                <article className="rounded-md border border-stone-200 bg-stone-50 p-4" key={step.title}>
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-stone-500">
                    {String(index + 1).padStart(2, "0")}
                  </p>
                  <h3 className="mt-2 text-lg font-semibold">{step.title}</h3>
                  <p className="mt-2 break-words text-sm leading-6 text-stone-600">{step.body}</p>
                </article>
              ))}
            </div>

            <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs font-semibold text-stone-500">
                {source === "database" ? copy.loading : copy.fallbackSave}
              </p>
              <button
                className="min-h-11 rounded-md bg-slate-950 px-4 py-3 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-stone-400"
                disabled={isSaving}
                onClick={() => void completeTour()}
                type="button"
              >
                {copy.complete}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
