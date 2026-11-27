import { createAutomationGraph, validateAutomationGraph, type AutomationGraph, type AutomationNode } from "./graph";
export const automationStarters = [
  { id: "personal", name: "Neue Anfrage persönlich beantworten" },
  { id: "contact", name: "Fehlende Kontaktdaten anfordern" },
  { id: "profile", name: "Suchprofil ergänzen" },
  { id: "expose", name: "Nach Exposéinteresse persönlich nachfassen" },
  { id: "viewing", name: "Bestätigte Besichtigung nachbereiten" },
  { id: "followup", name: "Nach Phasenwechsel eine Folgeaufgabe anlegen" },
] as const;
export function createAutomationStarter(id: string): AutomationGraph {
  const graph = createAutomationGraph();
  if (id === "personal") return graph;
  const start: AutomationNode = { id: "start", type: "start", title: "Start" }, end: AutomationNode = { id: "end", type: "stop", title: "Ende" };
  const request = (kind: "contact_details" | "search_profile"): AutomationNode => ({ id: "request", type: "request", title: kind === "contact_details" ? "Kontaktdaten sicher ergänzen" : "Suchprofil sicher ergänzen", request: kind, language: "de", subject: "Ihre Immobilienanfrage", body: "Guten Tag {{contact.name}},\nbitte ergänzen Sie Ihre Angaben über das sichere Formular: {{request.url}}\nVielen Dank, {{agent.name}}" });
  if (id === "contact") return validateAutomationGraph({ ...graph, nodes: [start, { id: "check", type: "condition", title: "Telefonnummer fehlt?", condition: "missing_phone" }, request("contact_details"), { id: "task", type: "task", title: "Anfrage persönlich beantworten", dueDays: 0 }, end], edges: [{ from: "start", to: "check", port: "next" }, { from: "check", to: "request", port: "yes" }, { from: "check", to: "task", port: "no" }, { from: "request", to: "end", port: "next" }, { from: "task", to: "end", port: "next" }] });
  if (id === "profile") return validateAutomationGraph({ ...graph, nodes: [start, request("search_profile"), end], edges: [{ from: "start", to: "request", port: "next" }, { from: "request", to: "end", port: "next" }] });
  if (id === "expose") return validateAutomationGraph({ ...graph, trigger: "expose_opened", nodes: [start, { id: "task", type: "task", title: "Exposéinteresse persönlich besprechen", dueDays: 1 }, end], edges: [{ from: "start", to: "task", port: "next" }, { from: "task", to: "end", port: "next" }] });
  if (id === "viewing") return validateAutomationGraph({ ...graph, trigger: "appointment_booked", nodes: [start, { id: "message", type: "email_draft", title: "Besichtigungsnachricht prüfen", subject: "Ihre Besichtigung · {{project.name}}", body: "Guten Tag {{contact.name}},\nvielen Dank für die vereinbarte Besichtigung. Bei Fragen bin ich gerne für Sie da.\n{{agent.name}}" }, end], edges: [{ from: "start", to: "message", port: "next" }, { from: "message", to: "end", port: "next" }] });
  if (id === "followup") return validateAutomationGraph({ ...graph, trigger: "lead_phase_changed", nodes: [start, { id: "wait", type: "wait", title: "Drei Tage warten", hours: 72 }, { id: "task", type: "task", title: "Persönlichen Folgeschritt prüfen", dueDays: 0 }, end], edges: [{ from: "start", to: "wait", port: "next" }, { from: "wait", to: "task", port: "next" }, { from: "task", to: "end", port: "next" }] });
  throw new Error("Die Flowvorlage ist nicht verfügbar.");
}
