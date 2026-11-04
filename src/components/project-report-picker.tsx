"use client";
import { useState } from "react";
import type { Project } from "@/lib/crm-types";
import { ProjectSalesReport } from "@/components/project-sales-report";

export function ProjectReportPicker({workspaceId,activeProjectId,projects,language}:{workspaceId:string;activeProjectId:string|null;projects:Project[];language:"de"|"en"}){
  const [chosen,setChosen]=useState("");
  const allowed=projects.filter(project=>project.workspaceId===workspaceId);
  const selected=allowed.find(project=>project.id===(activeProjectId||chosen))?.id;
  return <section className="mt-5 space-y-4"><label className="grid max-w-md gap-2 text-sm font-semibold">{language==="de"?"Projektbericht":"Project report"}<select className="min-h-11 rounded-lg border border-stone-300 bg-white px-3 py-2" value={selected||""} onChange={event=>setChosen(event.target.value)} disabled={Boolean(activeProjectId)}><option value="">{language==="de"?"Projekt wählen":"Select a project"}</option>{allowed.map(project=><option value={project.id} key={project.id}>{project.name}</option>)}</select></label>{selected?<ProjectSalesReport workspaceId={workspaceId} projectId={selected} language={language}/>:<p className="text-sm text-stone-500">{language==="de"?"Wähle ein Projekt für Bestands-, Vertriebs- und Zielkennzahlen.":"Choose a project for inventory, sales and target figures."}</p>}</section>;
}
