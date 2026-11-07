"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { PartnerCooperationWorkspace } from "@/components/partner-cooperation-workspace";
import { csrfFetch } from "@/lib/security/csrf-client";

export function PartnerPortal({workspaceId,workspaceName,userName,language}:{workspaceId:string;workspaceName:string;userName:string;language:string}){
  const router=useRouter();
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState("");
  async function logout(){
    setBusy(true);setNotice("");
    try{const response=await csrfFetch("/api/auth/logout",{method:"POST"});if(!response.ok)throw new Error();router.replace("/login");router.refresh();}
    catch{setNotice(language==="de"?"Abmeldung nicht bestätigt. Bitte erneut versuchen.":"Sign-out not confirmed. Please try again.");setBusy(false);}
  }
  return <main className="min-h-screen bg-stone-50 text-slate-950"><header className="border-b border-stone-200 bg-white px-6 py-5"><div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-widest text-stone-500">{language==="de"?"Partnerbereich":"Partner area"} · {workspaceName}</p><h1 className="mt-1 text-xl font-semibold">{language==="de"?"Freigegebene Zusammenarbeit":"Shared collaboration"}</h1><p className="mt-1 text-sm text-stone-600">{userName}</p></div><button className="rounded-full border border-stone-300 px-5 py-3 text-sm font-semibold disabled:opacity-50" type="button" disabled={busy} onClick={()=>void logout()}>{language==="de"?"Abmelden":"Sign out"}</button></div>{notice?<p role="status" className="mx-auto mt-3 max-w-6xl text-sm">{notice}</p>:null}</header><div className="mx-auto max-w-6xl px-5 py-8"><PartnerCooperationWorkspace workspaceId={workspaceId} language={language}/></div></main>;
}
