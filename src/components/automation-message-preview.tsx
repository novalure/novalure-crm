"use client";
import { useState } from "react";
import type { AutomationGraph } from "@/lib/automation/graph";
import { automationMailText } from "@/lib/automation/mail";
import { automationMessageVariableIssues, type AutomationMessageValues } from "@/lib/automation/message-variables";
export function AutomationMessagePreview({ graph }: { graph: AutomationGraph }) {
  const [values, setValues] = useState<AutomationMessageValues>({ contactName: "Alex Beispiel", projectName: "Beispielprojekt", agentName: "Ihr Ansprechpartner", requestUrl: "https://example.invalid/formular" });
  const nodes = graph.nodes.filter(node => node.type === "email_draft" || node.type === "request");
  if (!nodes.length) return null;
  return <details className="rounded-2xl border border-stone-200 bg-white p-5"><summary className="min-h-11 cursor-pointer font-semibold">Nachrichten & Pflichtvariablen prüfen</summary><p className="mb-4 text-sm leading-6 text-stone-600">Beispielvorschau ohne Versand. Im tatsächlichen Vorgang werden die aktuellen Originaldaten und der gültige Formularlink erneut geprüft. Fehlende Pflichtwerte blockieren den Versand.</p><div className="grid gap-3 md:grid-cols-3">{([["contactName", "Kontaktname"], ["projectName", "Projektname"], ["agentName", "Ansprechpartner"]] as const).map(([key, label]) => <label key={key} className="grid gap-1 text-sm">{label}<input className="min-h-11 rounded-lg border border-stone-300 px-3" value={values[key]} onChange={event => setValues({ ...values, [key]: event.target.value })} /></label>)}</div><p className="mt-3 text-xs text-stone-500">{"Verfügbare Variablen: {{contact.name}}, {{project.name}}, {{agent.name}}. Im Datenanforderungsschritt zusätzlich {{request.url}}."}</p><div className="mt-4 grid gap-4">{nodes.map(node => {
    const actual = { ...values, requestUrl: node.type === "request" ? values.requestUrl : undefined };
    const issues = automationMessageVariableIssues(node.subject ?? "", node.body ?? "", actual);
    return <article key={node.id} className="rounded-xl border border-stone-200 p-4"><p className="text-xs font-semibold text-stone-500">{node.title}</p><h4 className="mt-2 font-semibold">{automationMailText(node.subject ?? "", actual)}</h4><p className="mt-3 whitespace-pre-wrap text-sm leading-6">{automationMailText(node.body ?? "", actual)}</p>{issues.length ? <ul className="mt-3 list-inside list-disc text-sm text-amber-800">{issues.map(issue => <li key={issue}>{issue}</li>)}</ul> : <p className="mt-3 text-xs text-emerald-800">Pflichtwerte in dieser Beispielvorschau vollständig.</p>}</article>;
  })}</div></details>;
}
