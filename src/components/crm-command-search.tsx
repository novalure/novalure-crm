"use client";

import { useState } from "react";
import { Button, Dialog, Icon, Input } from "../../design-c/components/ui";
import type { Contact, Lead, Project } from "@/lib/crm-types";
import type { LanguageCode } from "@/lib/i18n";

export function CrmCommandSearch({ language, entries, contacts, leads, projects, onNavigate }: {
  language: LanguageCode;
  entries: { id: string; label: string; section: string }[];
  contacts: readonly Contact[];
  leads: readonly Lead[];
  projects: readonly Project[];
  onNavigate: (entryId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const label = language === "de" ? "CRM durchsuchen" : "Search CRM";
  const allowed = new Set(entries.map(entry => entry.section));
  const records = [
    ...entries.map(entry => ({ key: `nav-${entry.id}`, label: entry.label, entryId: entry.id })),
    ...(allowed.has("contacts") ? contacts.map(item => ({ key: `contact-${item.id}`, label: item.name, entryId: entries.find(entry => entry.section === "contacts")!.id })) : []),
    ...(allowed.has("leadInbox") ? leads.map(item => ({ key: `lead-${item.id}`, label: [item.intent, item.source].filter(Boolean).join(" · "), entryId: entries.find(entry => entry.section === "leadInbox")!.id })) : []),
    ...(allowed.has("projects") ? projects.map(item => ({ key: `project-${item.id}`, label: item.name, entryId: entries.find(entry => entry.section === "projects")!.id })) : []),
  ];
  const needle = query.trim().toLocaleLowerCase(language);
  const results = records.filter(item => !needle || item.label.toLocaleLowerCase(language).includes(needle)).slice(0, 12);
  return <>
    <Button variant="secondary" onClick={() => { setQuery(""); setOpen(true); }} aria-label={label} data-crm-search-trigger><Icon name="search" size={17} />{label}</Button>
    <Dialog open={open} title={label} closeLabel={language === "de" ? "Dialog schließen" : "Close dialog"} onClose={() => setOpen(false)}>
      <p className="dc-muted">{language === "de" ? "Suche in Ihren verfügbaren Bereichen und bereits geladenen Datensätzen. Ergebnisse öffnen den zuständigen Bereich." : "Search available sections and loaded records. Results open the relevant section."}</p>
      <label htmlFor="crm-command-query" className="dc-sr-only">{label}</label>
      <Input id="crm-command-query" type="search" value={query} onChange={event => setQuery(event.target.value)} autoComplete="off" />
      <div className="dc-stack" data-crm-search-results aria-live="polite">{results.length ? results.map(item => <Button key={item.key} variant="ghost" onClick={() => { setOpen(false); onNavigate(item.entryId); }}><span>{item.label}</span><Icon name="arrow" size={16} /></Button>) : <p>{language === "de" ? "Keine passenden Ergebnisse im geladenen Bereich." : "No matching results in the loaded scope."}</p>}</div>
    </Dialog>
  </>;
}
