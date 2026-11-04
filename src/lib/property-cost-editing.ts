import type {PropertyCostItem} from "./crm-types";
import {parsePropertyEuroCents} from "./property-money";
import {PROPERTY_COST_TEMPLATES} from "./property-department";
export const propertyCostAmounts=["monthlyNetCents","monthlyVatCents","monthlyGrossCents","oneTimeNetCents","oneTimeVatCents","oneTimeGrossCents"] as const;
export type PropertyCostAmount=typeof propertyCostAmounts[number];
export type PropertyCostEditorRow={item:Partial<PropertyCostItem>&{costKey:string;label:string;groupKey:string};amounts:Record<PropertyCostAmount,string>};
export type PropertyCostEditorDraft={rows:PropertyCostEditorRow[];expectedSnapshot:{id:string;updatedAt:string}[]};

const costLabels:Record<string,readonly [string,string]>={
 operating_costs:["Operating costs","Gastos corrientes"],heating_costs:["Heating costs","Gastos de calefacción"],repair_reserve:["Reserve fund","Fondo de reserva"],other_monthly:["Other monthly costs","Otros gastos mensuales"],
 transfer_tax:["Property transfer tax","Impuesto de transmisión"],land_register_fee:["Land registration","Inscripción registral"],contract_setup:["Contract preparation","Preparación del contrato"],broker_commission_purchase:["Purchase commission","Honorarios de compra"],
 deposit:["Deposit","Fianza"],stamp_duty:["Stamp duty","Impuesto de timbre"],broker_commission_rent:["Rental commission","Honorarios de alquiler"],
};

/** Localize fresh standard templates, never rewrite an existing/custom title. */
export function propertyCostEditorLabel(item:PropertyCostEditorRow["item"],language="de"):string {
 if(item.id)return item.label;
 const template=PROPERTY_COST_TEMPLATES.find(value=>value.key===item.costKey),labels=costLabels[item.costKey];
 if(!template||!labels||![template.label,...labels].includes(item.label))return item.label;
 return language==="de"?template.label:labels[language==="es"?1:0];
}

export class PropertyCostEditingError extends Error {
 constructor(readonly code:"amount_required"|"invalid_amount",readonly label:string){super(code);}
}

/** Do not acknowledge and discard metadata edits to a new, still unpriced row. */
export function propertyCostEditorItems(rows:PropertyCostEditorRow[],language="de") {
 return rows.filter(row=>{
  const hasAmount=propertyCostAmounts.some(key=>row.amounts[key].trim());
  if(!row.item.id&&!hasAmount&&(row.item.exposeVisible===true||Boolean(row.item.internalNote?.trim()))) throw new PropertyCostEditingError("amount_required",propertyCostEditorLabel(row.item,language));
  return Boolean(row.item.id)||hasAmount;
 }).map(row=>({
  ...row.item,
  label:propertyCostEditorLabel(row.item,language),
  ...Object.fromEntries(propertyCostAmounts.map(key=>{
   const value=row.amounts[key].trim()?parsePropertyEuroCents(row.amounts[key],{allowNegative:true}):0;
   if(value===null)throw new PropertyCostEditingError("invalid_amount",row.item.label);
   return [key,value];
  })),
 }));
}
