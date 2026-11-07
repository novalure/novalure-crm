"use client";
import { useEffect, useRef, type ComponentProps } from "react";
import { LeadInbox } from "@/components/lead-inbox";

type Props = ComponentProps<typeof LeadInbox> & { leadId: string; onClose: () => void };
/** A modal over the current board: closing never navigates or resets its filters. */
export function LeadDetailDrawer({ leadId, onClose, ...props }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const lead = props.leads.find(item => item.id === leadId && item.workspaceId === props.workspaceId);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    return () => { element.close(); };
  }, []);
  if (!lead) return null;
  const label = props.contacts.find(contact => contact.id === lead.contactId)?.name || (props.language === "de" ? "Interessent" : "Lead");
  return <dialog ref={dialog} aria-labelledby="shared-lead-drawer-title" onCancel={event => { event.preventDefault(); onClose(); }}
    className="fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-dvh w-full max-w-3xl overflow-y-auto border-l border-stone-200 bg-stone-50 p-0 text-slate-900 shadow-2xl backdrop:bg-slate-950/40">
    <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-stone-200 bg-white px-5 py-4"><div><p className="text-xs font-semibold uppercase tracking-wider text-stone-500">{props.language === "de" ? "Leadakte" : "Lead details"}</p><h2 className="mt-1 text-xl font-semibold" id="shared-lead-drawer-title">{label}</h2></div><button autoFocus className="min-h-11 rounded-md border border-stone-300 px-4 py-2 text-sm font-semibold" type="button" onClick={onClose}>{props.language === "de" ? "Schließen" : "Close"}</button></header>
    <div className="p-4"><LeadInbox {...props} leads={[lead]} activeProjectId={lead.projectId || null} detailsOnly showPropertySalesWorkflow={false} /></div>
  </dialog>;
}
