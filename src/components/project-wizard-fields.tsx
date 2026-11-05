"use client";

import { useEffect, useState } from "react";
import { getDashboardCopy, type LanguageCode } from "@/lib/i18n";
import { projectWizardTypeKeys, type ProjectWizardDetails, type ProjectWizardOptions } from "@/lib/project-wizard";
import type { WorkspaceCustomerType, WorkspaceOperatingModel } from "@/lib/product-model";

export function projectWizardText(language: LanguageCode | "es", de: string, en: string, es: string) {
  return language === "de" ? de : language === "es" ? es : en;
}

function validOptions(data: ProjectWizardOptions | undefined, workspaceId: string): data is ProjectWizardOptions {
  return !!data && data.workspaceId === workspaceId && typeof data.actorId === "string" &&
    Array.isArray(data.projectTypes) && data.projectTypes.every(key => projectWizardTypeKeys.includes(key)) &&
    Array.isArray(data.responsibleUsers) && data.responsibleUsers.every(row => typeof row.id === "string" && typeof row.name === "string") &&
    Array.isArray(data.funnelReferences) && data.funnelReferences.every(row => typeof row.id === "string" && typeof row.name === "string") &&
    Array.isArray(data.pipelineTemplates) && data.pipelineTemplates.every(row => typeof row.key === "string" && typeof row.name === "string");
}

export function useProjectWizardOptions(input: {
  workspaceId: string;
  identityId: string;
  customerType: WorkspaceCustomerType;
  operatingModel: WorkspaceOperatingModel;
  enabled: boolean;
}) {
  const key = JSON.stringify([input.identityId, input.workspaceId, input.customerType, input.operatingModel]);
  const [state, setState] = useState<{ key: string; data?: ProjectWizardOptions; error?: boolean } | null>(null);
  useEffect(() => {
    if (!input.enabled) return;
    const controller = new AbortController();
    let cancelled = false;
    const query = new URLSearchParams({ operation: "wizard-options", workspaceId: input.workspaceId, customerType: input.customerType, operatingModel: input.operatingModel });
    void fetch(`/api/crm/projects?${query}`, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        const body = await response.json() as { data?: ProjectWizardOptions };
        if (!response.ok || !validOptions(body.data, input.workspaceId)) throw new Error("Unavailable project options");
        if (!cancelled) setState({ key, data: body.data });
      })
      .catch(() => { if (!cancelled) setState({ key, error: true }); });
    return () => { cancelled = true; controller.abort(); };
  }, [key, input.workspaceId, input.customerType, input.operatingModel, input.enabled]);
  const current = input.enabled && state?.key === key ? state : null;
  return { data: current?.data, error: current?.error ?? false, loading: input.enabled && !current };
}

export function ProjectWizardSummary({ workspaceId, projectId, projectType, language }: {
  workspaceId: string;
  projectId: string;
  projectType: string;
  language: LanguageCode;
}) {
  const key = `${workspaceId}:${projectId}`;
  const [state, setState] = useState<{ key: string; data?: ProjectWizardDetails; error?: boolean } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    const query = new URLSearchParams({ operation: "wizard-details", workspaceId, projectId });
    void fetch(`/api/crm/projects?${query}`, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        const body = await response.json() as { data?: ProjectWizardDetails };
        if (!response.ok || body.data?.projectId !== projectId || typeof body.data.privateNotes !== "string") throw new Error("Unavailable project details");
        if (!cancelled) setState({ key, data: body.data });
      })
      .catch(() => { if (!cancelled) setState({ key, error: true }); });
    return () => { cancelled = true; controller.abort(); };
  }, [key, workspaceId, projectId]);
  const current = state?.key === key ? state : null;
  const data = current?.data;
  const text = (de: string, en: string, es: string) => projectWizardText(language, de, en, es);
  const empty = text("Keine Auswahl", "None", "Ninguna selección");
  const unavailable = text("Derzeit nicht verfügbar", "Currently unavailable", "Actualmente no disponible");
  const typeLabel = getDashboardCopy(language).dialogs.project.projectTypes.find(row => row.id === (data?.typeKey ?? projectType))?.label ?? projectType;
  return <details className="rounded-lg border border-stone-200 bg-white p-4" data-project-wizard-details>
    <summary className="cursor-pointer font-semibold">{text("Gespeicherte Projektangaben", "Saved project settings", "Datos guardados del proyecto")}</summary>
    {!current ? <p role="status" className="mt-3 text-sm">{text("Projektangaben werden geladen …", "Loading project settings …", "Cargando los datos del proyecto …")}</p>
      : current.error || !data ? <p role="status" className="mt-3 text-sm">{text("Diese Projektangaben sind hier nicht verfügbar.", "These project settings are unavailable here.", "Estos datos del proyecto no están disponibles aquí.")}</p>
        : <dl className="mt-3 grid gap-3 text-sm">
          <div><dt className="font-semibold">{text("Projekttyp", "Project type", "Tipo de proyecto")}</dt><dd data-project-saved-type>{typeLabel}</dd></div>
          <div><dt className="font-semibold">{text("Zuständig", "Responsible", "Responsable")}</dt><dd data-project-saved-responsible>{data.responsibleName ?? (data.responsibleUserId ? unavailable : empty)}</dd></div>
          <div><dt className="font-semibold">{text("Pipeline", "Pipeline", "Pipeline")}</dt><dd data-project-saved-pipeline>{data.pipelineName ?? unavailable}</dd></div>
          <div><dt className="font-semibold">{text("Funnel-Referenz", "Funnel reference", "Referencia de funnel")}</dt><dd data-project-saved-funnel>{data.funnelReferenceTitle ?? (data.funnelReferenceId ? unavailable : empty)}</dd></div>
          <div><dt className="font-semibold">{text("Private Notizen · nur für mich", "Private notes · only for me", "Notas privadas · solo para mí")}</dt><dd className="whitespace-pre-wrap" data-project-private-notes>{data.privateNotes || text("Keine privaten Notizen", "No private notes", "Sin notas privadas")}</dd></div>
          {data.legacy ? <div><dt className="font-semibold">{text("Bestandsprojekt", "Existing project", "Proyecto existente")}</dt><dd className="text-stone-600">{text("Die bisherigen Einstellungen bleiben erhalten.", "Previous settings are retained.", "Se conserva la configuración anterior.")}</dd></div> : null}
        </dl>}
  </details>;
}
