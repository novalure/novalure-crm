'use client';

import {useEffect,useRef,useState} from 'react';
import {csrfFetch} from '@/lib/security/csrf-client';
import {automationMailPurposeLabels,automationMailPurposes,type AutomationMailPreview,type AutomationMailPurpose} from '@/lib/automation/mail';
const button='min-h-11 rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-slate-900 disabled:cursor-not-allowed disabled:opacity-50';
const labels:Record<string,string>={deferred:'Vor Anbieteraufruf zurückgestellt · nicht gesendet',claimed:'Ergebnis noch ungeklärt – beim Versanddienst abgleichen',uncertain:'Annahme ungeklärt – wird nicht automatisch wiederholt',accepted:'Vom Versanddienst angenommen – Zustellung noch nicht bestätigt',failed:'Vom Versanddienst abgelehnt',suppressed:'Vor dem Versand durch aktuelle Prüfung gestoppt'};
const providerLabels:Record<string,string>={sent:'Signiertes Anbieterereignis: Versand bestätigt.',delivered:'Signiertes Anbieterereignis: Vom Empfänger-Mailserver angenommen. Kein Lesebeleg.',delayed:'Signiertes Anbieterereignis: Zustellung verzögert.',bounced:'Signiertes Anbieterereignis: Zustellung zurückgewiesen.',complained:'Signiertes Anbieterereignis: Spam-Beschwerde erhalten.',failed:'Signiertes Anbieterereignis: Versandfehler.',suppressed:'Signiertes Anbieterereignis: Versand vom Anbieter gesperrt.'};
type Props={workspaceId:string;draftId:string;onChanged?:()=>void|Promise<void>};
export function AutomationMailActions(props:Props){return <ScopedAutomationMailActions key={props.workspaceId+':'+props.draftId} {...props}/>;}
function ScopedAutomationMailActions({workspaceId,draftId,onChanged}:Props){
 const[open,setOpen]=useState(false),[purpose,setPurpose]=useState<AutomationMailPurpose>('salesFollowUp'),[preview,setPreview]=useState<AutomationMailPreview|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[approved,setApproved]=useState(false),[recover,setRecover]=useState(false),[nonce,setNonce]=useState(0);
 const pending=useRef<string|null>(null);
 useEffect(()=>{
  if(!open)return;const controller=new AbortController();let active=true;
  const query=new URLSearchParams({workspaceId,draftId,purpose});
  void fetch('/api/crm/automations/mail?'+query,{signal:controller.signal,cache:'no-store'}).then(async response=>{const body=await response.json();if(!response.ok)throw new Error(body.error?.message||body.error||'Die aktuelle Versandvorschau konnte nicht geladen werden.');if(active)setPreview(body);}).catch(err=>{if(active&&!controller.signal.aborted)setError(err instanceof Error?err.message:'Die Vorschau konnte nicht geladen werden.');});
  return()=>{active=false;controller.abort();};
 },[workspaceId,draftId,purpose,open,nonce]);
 async function send(){
  if(busy||(!pending.current&&(!preview?.canSend||!approved)))return;
  if(!pending.current)pending.current=JSON.stringify({draftId,purpose,approvalDigest:preview!.approvalDigest,approved:true,idempotencyKey:crypto.randomUUID(),correlationId:crypto.randomUUID()});
  setBusy(true);setError('');
  try{
   const response=await csrfFetch('/api/crm/automations/mail?'+new URLSearchParams({workspaceId}),{method:'POST',headers:{'Content-Type':'application/json'},body:pending.current});
   const body=await response.json();
   if(!response.ok){if(response.status<500){pending.current=null;setRecover(false);setApproved(false);}else setRecover(true);throw new Error(body.error?.message||body.error||'Das Versandergebnis konnte nicht bestätigt werden.');}
   pending.current=null;setRecover(false);setApproved(false);setPreview(null);setNonce(value=>value+1);await onChanged?.();
  }catch(err){if(pending.current)setRecover(true);setError(err instanceof Error?err.message:'Das Versandergebnis ist ungeklärt.');}finally{setBusy(false);}
 }
 return <div className="mt-4 border-t border-stone-200 pt-4">
  <button className={button} disabled={busy} onClick={()=>{if(!open){setPreview(null);setError('');setApproved(false);}setOpen(value=>!value);}} aria-expanded={open}>{open?'Versandvorschau schließen':'E-Mail prüfen und gezielt senden'}</button>
  {open&&<div className="mt-4 space-y-4 rounded-xl bg-stone-50 p-4">
   <p className="text-xs text-stone-600">Eine anfragebezogene Nachricht an genau einen aktuellen Kontakt. Der Versand startet erst nach Ihrer ausdrücklichen Freigabe.</p>
   <label className="block text-sm font-medium">Konkreter Zweck<select className="mt-1 min-h-11 w-full rounded-lg border border-stone-300 bg-white p-2" value={purpose} disabled={busy||recover||!!preview?.delivery} onChange={event=>{setPreview(null);setError('');setApproved(false);setPurpose(event.target.value as AutomationMailPurpose);}}>{automationMailPurposes.map(value=><option key={value} value={value}>{automationMailPurposeLabels[value]}</option>)}</select></label>
   {error&&<p role="alert" className="text-sm text-rose-800">{error}</p>}
   {!preview&&!error&&<p role="status" className="text-sm">Aktuelle Adresse, Einwilligung und Flow werden geprüft …</p>}
   {preview&&<>
    <dl className="grid gap-2 text-sm"><div><dt className="text-xs text-stone-500">An</dt><dd className="break-words">{preview.contactName} · {preview.to||'Keine gültige Adresse'}</dd></div><div><dt className="text-xs text-stone-500">Von</dt><dd className="break-words">{preview.from}</dd></div><div><dt className="text-xs text-stone-500">Betreff</dt><dd className="font-medium">{preview.subject}</dd></div></dl>
    <p className="whitespace-pre-wrap break-words rounded-lg bg-white p-3 text-sm">{preview.body}</p>
    {preview.delivery?<div role="status" className="rounded-lg border border-stone-300 bg-white p-3 text-sm"><p className="font-medium">{preview.delivery.providerStatus?providerLabels[preview.delivery.providerStatus]:labels[preview.delivery.status]??preview.delivery.status}</p>{preview.delivery.providerStatus&&['claimed','uncertain'].includes(preview.delivery.status)&&<p className="mt-1 text-xs">Der ursprüngliche Versandauftrag bleibt für den Abgleich gesperrt. Dieses bestätigte Anbieterereignis löst keinen weiteren Versand aus.</p>}{preview.delivery.error&&<p className="mt-1">{preview.delivery.error.replace('CONTACT_POLICY_DEFERRED:', 'Erneut persönlich prüfen ab: ')}</p>}</div>:null}
    {(!preview.delivery||preview.delivery.status==='deferred')&&<>
     {!!preview.issues.length&&<ul className="space-y-1 text-sm text-amber-900">{preview.issues.map(issue=><li key={issue}>{issue}</li>)}</ul>}
     <label className="flex min-h-11 items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={approved} disabled={!preview.canSend||busy||recover} onChange={event=>setApproved(event.target.checked)}/>Ich habe Empfänger, Inhalt und Zweck geprüft und gebe diese einzelne Nachricht frei. Sie gehört zur konkreten Anfrage oder zum vereinbarten Termin.</label>
     <button className={button+' bg-slate-900 text-white'} disabled={busy||(!recover&&(!approved||!preview.canSend))} onClick={()=>{void send();}}>{busy?'Versandergebnis wird geprüft …':recover?'Ursprünglichen Versandauftrag erneut prüfen':'Diese Nachricht jetzt senden'}</button>
    </>}
   </>}
   {!busy&&!recover&&<button className={button} onClick={()=>{setPreview(null);setError('');setApproved(false);setNonce(value=>value+1);}}>Aktuellen Stand neu laden</button>}
   {recover&&<p className="text-xs text-amber-900">Die Antwort fehlt. Derselbe Auftrag wird beim erneuten Prüfen nicht noch einmal versandt. Ein ungeklärter Beleg benötigt einen Abgleich mit dem Versanddienst.</p>}
  </div>}
 </div>;
}
