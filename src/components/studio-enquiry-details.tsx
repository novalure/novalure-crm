"use client";
import { useEffect, useState } from "react";
import type { StudioEnquiryAnalysisView, StudioEnquiryView } from "@/lib/studio-enquiry-view";

function Analysis({ value }: { value: StudioEnquiryAnalysisView }) {
  return <div className="mt-2 grid gap-2 text-sm text-stone-700">
    <p className="font-medium">{value.status === "partial" ? "Partial analysis" : "Visible content read"}</p>
    <p className="whitespace-pre-wrap break-words">{value.summary}</p>
    {value.limitations.length > 0 && <ul className="list-disc pl-5">{value.limitations.map((note,i)=><li key={i} className="break-words">{note}</li>)}</ul>}
    <details><summary className="cursor-pointer">Extracted source text</summary><p className="mt-2 whitespace-pre-wrap break-words">{value.extractedText || "No extracted text was recorded."}</p></details>
  </div>;
}
export function StudioEnquiryContent({ enquiry }: { enquiry: StudioEnquiryView }) {
  return <div className="mt-3 grid gap-4 text-sm">
    <p className="whitespace-pre-wrap break-words">{enquiry.summary}</p>
    <p className="text-xs text-stone-600">Confirmed {enquiry.confirmedAt} · Revision {enquiry.revision}</p>
    {enquiry.openQuestions.length>0&&<div><h6 className="font-semibold">Still open</h6><ul className="mt-1 list-disc pl-5">{enquiry.openQuestions.map((question,i)=><li className="break-words" key={i}>{question}</li>)}</ul></div>}
    {enquiry.files.map(file=><article className="rounded-md bg-white p-3" key={file.id}>
      <h6 className="break-words font-semibold">{file.name}</h6>
      <p className="mt-2 flex flex-wrap gap-3"><a className="underline" href={"/api/media/files/"+file.originalAssetId} target="_blank" rel="noopener noreferrer">{file.originalAssetId===file.analysisAssetId?"Original file · also used for analysis":"Original file"}</a>
        {file.originalAssetId!==file.analysisAssetId&&<a className="underline" href={"/api/media/files/"+file.analysisAssetId} target="_blank" rel="noopener noreferrer">Analysis copy</a>}</p>
      <Analysis value={file.analysis}/>
    </article>)}
    {enquiry.websites.map(site=><article className="rounded-md bg-white p-3" key={site.id}>
      <h6 className="break-words font-semibold">{site.domain}</h6>
      <ul className="mt-2 grid gap-1">{site.sources.map(url=><li className="break-all" key={url}><a className="underline" href={url} target="_blank" rel="noopener noreferrer">{url}</a></li>)}</ul>
      <Analysis value={site}/>
    </article>)}
    <p className="text-xs text-stone-600">Customer-provided material. Source notes describe the limits of the analysis.</p>
  </div>;
}
export function StudioEnquiryDetails({ leadId }: { leadId: string }) {
  const [loaded,setLoaded]=useState<{leadId:string;enquiry?:StudioEnquiryView;failed?:boolean}>({leadId:""});
  useEffect(()=>{
    const controller=new AbortController();
    void fetch("/api/crm/leads?id="+encodeURIComponent(leadId),{cache:"no-store",signal:controller.signal})
      .then(async response=>{if(!response.ok)throw new Error();return response.json();})
      .then(data=>{if(!controller.signal.aborted)setLoaded({leadId,enquiry:data.enquiry,failed:!data.enquiry});})
      .catch(()=>{if(!controller.signal.aborted)setLoaded({leadId,failed:true});});
    return()=>controller.abort();
  },[leadId]);
  const current=loaded.leadId===leadId?loaded:undefined;
  return <section aria-label="Confirmed Studio enquiry" className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
    <h5 className="text-sm font-semibold">Confirmed Studio enquiry</h5>
    {!current ? <p className="mt-2 text-sm" role="status">Loading confirmed details…</p> : current.failed || !current.enquiry ?
      <p className="mt-2 text-sm" role="status">Confirmed enquiry details could not be read. Reload to try again.</p> : <StudioEnquiryContent enquiry={current.enquiry}/>}
  </section>;
}
