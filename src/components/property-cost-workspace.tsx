"use client";

import {useEffect,useState} from "react";
import type {PropertyCostItem,SellerListing} from "@/lib/crm-types";
import {PROPERTY_COST_TEMPLATES} from "@/lib/property-department";
import {createPropertyCoreDraft} from "@/lib/property-core-editing";
import {usePropertyDraft} from "@/lib/use-property-draft";
import type {PropertyDraft,PropertyDraftStore} from "@/lib/property-draft-store";
import {unitPriceInput} from "@/lib/property-unit-details";
import {propertyCostAmounts as amounts,propertyCostEditorItems,propertyCostEditorLabel,PropertyCostEditingError,type PropertyCostAmount as Amount,type PropertyCostEditorRow as Draft} from "@/lib/property-cost-editing";
import {csrfFetch} from "@/lib/security/csrf-client";

type Props={draftStore:PropertyDraftStore;draftUserId:string;listing:SellerListing;workspaceId:string;items:PropertyCostItem[];language:string;canEdit:boolean;onSaved?:()=>void|Promise<void>};
const field="min-h-11 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-base text-slate-950";
export function PropertyCostWorkspace(props:Props){const items=props.items.filter(item=>!item.unitId);return <CostForm key={JSON.stringify([props.workspaceId,props.listing.id,items.map(x=>[x.id,x.updatedAt])])} {...props} items={items}/>;}
function CostForm({listing,workspaceId,items,language,canEdit,onSaved,draftStore,draftUserId}:Props){
 const de=language==="de",es=language==="es",tr=(a:string,b:string,c:string)=>de?a:es?c:b;
 const [initialDraft,setInitialDraft]=useState<PropertyDraft>(()=>{
   const existing=items.map(item=>({item,amounts:Object.fromEntries(amounts.map(key=>[key,unitPriceInput(item[key],{allowNegative:true})])) as Record<Amount,string>}));
   const rows=[...existing,...PROPERTY_COST_TEMPLATES.filter(t=>!items.some(i=>i.costKey===t.key)).map(t=>({item:{costKey:t.key,label:t.label,groupKey:t.groupKey,exposeVisible:false,optional:false,commissionRelevant:t.key.includes("commission")},amounts:Object.fromEntries(amounts.map(key=>[key,""])) as Record<Amount,string>}))];
   return {...createPropertyCoreDraft(listing),costEditor:{rows,expectedSnapshot:items.map(({id,updatedAt})=>({id,updatedAt}))}};
 });
 const {draft,setDraft,clearSubmittedDraft,isDraftDirty:dirty,isMutationBusy:busy,acquireMutation,releaseMutation}=usePropertyDraft(draftStore,JSON.stringify(["property-costs",draftUserId,workspaceId,listing.id]),initialDraft);
 const rows=draft.costEditor!.rows;
 const [notice,setNotice]=useState("");
 useEffect(()=>{const warn=(e:BeforeUnloadEvent)=>{if(dirty){e.preventDefault();e.returnValue="";}};window.addEventListener("beforeunload",warn);return()=>window.removeEventListener("beforeunload",warn);},[dirty]);
 const update=(index:number,change:(row:Draft)=>Draft)=>{setDraft(previous=>({...previous,costEditor:{...previous.costEditor!,rows:previous.costEditor!.rows.map((row,i)=>i===index?change(row):row)}}));};
 async function save(){if(busy||!dirty||!canEdit)return;const mutation=acquireMutation();if(!mutation)return;const submitted=draft;setNotice("");try{
   const costItems=propertyCostEditorItems(rows,language);
   const response=await csrfFetch(`/api/crm/properties?workspaceId=${encodeURIComponent(workspaceId)}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({operation:"save_cost_items",propertyId:listing.id,projectId:listing.projectId,costItems,expectedSnapshot:submitted.costEditor!.expectedSnapshot})});
   const data=await response.json();if(!response.ok||data.persisted!==true)throw new Error(response.status===409?tr("Kosten wurden inzwischen geändert. Bitte neu laden; deine Eingaben bleiben erhalten.","Costs changed. Reload before saving again.","Los gastos han cambiado. Recarga antes de guardar."):data.error||"Speichern fehlgeschlagen");
   clearSubmittedDraft(submitted);setInitialDraft(submitted);setNotice(tr("Kosten gespeichert.","Costs saved.","Gastos guardados."));try{await onSaved?.();}catch{setNotice(tr("Gespeichert. Ansicht bitte neu laden.","Saved. Reload the view.","Guardado. Recarga la vista."));}
 }catch(error){setNotice(error instanceof PropertyCostEditingError
   ? error.code==="amount_required"?tr(`Bitte für „${error.label}“ zuerst einen Betrag eingeben; 0 ist möglich. Deine Eingaben bleiben erhalten.`,`Enter an amount for “${error.label}” first; 0 is allowed. Your entries are retained.`,`Introduce primero un importe para «${error.label}»; se permite 0. Tus cambios se conservan.`)
   :tr("Bitte gültige EUR-Beträge eingeben.","Enter valid EUR amounts.","Introduce importes EUR válidos.")
   :error instanceof Error?error.message:String(error));}finally{releaseMutation(mutation);}}
 const labels=de?["Monatlich netto","Monatliche USt","Monatlich brutto","Einmalig netto","Einmalige USt","Einmalig brutto"]:es?["Mensual neto","IVA mensual","Mensual bruto","Único neto","IVA único","Único bruto"]:["Monthly net","Monthly VAT","Monthly gross","One-time net","One-time VAT","One-time gross"];
 return <section className="my-5 space-y-4 rounded-xl border border-stone-200 bg-white p-5" aria-label={tr("Objektkosten bearbeiten","Edit property costs","Editar gastos")}>
 <h4 className="text-xl font-semibold">{tr("Kosten und Provisionen","Costs and commissions","Gastos y honorarios")}</h4>
 <p className="text-sm text-stone-600">{tr("Beträge in EUR. Nur ausdrücklich ausgewählte Positionen erscheinen im Exposé. Neue Positionen sind zunächst intern.","Amounts in EUR. Only selected items appear in the brochure. New items start private.","Importes en EUR. Solo las partidas seleccionadas aparecen en el dossier. Las partidas nuevas son privadas.")}</p>
 <fieldset disabled={!canEdit||busy} className="space-y-3">{rows.map((row,index)=><details className="rounded-lg border border-stone-200 p-4" key={`${row.item.costKey}:${index}`}><summary className="min-h-11 cursor-pointer font-semibold">{propertyCostEditorLabel(row.item,language)}{row.item.exposeVisible?tr(" · Exposé"," · Brochure"," · Dossier"):""}</summary><div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{amounts.map((key,i)=><label className="text-sm" key={key}>{labels[i]}<input className={field} inputMode="decimal" value={row.amounts[key]} onChange={e=>update(index,r=>({...r,amounts:{...r.amounts,[key]:e.target.value}}))}/></label>)}</div><label className="mt-4 flex min-h-11 items-center gap-3"><input type="checkbox" checked={row.item.exposeVisible===true} onChange={e=>update(index,r=>({...r,item:{...r.item,exposeVisible:e.target.checked}}))}/>{tr("Im Exposé anzeigen","Show in brochure","Mostrar en dossier")}</label><label className="mt-3 block text-sm">{tr("Interne Notiz","Internal note","Nota interna")}<textarea className={field} value={row.item.internalNote??""} onChange={e=>update(index,r=>({...r,item:{...r.item,internalNote:e.target.value}}))}/></label></details>)}</fieldset>
 <p role="status">{notice|| (dirty?tr("Ungespeicherte Änderungen","Unsaved changes","Cambios sin guardar"):"")}</p>
 <button type="button" disabled={!canEdit||!dirty||busy} onClick={()=>void save()} className="min-h-11 rounded-lg bg-slate-950 px-5 py-3 font-semibold text-white disabled:opacity-50">{busy?tr("Speichert …","Saving …","Guardando …"):tr("Kosten speichern","Save costs","Guardar gastos")}</button>
 </section>;
}
