"use client";

import { useEffect, useMemo, useState } from "react";
import {
  getNextOnboardingStepId,
  getOnboardingAudience,
  getOnboardingSteps,
  type OnboardingStep,
  type OnboardingStepId,
  type OnboardingStepStatus,
} from "@/lib/onboarding-checklist";
import type { LanguageCode } from "@/lib/i18n";
import type { ProductRole, TechnicalAppRole } from "@/lib/product-model";

type WorkspaceOnboardingTourProps = {
  language: LanguageCode;
  productRole: ProductRole;
  technicalRole: TechnicalAppRole;
  userName: string;
  workspaceName: string;
};

type OnboardingPayload = {
  completedAt?: string | null;
  completedStepIds?: string[];
  currentStepId?: OnboardingStepId | null;
  dismissedAt?: string | null;
  roleContext?: string | null;
  skippedStepIds?: string[];
  source?: "database" | "fallback" | "migration_pending";
};

type ChecklistCopy = {
  completeAll: string;
  current: string;
  fallbackSave: string;
  help: string;
  intro: string;
  later: string;
  markDone: string;
  openStep: string;
  progress: (done: number, total: number) => string;
  repeat: string;
  resume: string;
  roleFocus: string;
  saved: string;
  skip: string;
  status: Record<OnboardingStepStatus, string>;
  subtitle: string;
  success: (title: string) => string;
  title: string;
  tourTitle: string;
  whyLabel: string;
};

const fallbackStoragePrefix = "novalure_onboarding_progress";

const roleFocusCopy: Record<ReturnType<typeof getOnboardingAudience>, Record<LanguageCode, string>> = {
  admin: {
    de: "Du siehst Setup-Schritte für Workspace, Pipeline, Team, Rechte und operative Starts. Prüfe Rechte bewusst, bevor echte Nutzer eingeladen werden.",
    en: "You see setup steps for workspace, pipeline, team, rights and operational start. Review rights carefully before inviting real users.",
  },
  agent: {
    de: "Du siehst operative Schritte für Lead-Zentrale, Kontakte, Aufgaben und Termine. Admin-Aktionen wie Rollenvergabe bleiben ausgeblendet.",
    en: "You see operational steps for Lead Center, contacts, tasks and appointments. Admin actions such as role assignment stay hidden.",
  },
  viewer: {
    de: "Du siehst nur Orientierungsschritte für lesenden Zugriff. Einladungen, Rechtevergabe und gefährliche Änderungen sind nicht Teil deines Onboardings.",
    en: "You only see orientation steps for read-only access. Invitations, role assignment and risky changes are not part of your onboarding.",
  },
};

const copyByLanguage: Record<LanguageCode, Omit<ChecklistCopy, "roleFocus">> = {
  de: {
    completeAll: "Onboarding abschließen",
    current: "Aktueller Schritt",
    fallbackSave: "Fortschritt wird lokal gemerkt, bis die Profilmigration aktiv ist.",
    help: "Hilfe",
    intro:
      "Diese Einführung erscheint einmal pro Nutzerprofil und kann später über Hilfe erneut geöffnet werden.",
    later: "Später fortsetzen",
    markDone: "Als erledigt markieren",
    openStep: "Schritt öffnen",
    progress: (done, total) => `${done} von ${total} Schritten erledigt`,
    repeat: "Tour wiederholen",
    resume: "Setup fortsetzen",
    saved: "Fortschritt wird im Nutzerprofil gespeichert.",
    skip: "Überspringen",
    status: {
      completed: "Erledigt",
      open: "Offen",
      skipped: "Übersprungen",
      started: "Begonnen",
    },
    subtitle: "Setup-Checkliste für den produktiven Start",
    success: (title) => `${title} wurde gespeichert.`,
    title: "Setup-Checkliste",
    tourTitle: "Willkommen im Novalure CRM",
    whyLabel: "Warum wichtig",
  },
  en: {
    completeAll: "Complete onboarding",
    current: "Current step",
    fallbackSave: "Progress is remembered locally until the profile migration is active.",
    help: "Help",
    intro:
      "This introduction appears once per user profile and can be reopened from Help later.",
    later: "Continue later",
    markDone: "Mark done",
    openStep: "Open step",
    progress: (done, total) => `${done} of ${total} steps done`,
    repeat: "Repeat tour",
    resume: "Resume setup",
    saved: "Progress is stored in the user profile.",
    skip: "Skip",
    status: {
      completed: "Done",
      open: "Open",
      skipped: "Skipped",
      started: "Started",
    },
    subtitle: "Setup checklist for a productive start",
    success: (title) => `${title} was saved.`,
    title: "Setup checklist",
    tourTitle: "Welcome to Novalure CRM",
    whyLabel: "Why it matters",
  },
};

function unique(values: string[]) {
  return [...new Set(values)];
}

function without(values: string[], value: string) {
  return values.filter((item) => item !== value);
}

function getStepStatus(
  stepId: OnboardingStepId,
  currentStepId: OnboardingStepId,
  completedStepIds: string[],
  skippedStepIds: string[],
): OnboardingStepStatus {
  if (completedStepIds.includes(stepId)) return "completed";
  if (skippedStepIds.includes(stepId)) return "skipped";
  if (stepId === currentStepId) return "started";
  return "open";
}

function nextLocalPayload(
  action: string,
  stepId: OnboardingStepId | undefined,
  payload: OnboardingPayload,
  steps: OnboardingStep[],
): OnboardingPayload {
  const completedStepIds = payload.completedStepIds ?? [];
  const skippedStepIds = payload.skippedStepIds ?? [];
  const allowedStepIds = steps.map((step) => step.id);
  const safeStepId = stepId && allowedStepIds.includes(stepId) ? stepId : undefined;

  if (action === "dismiss") {
    return { ...payload, dismissedAt: new Date().toISOString() };
  }

  if (action === "complete_all") {
    return {
      ...payload,
      completedAt: new Date().toISOString(),
      completedStepIds: allowedStepIds,
      currentStepId: "finish",
      skippedStepIds: [],
    };
  }

  if (!safeStepId) return payload;

  if (action === "start") {
    return { ...payload, currentStepId: safeStepId };
  }

  if (action === "skip_step") {
    const nextSkipped = unique([...skippedStepIds, safeStepId]);
    const nextCompleted = without(completedStepIds, safeStepId);
    return {
      ...payload,
      completedStepIds: nextCompleted,
      currentStepId: getNextOnboardingStepId(steps, nextCompleted, nextSkipped),
      skippedStepIds: nextSkipped,
    };
  }

  if (action === "complete_step") {
    const nextCompleted = unique([...completedStepIds, safeStepId]);
    const nextSkipped = without(skippedStepIds, safeStepId);
    return {
      ...payload,
      completedAt: safeStepId === "finish" ? new Date().toISOString() : payload.completedAt,
      completedStepIds: nextCompleted,
      currentStepId: getNextOnboardingStepId(steps, nextCompleted, nextSkipped),
      skippedStepIds: nextSkipped,
    };
  }

  return payload;
}

export function WorkspaceOnboardingTour({
  language,
  productRole,
  technicalRole,
  userName,
  workspaceName,
}: WorkspaceOnboardingTourProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [savingStepId, setSavingStepId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [payload, setPayload] = useState<OnboardingPayload>({
    completedAt: null,
    completedStepIds: [],
    currentStepId: null,
    dismissedAt: null,
    skippedStepIds: [],
    source: "fallback",
  });
  const audience = getOnboardingAudience(productRole, technicalRole);
  const steps = useMemo(
    () => getOnboardingSteps(productRole, technicalRole, language),
    [language, productRole, technicalRole],
  );
  const copy = useMemo<ChecklistCopy>(
    () => ({
      ...copyByLanguage[language],
      roleFocus: roleFocusCopy[audience][language],
    }),
    [audience, language],
  );
  const fallbackStorageKey = `${fallbackStoragePrefix}:${workspaceName}:${userName}:${productRole}`;
  const completedStepIds = payload.completedStepIds ?? [];
  const skippedStepIds = payload.skippedStepIds ?? [];
  const currentStepId =
    payload.currentStepId && steps.some((step) => step.id === payload.currentStepId)
      ? payload.currentStepId
      : getNextOnboardingStepId(steps, completedStepIds, skippedStepIds);
  const doneCount = steps.filter((step) => completedStepIds.includes(step.id)).length;
  const progressPercent = steps.length > 0 ? Math.round((doneCount / steps.length) * 100) : 0;
  const isPersisted = payload.source === "database";

  useEffect(() => {
    let active = true;

    async function loadStatus() {
      try {
        const response = await fetch("/api/auth/onboarding", { cache: "no-store" });
        if (!active) return;

        if (!response.ok) {
          setPayload((current) => ({ ...current, source: "fallback" }));
          setIsOpen(localStorage.getItem(fallbackStorageKey) !== "1");
          return;
        }

        const nextPayload = await response.json() as OnboardingPayload;
        setPayload({
          completedAt: nextPayload.completedAt ?? null,
          completedStepIds: nextPayload.completedStepIds ?? [],
          currentStepId: nextPayload.currentStepId ?? null,
          dismissedAt: nextPayload.dismissedAt ?? null,
          roleContext: nextPayload.roleContext ?? null,
          skippedStepIds: nextPayload.skippedStepIds ?? [],
          source: nextPayload.source ?? "fallback",
        });
        setIsOpen(
          !nextPayload.completedAt &&
          !nextPayload.dismissedAt &&
          localStorage.getItem(fallbackStorageKey) !== "1",
        );
      } catch {
        if (!active) return;
        setPayload((current) => ({ ...current, source: "fallback" }));
        setIsOpen(localStorage.getItem(fallbackStorageKey) !== "1");
      }
    }

    void loadStatus();

    return () => {
      active = false;
    };
  }, [fallbackStorageKey]);

  async function persist(action: "complete_all" | "complete_step" | "dismiss" | "skip_step" | "start", step?: OnboardingStep) {
    if (isSaving) return;
    setIsSaving(true);
    setSavingStepId(step?.id ?? action);
    setNotice("");

    try {
      if (!isPersisted) {
        const nextPayload = nextLocalPayload(action, step?.id, payload, steps);
        setPayload(nextPayload);
        localStorage.setItem(fallbackStorageKey, nextPayload.completedAt ? "1" : "0");
        if (action === "dismiss" || action === "complete_all" || step?.id === "finish") setIsOpen(false);
        return;
      }

      const response = await fetch("/api/auth/onboarding", {
        body: JSON.stringify({ action, stepId: step?.id }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      if (!response.ok) throw new Error("onboarding_progress_not_saved");

      const nextPayload = await response.json() as OnboardingPayload;
      setPayload({
        completedAt: nextPayload.completedAt ?? null,
        completedStepIds: nextPayload.completedStepIds ?? [],
        currentStepId: nextPayload.currentStepId ?? null,
        dismissedAt: nextPayload.dismissedAt ?? null,
        roleContext: nextPayload.roleContext ?? null,
        skippedStepIds: nextPayload.skippedStepIds ?? [],
        source: nextPayload.source ?? "database",
      });

      if (action === "complete_step" && step) setNotice(copy.success(step.title));
      if (action === "skip_step" && step) setNotice(copy.success(step.title));
      if (action === "dismiss" || action === "complete_all" || step?.id === "finish") setIsOpen(false);
    } catch {
      const nextPayload = nextLocalPayload(action, step?.id, payload, steps);
      setPayload(nextPayload);
      localStorage.setItem(fallbackStorageKey, nextPayload.completedAt ? "1" : "0");
      if (action === "dismiss" || action === "complete_all" || step?.id === "finish") setIsOpen(false);
    } finally {
      setIsSaving(false);
      setSavingStepId(null);
      setIsMenuOpen(false);
    }
  }

  async function openTarget(step: OnboardingStep) {
    await persist("start", step);
    if (typeof window !== "undefined") {
      const nextUrl = `${window.location.pathname}${window.location.search}#${step.targetHash}`;
      window.history.pushState(null, "", nextUrl);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    }
    setIsOpen(false);
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
          <div className="absolute right-0 top-full z-40 mt-2 w-64 rounded-lg border border-stone-200 bg-white p-2 text-sm shadow-lg">
            <button
              className="w-full rounded-md px-3 py-2 text-left font-semibold text-slate-800 hover:bg-stone-100"
              onClick={() => {
                setIsOpen(true);
                setIsMenuOpen(false);
              }}
              type="button"
            >
              {payload.completedAt ? copy.repeat : copy.resume}
            </button>
            <button
              className="mt-1 w-full rounded-md px-3 py-2 text-left font-semibold text-slate-800 hover:bg-stone-100"
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
        <div className="fixed inset-0 z-[90] overflow-y-auto bg-slate-950/55 px-3 py-4 backdrop-blur-sm sm:px-5 sm:py-6">
          <section
            aria-labelledby="workspace-onboarding-title"
            aria-modal="true"
            className="mx-auto flex min-h-[calc(100dvh-2rem)] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-stone-200 bg-white text-slate-950 shadow-2xl sm:min-h-0"
            role="dialog"
          >
            <div className="border-b border-stone-200 p-4 sm:p-5">
              <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0">
                  <p className="break-words text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
                    {workspaceName}
                  </p>
                  <h2 className="mt-2 text-3xl font-semibold leading-tight" id="workspace-onboarding-title">
                    {copy.tourTitle}
                  </h2>
                  <p className="mt-2 break-words text-sm leading-6 text-stone-600">{copy.intro}</p>
                </div>
                <button
                  className="min-h-11 rounded-md border border-stone-300 px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-stone-100"
                  disabled={isSaving}
                  onClick={() => void persist("dismiss")}
                  type="button"
                >
                  {copy.later}
                </button>
              </div>
              <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm font-semibold leading-6 text-emerald-950">
                {copy.roleFocus}
              </div>
              <div className="mt-4">
                <div className="flex items-center justify-between gap-3 text-xs font-semibold uppercase tracking-[0.14em] text-stone-500">
                  <span>{copy.subtitle}</span>
                  <span>{copy.progress(doneCount, steps.length)}</span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-stone-100">
                  <div className="h-full rounded-full bg-emerald-600" style={{ width: `${progressPercent}%` }} />
                </div>
              </div>
            </div>

            <div className="grid flex-1 gap-4 overflow-y-auto p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_16rem]">
              <div className="grid min-w-0 gap-3">
                {steps.map((step, index) => {
                  const status = getStepStatus(step.id, currentStepId, completedStepIds, skippedStepIds);
                  const isCurrent = status === "started";
                  const isSavingStep = savingStepId === step.id;

                  return (
                    <article
                      className={`rounded-md border p-4 ${
                        isCurrent
                          ? "border-emerald-300 bg-emerald-50"
                          : "border-stone-200 bg-stone-50"
                      }`}
                      key={`${step.id}-${index}`}
                    >
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-stone-500">
                            {String(index + 1).padStart(2, "0")}
                            {isCurrent ? ` · ${copy.current}` : ""}
                          </p>
                          <h3 className="mt-2 text-lg font-semibold">{step.title}</h3>
                          <p className="mt-2 break-words text-sm leading-6 text-stone-700">{step.body}</p>
                        </div>
                        <span className="inline-flex w-fit shrink-0 rounded-full border border-stone-300 bg-white px-3 py-1 text-xs font-semibold text-slate-800">
                          {copy.status[status]}
                        </span>
                      </div>
                      <div className="mt-3 rounded-md border border-white/70 bg-white/80 p-3 text-sm leading-6 text-stone-700">
                        <span className="font-semibold text-slate-950">{copy.whyLabel}: </span>
                        {step.why}
                      </div>
                      {step.safetyNote ? (
                        <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm font-semibold leading-6 text-amber-950">
                          {step.safetyNote}
                        </p>
                      ) : null}
                      <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto_auto]">
                        <button
                          className="min-h-11 rounded-md border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-60"
                          disabled={isSaving}
                          onClick={() => void openTarget(step)}
                          type="button"
                        >
                          {step.actionLabel || copy.openStep}
                        </button>
                        <button
                          className="min-h-11 rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-stone-400"
                          disabled={isSaving || status === "completed"}
                          onClick={() => void persist("complete_step", step)}
                          type="button"
                        >
                          {isSavingStep ? "..." : copy.markDone}
                        </button>
                        {step.canSkip ? (
                          <button
                            className="min-h-11 rounded-md border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-60"
                            disabled={isSaving || status === "skipped"}
                            onClick={() => void persist("skip_step", step)}
                            type="button"
                          >
                            {copy.skip}
                          </button>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>

              <aside className="h-fit rounded-md border border-stone-200 bg-white p-4 text-sm leading-6 text-stone-700">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-stone-500">
                  {copy.title}
                </p>
                <p className="mt-2 font-semibold text-slate-950">{copy.progress(doneCount, steps.length)}</p>
                <p className="mt-2">{isPersisted ? copy.saved : copy.fallbackSave}</p>
                {notice ? (
                  <p className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 font-semibold text-emerald-950">
                    {notice}
                  </p>
                ) : null}
              </aside>
            </div>

            <div className="sticky bottom-0 flex flex-col gap-2 border-t border-stone-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
              <p className="text-xs font-semibold text-stone-500">
                {isPersisted ? copy.saved : copy.fallbackSave}
              </p>
              <button
                className="min-h-11 rounded-md bg-slate-950 px-4 py-3 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-stone-400"
                disabled={isSaving}
                onClick={() => void persist("complete_all")}
                type="button"
              >
                {copy.completeAll}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
