"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { csrfFetch } from "@/lib/security/csrf-client";
import type { PropertySalesAction } from "@/lib/property-sales";
type RecordRow={id:string;name?:string;unit_number?:string;version?:number|string;status?:string;user_id?:string;unit_id?:string;lead_id?:string;buyer_lead_id?:string;organization_id?:string;contact_id?:string;starts_at?:string;ends_at?:string;time_zone?:string;[key:string]:unknown};
type Snapshot={project:RecordRow;units:RecordRow[];leads:RecordRow[];users:RecordRow[];organizations:RecordRow[];contacts:RecordRow[];authorities:RecordRow[];handovers:RecordRow[];viewings:RecordRow[];reservations:RecordRow[];sales:RecordRow[]};
const actions:{value:PropertySalesAction;label:string}[]=[
 {value:"qualification.save",label:"Käufer qualifizieren"},
 {value:"handover.create",label:"Qualifizierten Käufer übergeben"},
 {value:"viewing.save",label:"Besichtigung planen / dokumentieren"},
 {value:"reservation.request",label:"Reservierung anfragen"},
 {value:"reservation.confirm",label:"Reservierung verbindlich bestätigen"},
 {value:"reservation.extend",label:"Bestätigte Reservierung verlängern"},
 {value:"reservation.expire",label:"Abgelaufene Reservierung freigeben"},
 {value:"sale.confirm",label:"Verkauf bestätigen"},
 {value:"unit.price.confirm",label:"Bestätigten Verkaufspreis übernehmen"},
 {value:"authority.assign",label:"Bauträger und Projektbefugnisse verwalten"}];
const inputClass="min-h-11 w-full min-w-0 rounded-md border border-stone-300 bg-white p-2 text-sm";
function Picker({label,value,onChange,items,empty="Bitte wählen"}:{label:string;value:string;onChange:(id:string)=>void;items:RecordRow[];empty?:string}){
 return <label className="grid min-w-0 gap-1 text-sm">{label}<select aria-label={label} className={inputClass} value={value} onChange={event=>onChange(event.target.value)}><option value="">{empty}</option>{items.map(item=><option key={item.id} value={item.id}>{item.name??item.unit_number??item.id}{item.status?" · "+item.status:""}</option>)}</select></label>
}
type OpenSalesDetail={projectId:string;unitId?:string;leadId?:string;reservationId?:string;action:PropertySalesAction};
export function openPropertySalesWorkflow(detail:OpenSalesDetail){
 window.dispatchEvent(new CustomEvent("property-sales-open",{detail}));
 document.getElementById("property-sales-workflow")?.scrollIntoView({behavior:"smooth",block:"start"});
}
export function PropertySalesWorkflow({projects,workspaceId,initialProjectId,onChanged}:{projects:{id:string;name:string}[];workspaceId:string;initialProjectId?:string|null;onChanged?:()=>Promise<boolean|void>|boolean|void}){
 const endpoint="/api/crm/property-sales?workspaceId="+encodeURIComponent(workspaceId);
 const [projectId,setProjectId]=useState(initialProjectId??"");
 const [data,setData]=useState<Snapshot|null>(null);
 const [action,setAction]=useState<PropertySalesAction>("qualification.save");
 const [fields,setFields]=useState<Record<string,string>>({priority:"medium",financingStatus:"offen",useCase:"Eigennutzung",status:"planned"});
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(""),[failed,setFailed]=useState(false);
 const pending=useRef<{digest:string;key:string;correlationId:string}|null>(null);
 useEffect(()=>{
  const listener=(event:Event)=>{
   const detail=(event as CustomEvent<OpenSalesDetail>).detail;
   if(!detail || !projects.some(project=>project.id===detail.projectId))return;
   setProjectId(detail.projectId);setAction(detail.action);setBusy(true);setMessage("");
   setFields(current=>({...current,unitId:detail.unitId??"",leadId:detail.leadId??"",reservationId:detail.reservationId??"",viewingId:"",status:"planned"}));
   void (async()=>{try{
    const response=await csrfFetch(endpoint+"&projectId="+encodeURIComponent(detail.projectId));
    const result=await response.json();if(!response.ok)throw new Error(result.error??"Laden fehlgeschlagen");
    setData(result.data as Snapshot);setFailed(false);
   }catch(error){setFailed(true);setMessage(error instanceof Error?error.message:"Laden fehlgeschlagen")}finally{setBusy(false)}})();
  };
  window.addEventListener("property-sales-open",listener);
  return ()=>window.removeEventListener("property-sales-open",listener);
 },[projects,endpoint]);
 const field=(key:string,value:string)=>setFields(current=>({...current,[key]:value}));
 const read=async()=>{
  const response=await csrfFetch(endpoint+"&projectId="+encodeURIComponent(projectId));
  const result=await response.json();
  if(!response.ok)throw new Error(result.error??"Projekt konnte nicht geladen werden.");
  setData(result.data as Snapshot);
 };
 const load=async()=>{setBusy(true);setMessage("");try{await read();setFailed(false)}catch(error){setData(null);setFailed(true);setMessage(error instanceof Error?error.message:"Laden fehlgeschlagen")}finally{setBusy(false)}};
 const selectedLead=data?.leads.find(row=>row.id===fields.leadId);
 const selectedUnit=data?.units.find(row=>row.id===fields.unitId);
 const reservation=data?.reservations.find(row=>row.id===fields.reservationId);
 const reservationUnit=data?.units.find(row=>row.id===reservation?.unit_id);
 const viewing=data?.viewings.find(row=>row.id===fields.viewingId);
 const authority=data?.authorities.find(row=>row.user_id===fields.userId);
 const isReservation=["reservation.confirm","reservation.extend","reservation.expire","sale.confirm"].includes(action);
 const textField=(key:string,label:string,type="text",required=true)=><label key={key} className="grid min-w-0 gap-1 text-sm">{label}<input required={required} className={inputClass} type={type} value={fields[key]??""} onChange={event=>field(key,event.target.value)} step={type==="number"?"0.01":undefined}/></label>;
 const chooseLead=(id:string)=>{
  const lead=data?.leads.find(row=>row.id===id),profile=(lead?.buyer_profile??{}) as Record<string,unknown>,qualification=(lead?.sales_qualification??{}) as Record<string,unknown>;
  setFields(current=>({...current,leadId:id,budgetFrom:String(profile.budgetFrom??""),budgetTo:String(profile.budgetTo??""),financingStatus:String(profile.financingStatus??"offen"),purchaseTimeline:String(profile.purchaseTimeline??""),useCase:String(profile.useCase??"Eigennutzung"),priority:String(qualification.priority??"medium"),unitId:String(qualification.desiredUnitId??current.unitId??"")}));
 };
 const submit=async(event:FormEvent)=>{
  event.preventDefault();if(!data||busy)return;
  setBusy(true);setMessage("");setFailed(false);
  try{
   const p:Record<string,unknown>={};
   let expectedVersion:number|undefined;
   const sourceReference=(fields.sourceReference??"").trim();
   if(action==="qualification.save"){Object.assign(p,{leadId:fields.leadId,desiredUnitId:fields.unitId,budgetFrom:Number(fields.budgetFrom),budgetTo:Number(fields.budgetTo),financingStatus:fields.financingStatus,purchaseTimeline:fields.purchaseTimeline,useCase:fields.useCase,priority:fields.priority,sourceReference});expectedVersion=Number(selectedLead?.version)}
   if(action==="handover.create"){Object.assign(p,{leadId:fields.leadId,recipientUserId:fields.userId,sourceReference});expectedVersion=Number(selectedLead?.version)}
   if(action==="viewing.save"){Object.assign(p,{unitId:fields.unitId,leadId:fields.leadId,ownerUserId:fields.userId,startsAt:new Date(fields.startsAt).toISOString(),endsAt:new Date(fields.endsAt).toISOString(),timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,status:fields.status});if(viewing){p.viewingId=viewing.id;expectedVersion=Number(viewing.version)}}
   if(action==="reservation.request"){Object.assign(p,{unitId:fields.unitId,leadId:fields.leadId,expiresAt:new Date(fields.expiresAt).toISOString()});expectedVersion=Number(selectedUnit?.version)}
   if(action==="reservation.extend")p.expiresAt=new Date(fields.expiresAt).toISOString();
   if(isReservation){Object.assign(p,{reservationId:fields.reservationId,unitVersion:Number(reservationUnit?.version),sourceReference});expectedVersion=Number(reservation?.version)}
   if(action==="unit.price.confirm"){Object.assign(p,{unitId:fields.unitId,priceCents:Math.round(Number(fields.price)*100),sourceReference});expectedVersion=Number(selectedUnit?.version)}
   if(action==="authority.assign"){Object.assign(p,{userId:fields.userId,developerOrganizationId:fields.organizationId,contactId:fields.contactId,canConfirmPrice:fields.canConfirmPrice==="yes",canConfirmReservation:fields.canConfirmReservation==="yes",canConfirmSale:fields.canConfirmSale==="yes",enabled:fields.enabled!=="no",sourceReference});if(authority)expectedVersion=Number(authority.version)}
   const body={action,projectId,payload:p,...(expectedVersion===undefined?{}:{expectedVersion})};
   const digest=JSON.stringify(body);
   if(pending.current?.digest!==digest)pending.current={digest,key:crypto.randomUUID(),correlationId:crypto.randomUUID()};
   const response=await csrfFetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...body,idempotencyKey:pending.current.key,correlationId:pending.current.correlationId})});
   const result=await response.json();
   if(!response.ok)throw new Error(result.error??"Aktion wurde abgelehnt.");
   pending.current=null;
   const refreshes=await Promise.allSettled([read(),Promise.resolve(onChanged?.())]);
   const stale=refreshes.some(refresh=>refresh.status==="rejected" || refresh.value===false);
   setFailed(stale);
   setMessage(stale?"Gespeichert. Ein Teil der Übersicht konnte nicht aktualisiert werden; bitte Prozess und CRM neu laden.":"Gespeichert. Der Verlauf und alle Statuswerte wurden aktualisiert.");
  }catch(error){setFailed(true);setMessage(error instanceof Error?error.message:"Speichern fehlgeschlagen.")}
  finally{setBusy(false)}
 };
 return <details id="property-sales-workflow" className="min-w-0 rounded-lg border border-emerald-200 bg-white p-4" open>
  <summary className="cursor-pointer text-lg font-semibold">Projektverkauf: Qualifizierung bis Abschluss</summary>
  <p className="my-3 text-sm text-stone-600">Reservierungsanfragen sind unverbindlich. Verbindliche Reservierungen, Verkauf und Preise erfordern eine dokumentierte Bestätigung durch einen ausdrücklich für dieses Projekt befugten Ansprechpartner.</p>
  <div className="grid min-w-0 gap-3 sm:grid-cols-[1fr_auto]">
   <Picker label="Projekt" value={projectId} onChange={id=>{setProjectId(id);setData(null);setFields({priority:"medium",financingStatus:"offen",useCase:"Eigennutzung",status:"planned"});pending.current=null}} items={projects}/>
   <button type="button" className="min-h-11 self-end rounded-md bg-emerald-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={!projectId||busy} onClick={load}>Prozess laden / aktualisieren</button>
  </div>
  {message&&<p className={"my-3 break-words rounded-md p-3 text-sm "+(failed?"bg-red-50 text-red-800":"bg-emerald-50 text-emerald-900")} role={failed?"alert":"status"}>{message}</p>}
  {data&&<form className="mt-4 grid min-w-0 gap-4" onSubmit={submit}>
   <label className="grid gap-1 text-sm">Nächster Schritt<select className={inputClass} value={action} onChange={event=>{setAction(event.target.value as PropertySalesAction);field("viewingId","");field("status","planned")}}>{actions.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
   <div className="grid min-w-0 gap-3 md:grid-cols-2">
    {["qualification.save","handover.create","viewing.save","reservation.request"].includes(action)&&<Picker label="Käuferanfrage" value={fields.leadId??""} onChange={chooseLead} items={data.leads}/>}
    {["qualification.save","viewing.save","reservation.request","unit.price.confirm"].includes(action)&&<Picker label="Einheit" value={fields.unitId??""} onChange={id=>field("unitId",id)} items={data.units}/>}
    {["handover.create","viewing.save","authority.assign"].includes(action)&&<Picker label={action==="handover.create"?"Empfänger der Übergabe":action==="authority.assign"?"Befugter Benutzer":"Verantwortlicher für Besichtigung"} value={fields.userId??""} onChange={id=>field("userId",id)} items={data.users}/>}
    {action==="qualification.save"&&<>
     {textField("budgetFrom","Budget ab EUR","number")}{textField("budgetTo","Budget bis EUR","number")}
     <Picker label="Finanzierungsstatus" value={fields.financingStatus} onChange={id=>field("financingStatus",id)} items={["offen","vorqualifiziert","Eigenmittel","Finanzierungszusage"].map(id=>({id,name:id}))}/>
     {textField("purchaseTimeline","Kaufzeitraum")}
     <Picker label="Nutzung" value={fields.useCase} onChange={id=>field("useCase",id)} items={["Eigennutzung","Anlage"].map(id=>({id,name:id}))}/>
     <Picker label="Priorität" value={fields.priority} onChange={id=>field("priority",id)} items={[{id:"high",name:"Hoch"},{id:"medium",name:"Mittel"},{id:"low",name:"Niedrig"}]}/>
     <p className="text-sm text-stone-600 md:col-span-2">Vollständigkeit wird beim Speichern aus Budget, Finanzierung, Kaufzeitraum, Nutzung, gewünschter Einheit und erreichbarem Kontakt geprüft.</p>
    </>}
    {action==="viewing.save"&&<>
     <Picker label="Vorhandene Besichtigung" value={fields.viewingId??""} empty="Neue Besichtigung" onChange={id=>{field("viewingId",id);const row=data.viewings.find(item=>item.id===id);if(row)setFields(current=>({...current,viewingId:id,leadId:String(row.lead_id),unitId:String(row.unit_id),userId:String(row.owner_user_id),startsAt:new Date(String(row.starts_at)).toLocaleString("sv-SE").replace(" ","T").slice(0,16),endsAt:new Date(String(row.ends_at)).toLocaleString("sv-SE").replace(" ","T").slice(0,16),status:String(row.status)}))}} items={data.viewings.map(row=>({...row,name:new Date(String(row.starts_at)).toLocaleString()}))}/>
     <Picker label="Besichtigungsstatus" value={fields.status} onChange={id=>field("status",id)} items={[{id:"planned",name:"Geplant"},{id:"confirmed",name:"Bestätigt"},{id:"completed",name:"Durchgeführt"},{id:"cancelled",name:"Abgesagt"},{id:"no_show",name:"Nicht erschienen"}]}/>
     {textField("startsAt","Beginn (lokale Browserzeit)","datetime-local")}{textField("endsAt","Ende (lokale Browserzeit)","datetime-local")}
     <p className="text-sm text-stone-600">Zeitzone: {Intl.DateTimeFormat().resolvedOptions().timeZone}</p>
    </>}
    {["reservation.request","reservation.extend"].includes(action)&&textField("expiresAt","Gewünschte Reservierungsfrist","datetime-local")}
    {isReservation&&<Picker label="Reservierung" value={fields.reservationId??""} onChange={id=>field("reservationId",id)} items={data.reservations.map(row=>({...row,name:(data.units.find(u=>u.id===row.unit_id)?.unit_number??"Einheit")+" · "+(data.leads.find(l=>l.id===row.buyer_lead_id)?.name??"Käufer")}))}/>}
    {action==="unit.price.confirm"&&textField("price","Bestätigter Verkaufspreis EUR","number")}
    {action==="authority.assign"&&<>
     <Picker label="Bauträger" value={fields.organizationId??""} onChange={id=>field("organizationId",id)} items={data.organizations}/>
     <Picker label="Autorisierter Ansprechpartner" value={fields.contactId??""} onChange={id=>field("contactId",id)} items={data.contacts.filter(row=>row.organization_id===fields.organizationId)}/>
     {(["canConfirmPrice","canConfirmReservation","canConfirmSale","enabled"] as const).map(key=><Picker key={key} label={{canConfirmPrice:"Preise bestätigen",canConfirmReservation:"Reservierungen bestätigen",canConfirmSale:"Verkäufe bestätigen",enabled:"Befugnis aktiv"}[key]} value={fields[key]??(key==="enabled"?"yes":"no")} onChange={id=>field(key,id)} items={[{id:"no",name:"Nein"},{id:"yes",name:"Ja"}]}/>)}
     <p className="text-sm text-stone-600 md:col-span-2">Nur die Projektverwaltung darf Befugnisse zuweisen. Die dokumentierte Beauftragung des Bauträgers ist erforderlich; eine technische Rolle allein genügt nicht.</p>
    </>}
    {!["viewing.save","reservation.request","reservation.expire"].includes(action)&&textField("sourceReference",action==="authority.assign"?"Beleg der Projektbeauftragung":"Quellbeleg / dokumentierte Bestätigung")}
   </div>
   <button disabled={busy} type="submit" className="min-h-11 rounded-md bg-emerald-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy?"Wird gespeichert…":actions.find(item=>item.value===action)?.label}</button>
   <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
    <p>Qualifiziert: {data.leads.filter(row=>(row.sales_qualification as Record<string,unknown>|undefined)?.complete).length}</p><p>Übergaben: {data.handovers.length}</p><p>Reservierungsanfragen: {data.reservations.filter(row=>row.status==="requested").length}</p><p>Bestätigte Verkäufe: {data.sales.length}</p>
   </div>
   <ul className="grid gap-2 text-sm sm:grid-cols-2">{data.units.map(row=><li key={row.id} className="rounded-md bg-stone-50 p-2">{row.unit_number}: {{available:"verfügbar",reserved:"reserviert",sold:"verkauft",blocked:"gesperrt"}[row.status??""]??row.status}</li>)}</ul>
   <details className="min-w-0 rounded-md border border-stone-200 p-3">
    <summary className="cursor-pointer font-semibold">Übergaben und bestätigte Abschlüsse nachvollziehen</summary>
    <ul className="mt-3 grid gap-2 text-sm">
     {data.handovers.map(row=><li key={row.id} className="break-words rounded-md bg-stone-50 p-2">Übergabe: {data.leads.find(lead=>lead.id===row.lead_id)?.name??"Käufer"} → {data.users.find(user=>user.id===row.recipient_user_id)?.name??"Empfänger"} · {new Date(String(row.created_at)).toLocaleString()} · {String(row.source_reference)}</li>)}
     {data.sales.map(row=><li key={row.id} className="break-words rounded-md bg-emerald-50 p-2">Verkauf: {data.units.find(unit=>unit.id===row.unit_id)?.unit_number??"Einheit"} · bestätigt durch {data.users.find(user=>user.id===row.confirmed_by)?.name??"Projektbevollmächtigten"} · {new Date(String(row.confirmed_at)).toLocaleString()} · {String(row.source_reference)}</li>)}
    </ul>
   </details>
  </form>}
 </details>
}
