import { automationMessageVariableIssues } from "./message-variables";
/** Persisted automation contract shared by the editor, preview and runner. */
export const automationTriggers = ["new_lead", "search_profile_completed", "expose_opened", "appointment_booked", "lead_phase_changed", "proof_uploaded", "new_match"] as const;
export type AutomationTrigger = typeof automationTriggers[number];
export type AutomationSignal = AutomationTrigger | "personal_contact" | "reply_received" | "opt_out" | "manual_start" | "proof_reviewed";
export const automationConditions = ["missing_phone", "missing_address", "has_phone", "expose_opened", "lead_replied", "appointment_booked", "proof_accepted", "search_profile_exists", "match_at_least", "inquiry_contains", "is_phase"] as const;
export type AutomationCondition = typeof automationConditions[number];
export type AutomationNode = {
  id: string; type: "start" | "wait" | "condition" | "task" | "email_draft" | "request" | "phase" | "stop";
  title: string; hours?: number; condition?: AutomationCondition; value?: string;
  subject?: string; body?: string; dueDays?: number;
  request?: "contact_details" | "search_profile" | "purchasing_power";
  language?: "de" | "en" | "es";
};
export type AutomationEdge = { from: string; to: string; port: "next" | "yes" | "no" };
export type AutomationGraph = { schemaVersion: 1; trigger: AutomationTrigger; timezone: string; businessHours: boolean; stopOnPersonalContact: boolean; nodes: AutomationNode[]; edges: AutomationEdge[] };
export type AutomationFacts = { phone: string | null; address: string | null | undefined; phase: string; inquiry: string; exposeOpened: boolean | null; replied: boolean | null; booked: boolean | null; proofAccepted: boolean | null; searchProfileExists: boolean | null; matchScore: number | null; optedOut: boolean; personalContact: boolean };

export class AutomationValidationError extends Error {}
const fail = (message: string): never => { throw new AutomationValidationError(message); };
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number, label: string, required = false) => {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) return fail(`${label} ist ungültig.`);
  return value.trim();
};
const idPattern = /^[a-zA-Z0-9_-]{1,80}$/;
export const automationPhases = ["Neu", "Qualifizieren", "Termin offen", "Qualifiziert", "Übergabe", "Archiviert"] as const;

export function validateAutomationGraph(value: unknown, options: { allowLegacyVariables?: boolean } = {}): AutomationGraph {
  if (!plain(value) || value.schemaVersion !== 1 || !(automationTriggers as readonly unknown[]).includes(value.trigger)) fail("Auslöser oder Graphversion ist ungültig.");
  if (!plain(value)) return fail("Graph ist ungültig.");
  const timezone = text(value.timezone, 80, "Zeitzone", true);
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); } catch { fail("Zeitzone ist ungültig."); }
  if (typeof value.businessHours !== "boolean" || typeof value.stopOnPersonalContact !== "boolean") fail("Zeit- und Stoppregeln fehlen.");
  if (!Array.isArray(value.nodes) || value.nodes.length < 2 || value.nodes.length > 100 || !Array.isArray(value.edges) || value.edges.length > 200) fail("Ein Flow benötigt 2 bis 100 Schritte.");
  const nodes = (value.nodes as unknown[]).map((raw): AutomationNode => {
    if (!plain(raw) || typeof raw.id !== "string" || !idPattern.test(raw.id) || !["start", "wait", "condition", "task", "email_draft", "request", "phase", "stop"].includes(String(raw.type))) return fail("Schritt ist ungültig.");
    const node: AutomationNode = { id: raw.id, type: raw.type as AutomationNode["type"], title: text(raw.title, 300, "Schritttitel", true) };
    if (node.type === "wait") {
      if (typeof raw.hours !== "number" || !Number.isFinite(raw.hours) || raw.hours < 0.0167 || raw.hours > 8760) fail("Wartezeit muss zwischen einer Minute und einem Jahr liegen.");
      node.hours = raw.hours as number;
    }
    if (node.type === "condition") {
      if (!(automationConditions as readonly unknown[]).includes(raw.condition)) fail("Bedingung ist ungültig.");
      node.condition = raw.condition as AutomationCondition;
      if (["inquiry_contains", "is_phase", "match_at_least"].includes(node.condition)) node.value = text(raw.value, 500, "Bedingungswert", true);
      if (node.condition === "match_at_least" && (!/^\d{1,3}$/.test(node.value!) || Number(node.value) > 100)) fail("Matching-Grenze muss zwischen 0 und 100 liegen.");
      if (node.condition === "inquiry_contains" && !node.value!.split(",").some((v) => v.trim())) fail("Mindestens ein Suchwort ist erforderlich.");
    }
    if (node.type === "task") {
      if (!Number.isInteger(raw.dueDays) || Number(raw.dueDays) < 0 || Number(raw.dueDays) > 365) fail("Aufgabenfrist ist ungültig.");
      node.dueDays = raw.dueDays as number;
    }
    if (node.type === "email_draft" || node.type === "request") {
      node.subject = text(raw.subject, 300, "Betreff", true); node.body = text(raw.body, 12000, "Nachricht", true);
      if (!options.allowLegacyVariables) {
        const variableIssues = automationMessageVariableIssues(node.subject, node.body);
        if (variableIssues.length) fail(variableIssues.join(" "));
        if (node.type !== "request" && (node.subject + node.body).includes("{{request.url}}")) fail("Ein sicherer Formularlink benötigt einen Datenanforderungsschritt.");
      }
      if (node.type === "request") {
        if (!["contact_details", "search_profile", "purchasing_power"].includes(String(raw.request))) fail("Datenanforderung ist ungültig.");
        node.request = raw.request as AutomationNode["request"];
        if(raw.language!==undefined&&!["de","en","es"].includes(String(raw.language)))fail("Formularsprache ist ungültig.");
        node.language=(raw.language??"de") as AutomationNode["language"];
      }
    }
    if (node.type === "phase") {
      if (!(automationPhases as readonly unknown[]).includes(raw.value)) fail("Leadphase ist ungültig.");
      node.value = raw.value as string;
    }
    return node;
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (byId.size !== nodes.length || nodes.filter((n) => n.type === "start").length !== 1 || !nodes.some((n) => n.type === "stop")) fail("Genau ein Start, mindestens ein Ende und eindeutige Schritt-IDs sind erforderlich.");
  const edges = (value.edges as unknown[]).map((raw): AutomationEdge => {
    if (!plain(raw) || !byId.has(String(raw.from)) || !byId.has(String(raw.to)) || !["next", "yes", "no"].includes(String(raw.port))) return fail("Verbindung verweist auf einen ungültigen Schritt.");
    if (byId.get(String(raw.to))?.type === "start") fail("Verbindung zum Start ist nicht erlaubt.");
    return { from: String(raw.from), to: String(raw.to), port: raw.port as AutomationEdge["port"] };
  });
  for (const node of nodes) {
    const outgoing = edges.filter((e) => e.from === node.id);
    const ports = node.type === "stop" ? [] : node.type === "condition" ? ["yes", "no"] : ["next"];
    if (outgoing.length !== ports.length || ports.some((p) => outgoing.filter((e) => e.port === p).length !== 1)) fail(`${node.title}: Verbindungen sind unvollständig oder doppelt.`);
  }
  const visited = new Set<string>(), stack = new Set<string>();
  function visit(id: string) {
    if (stack.has(id)) fail("Kreisverbindungen sind nicht erlaubt.");
    if (visited.has(id)) return;
    visited.add(id); stack.add(id); edges.filter((e) => e.from === id).forEach((e) => visit(e.to)); stack.delete(id);
  }
  visit(nodes.find((n) => n.type === "start")!.id);
  if (visited.size !== nodes.length) fail("Alle Schritte müssen vom Start erreichbar sein.");
  return { schemaVersion: 1, trigger: value.trigger as AutomationTrigger, timezone, businessHours: value.businessHours as boolean, stopOnPersonalContact: value.stopOnPersonalContact as boolean, nodes, edges };
}

export function evaluateAutomationCondition(node: AutomationNode, facts: AutomationFacts): boolean | null {
  switch (node.condition) {
    case "missing_phone": return !facts.phone;
    case "missing_address": return facts.address === undefined ? null : !facts.address;
    case "has_phone": return !!facts.phone;
    case "expose_opened": return facts.exposeOpened;
    case "lead_replied": return facts.replied;
    case "appointment_booked": return facts.booked;
    case "proof_accepted": return facts.proofAccepted;
    case "search_profile_exists": return facts.searchProfileExists;
    case "match_at_least": return facts.matchScore === null ? null : facts.matchScore >= Number(node.value);
    case "inquiry_contains": return node.value!.split(",").map((v) => v.trim().toLocaleLowerCase()).filter(Boolean).some((v) => facts.inquiry.toLocaleLowerCase().includes(v));
    case "is_phase": return facts.phase === node.value;
    default: return null;
  }
}
export function nextAutomationNode(graph: AutomationGraph, id: string, port: AutomationEdge["port"] = "next") {
  return graph.edges.find((edge) => edge.from === id && edge.port === port)?.to ?? null;
}
export function automationStopReason(graph: AutomationGraph, facts: AutomationFacts): string | null {
  if (facts.optedOut) return "opt_out";
  if (graph.stopOnPersonalContact && (facts.personalContact || facts.replied === true)) return "personal_contact";
  return null;
}
/** Weekdays 08:00–19:00 in the stored project timezone. No holiday-calendar claim. */
export function nextAutomationBusinessTime(value: Date, graph: Pick<AutomationGraph, "businessHours" | "timezone">): Date {
  if (!Number.isFinite(value.getTime())) fail("Zeitpunkt ist ungültig.");
  if (!graph.businessHours) return new Date(value);
  const format = new Intl.DateTimeFormat("en-GB", { timeZone: graph.timezone, weekday: "short", hour: "2-digit", hourCycle: "h23" });
  let candidate = new Date(value);
  for (let tries = 0; tries < 192; tries++) {
    const parts = format.formatToParts(candidate), weekday = parts.find((p) => p.type === "weekday")!.value, hour = Number(parts.find((p) => p.type === "hour")!.value);
    if (!["Sat", "Sun"].includes(weekday) && hour >= 8 && hour < 19) return candidate;
    candidate = new Date(Math.floor(candidate.getTime() / 3600000) * 3600000 + 3600000);
  }
  return fail("Nächstes Geschäftszeitfenster nicht ermittelbar.");
}
export function createAutomationGraph(): AutomationGraph {
  return { schemaVersion: 1, trigger: "new_lead", timezone: "Europe/Vienna", businessHours: true, stopOnPersonalContact: true,
    nodes: [{ id: "start", type: "start", title: "Neue Anfrage" }, { id: "task", type: "task", title: "Anfrage persönlich beantworten", dueDays: 0 }, { id: "end", type: "stop", title: "Ende" }],
    edges: [{ from: "start", to: "task", port: "next" }, { from: "task", to: "end", port: "next" }] };
}

export function previewAutomation(graphInput: unknown, facts: AutomationFacts, now = new Date()) {
  const graph = validateAutomationGraph(graphInput), stop = automationStopReason(graph, facts);
  const steps: { nodeId: string; title: string; result: string; at: string }[] = [];
  if (stop) return { stopped: stop, steps };
  let id: string | null = graph.nodes.find((n) => n.type === "start")!.id, at = new Date(now);
  for (let i = 0; id && i < 100; i++) {
    const node = graph.nodes.find((n) => n.id === id)!;
    let port: AutomationEdge["port"] = "next", result = "Weiter";
    if (node.type === "condition") {
      const decision = evaluateAutomationCondition(node, facts);
      result = decision === null ? "Signal unbekannt – wartet" : decision ? "Ja" : "Nein";
      if (decision === null) { steps.push({ nodeId: id, title: node.title, result, at: at.toISOString() }); break; }
      port = decision ? "yes" : "no";
    } else if (node.type === "wait") { at = nextAutomationBusinessTime(new Date(at.getTime() + node.hours! * 3600000), graph); result = "Wartefrist";
    } else if (["task", "phase", "email_draft", "request"].includes(node.type)) {
      at = nextAutomationBusinessTime(at, graph);
      result = node.type === "task" ? "Aufgabe anlegen" : node.type === "phase" ? `Phase ${node.value} (Fachprüfung im echten Lauf)` : "Nachricht als Entwurf zur Prüfung; Lauf hält an";
    } else if (node.type === "stop") result = "Abgeschlossen";
    steps.push({ nodeId: id, title: node.title, result, at: at.toISOString() });
    if (["stop", "email_draft", "request"].includes(node.type)) break;
    id = nextAutomationNode(graph, id, port);
  }
  return { stopped: null, steps };
}
