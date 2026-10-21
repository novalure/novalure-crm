import type { DemoWorkspace } from "./types";

/** Synthetic fixtures are imported exclusively by the isolated preview. */
export const DEMO_WORKSPACES: DemoWorkspace[] = [
  {
    id: "demo-studio",
    name: "Novalure Studio · Demo",
    kind: "studio",
    project: "Website Relaunch",
  },
  {
    id: "demo-developer",
    name: "Parkquartier · Demo",
    kind: "developer",
    project: "Wohnen am Stadtpark",
  },
  {
    id: "demo-broker",
    name: "Bergblick Immobilien · Demo",
    kind: "broker",
    project: "Vermarktung Seeblick",
  },
  {
    id: "demo-company",
    name: "Atelier Linden · Demo",
    kind: "company",
    project: "Digitale Kundenbetreuung",
  },
];

export function demoActivities(context: DemoWorkspace, portal = false) {
  return [
    {
      id: "knowledge",
      title: portal
        ? "Freigegebene Inhalte bereit"
        : "Wissensentwurf zur Prüfung bereit",
      detail: `${context.name} · Unternehmenswissen · ${portal ? "freigegebener Beispielstand" : "Version 4"}`,
      time: "09:20",
      tone: "warning" as const,
      icon: "book",
    },
    {
      id: "project",
      title: "Projektstatus aktualisiert",
      detail: `${context.project} · Designreview vorbereitet`,
      time: "09:05",
      tone: "info" as const,
      icon: "layers",
    },
    {
      id: "assistant",
      title: "Testgespräch abgeschlossen",
      detail: `${context.name} · Webchat in der Designvorschau`,
      time: "08:45",
      tone: "success" as const,
      icon: "chat",
    },
    {
      id: "lead",
      title: "Neue Demo-Anfrage erfasst",
      detail: `${context.project} · Kontaktformular`,
      time: "08:30",
      tone: "violet" as const,
      icon: "users",
    },
  ];
}
