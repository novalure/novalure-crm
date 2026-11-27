import assert from "node:assert/strict";
import {test} from "node:test";
import {createPropertyDraftStore,type PropertyDraft} from "../src/lib/property-draft-store";
import {propertyCostAmounts,propertyCostEditorItems,propertyCostEditorLabel,PropertyCostEditingError,type PropertyCostEditorRow} from "../src/lib/property-cost-editing";
import {PROPERTY_COST_TEMPLATES} from "../src/lib/property-department";
import {unitPriceInput} from "../src/lib/property-unit-details";

const row=(extra:Partial<PropertyCostEditorRow["item"]>={}):PropertyCostEditorRow=>({item:{costKey:"operating_costs",label:"SYNTHETIC operating costs",groupKey:"monthly",exposeVisible:false,...extra},amounts:Object.fromEntries(propertyCostAmounts.map(key=>[key,""])) as PropertyCostEditorRow["amounts"]});
const initial=(rows=[row()]):PropertyDraft=>({title:"SYNTHETIC draft",costEditor:{rows,expectedSnapshot:[{id:"SYNTHETIC original cost",updatedAt:"2026-11-04T12:00:00.000Z"}]}} as PropertyDraft);

test("cost draft survives section remount with its original CAS baseline and stays isolated by scope",()=>{
 const store=createPropertyDraftStore("user-a"),key=JSON.stringify(["property-costs","user-a","workspace-a","property-a"]),base=initial();
 const pending=store.update(key,base,previous=>({...previous,costEditor:{...previous.costEditor!,rows:previous.costEditor!.rows.map(item=>({...item,amounts:{...item.amounts,monthlyGrossCents:"15.01"}}))}}));
 // A newly mounted form receives refreshed data, but its pending draft must
 // still compare against the exact records from before the user's edits.
 const fresh=initial();fresh.costEditor!.expectedSnapshot[0].id="SYNTHETIC externally changed cost";
 assert.equal(store.read(key),pending);assert.equal(store.read(key)!.costEditor!.expectedSnapshot[0].id,"SYNTHETIC original cost");
 assert.equal(propertyCostEditorItems(store.read(key)!.costEditor!.rows)[0].monthlyGrossCents,1501);
 for(const scope of [["user-b","workspace-a","property-a"],["user-a","workspace-b","property-a"],["user-a","workspace-a","property-b"]])assert.equal(store.read(JSON.stringify(["property-costs",...scope])),undefined);
 assert.equal(store.hasDrafts(),true);
});

test("new note-only or brochure-selection-only edits cannot be silently omitted and acknowledged",()=>{
 for(const item of [row({internalNote:"SYNTHETIC note"}),row({exposeVisible:true})]){
  const store=createPropertyDraftStore(),base=initial(),pending=store.update("scope",base,{...base,costEditor:{...base.costEditor!,rows:[item]}});
  assert.throws(()=>propertyCostEditorItems(pending.costEditor!.rows),(error:unknown)=>error instanceof PropertyCostEditingError&&error.code==="amount_required");
  assert.equal(store.read("scope"),pending);assert.equal(store.hasDrafts(),true);
  item.amounts.monthlyGrossCents="0";
  const saved=propertyCostEditorItems([item]);assert.equal(saved.length,1);assert.equal(saved[0].monthlyGrossCents,0);assert.equal(saved[0].internalNote,item.item.internalNote);assert.equal(saved[0].exposeVisible,item.item.exposeVisible);
 }
 assert.deepEqual(propertyCostEditorItems([row()]),[]);
});

test("cost payload preserves exact positive and negative cents when only visibility changes",()=>{
 for(const cents of [0,1,-1,35000001,-35000001,Number.MAX_SAFE_INTEGER,-Number.MAX_SAFE_INTEGER]){
  const value=row({id:"SYNTHETIC saved cost",exposeVisible:true});value.amounts.monthlyGrossCents=unitPriceInput(cents,{allowNegative:true});
  assert.equal(propertyCostEditorItems([value])[0].monthlyGrossCents,cents);
 }
 const bad=row();bad.amounts.monthlyGrossCents="broken";assert.throws(()=>propertyCostEditorItems([bad]),(error:unknown)=>error instanceof PropertyCostEditingError&&error.code==="invalid_amount");
});

test("fresh standard cost labels follow EN/ES in display and payload while saved or custom titles stay unchanged",()=>{
 for(const template of PROPERTY_COST_TEMPLATES){
  const fresh=row({costKey:template.key,label:template.label});fresh.amounts.monthlyGrossCents="0";
  for(const language of ["en","es"]){const label=propertyCostEditorLabel(fresh.item,language);assert.notEqual(label,template.label);assert.equal(propertyCostEditorItems([fresh],language)[0].label,label);}
  const saved={...fresh.item,id:"SYNTHETIC saved"};assert.equal(propertyCostEditorLabel(saved,"en"),template.label);
  const custom={...fresh.item,label:"SYNTHETIC custom title"};assert.equal(propertyCostEditorLabel(custom,"es"),custom.label);
 }
});

test("a delayed acknowledgement cannot clear a newer cost draft and the shared mutation lock serializes saves",()=>{
 const store=createPropertyDraftStore(),base=initial();
 const submitted=store.update("scope",base,{...base,costEditor:{...base.costEditor!,rows:[row({internalNote:"first"})]}});
 const lock=store.acquireMutation();assert.ok(lock);assert.equal(store.acquireMutation(),null);
 const newer=store.update("scope",base,previous=>({...previous,costEditor:{...previous.costEditor!,rows:[row({internalNote:"newer"})]}}));
 assert.equal(store.clear("scope",submitted),false);assert.equal(store.read("scope"),newer);
 assert.equal(store.releaseMutation(lock),true);assert.equal(store.clear("scope",newer),true);assert.equal(store.hasDrafts(),false);
});
