import {parsePropertyEuroCents} from './property-money';
export const leadObjectiveFeatures=['balcony','terrace','garden','garage','cellar'] as const;
export type LeadObjectiveFeature=typeof leadObjectiveFeatures[number];
export const leadObjectiveFeatureLabels:Record<LeadObjectiveFeature,string>={balcony:'Balkon',terrace:'Terrasse',garden:'Garten',garage:'Garage',cellar:'Keller'};
export type LeadFeatureRules=Partial<Record<LeadObjectiveFeature,'must'|'exclude'>>;
export type LeadPurchaseWindow={from:string;to:string};
export type LeadQualificationPreferences={purchaseWindow:LeadPurchaseWindow|null;featureRules:LeadFeatureRules;requirementsReviewed:boolean;version:number};
export type LeadProfileCompleteness={percent:number;complete:boolean;items:{key:string;label:string;complete:boolean;detail:string}[]};
export type LeadNoteSuggestion={fields:Record<string,unknown>;evidence:{field:string;quote:string}[];warnings:string[]};
export class LeadQualificationPlanError extends Error{}
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const fold=(value:string)=>value.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase();
export function normalizeLeadPurchaseWindow(value:unknown):LeadPurchaseWindow|null{
 if(value===null||value===undefined)return null;if(!plain(value)||Object.keys(value).some(key=>!['from','to'].includes(key)))throw new LeadQualificationPlanError('Kaufzeitfenster mit Anfang und Ende erforderlich.');
 const valid=(input:unknown)=>typeof input==='string'&&/^20\d{2}-\d{2}-\d{2}$/.test(input)&&Number.isFinite(Date.parse(`${input}T00:00:00Z`))&&new Date(`${input}T00:00:00Z`).toISOString().slice(0,10)===input;
 if(!valid(value.from)||!valid(value.to)||String(value.from)>String(value.to))throw new LeadQualificationPlanError('Gültiges Kaufzeitfenster mit Anfang vor Ende erforderlich.');return{from:String(value.from),to:String(value.to)};
}
export function normalizeLeadFeatureRules(value:unknown):LeadFeatureRules{
 if(!plain(value)||Object.keys(value).length>5)throw new LeadQualificationPlanError('Objektive Merkmale sind ungültig.');const result:LeadFeatureRules={};
 for(const[key,rule]of Object.entries(value)){if(!(leadObjectiveFeatures as readonly string[]).includes(key)||!['must','exclude'].includes(String(rule)))throw new LeadQualificationPlanError('Nur angebotene objektive Objektmerkmale können verglichen werden.');result[key as LeadObjectiveFeature]=rule as'must'|'exclude';}return result;
}
export function leadQualificationDay(countryCode:string,at=new Date()){
 const zone=countryCode==='IE'?'Europe/Dublin':countryCode==='ES'?'Europe/Madrid':countryCode==='DE'?'Europe/Berlin':'Europe/Vienna';return new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(at);
}
export function leadPurchaseWindowExpired(profile:{countryCode:string;purchaseWindow?:LeadPurchaseWindow|null},at=new Date()){return!!profile.purchaseWindow&&profile.purchaseWindow.to<leadQualificationDay(profile.countryCode,at);}
export function leadProfileCompleteness(profile:{countryCode:string;location:string;propertyType:string;budgetFromCents:number;budgetToCents:number;purchaseWindow?:LeadPurchaseWindow|null;requirementsReviewed?:boolean},at=new Date()):LeadProfileCompleteness{
 const items=[{key:'country',label:'Gesuchtes Land',complete:['AT','DE','ES','IE'].includes(profile.countryCode),detail:'Ein ausdrücklich gewähltes Objektland.'},{key:'location',label:'Ort oder Region',complete:!!profile.location.trim(),detail:'Gewünschte Orte oder Regionen sind benannt.'},{key:'type',label:'Objektart',complete:!!profile.propertyType,detail:'Die gewünschte Objektart ist gespeichert.'},{key:'budget',label:'Kaufbudget',complete:Number.isSafeInteger(profile.budgetFromCents)&&Number.isSafeInteger(profile.budgetToCents)&&profile.budgetFromCents>=0&&profile.budgetToCents>0&&profile.budgetToCents>=profile.budgetFromCents,detail:'Vollständige gültige Kaufbudgetspanne.'},{key:'window',label:'Kaufzeitfenster',complete:!!profile.purchaseWindow&&!leadPurchaseWindowExpired(profile,at),detail:leadPurchaseWindowExpired(profile,at)?'Das gespeicherte Zeitfenster ist abgelaufen; erneut abstimmen.':'Konkretes Anfangs- und Enddatum; keine erratene Frist.'},{key:'requirements',label:'Muss- und Ausschlussmerkmale geprüft',complete:profile.requirementsReviewed===true,detail:'Auch keine weiteren harten Merkmale wird ausdrücklich bestätigt.'}];return{items,percent:Math.round(items.filter(item=>item.complete).length*100/items.length),complete:items.every(item=>item.complete)};
}
/** Only explicit supported field statements are proposed. Personal traits never become matching criteria. */
export function suggestLeadProfileFromNote(note:string):LeadNoteSuggestion{
 const fields:Record<string,unknown>={},evidence:LeadNoteSuggestion['evidence']=[],warnings:string[]=[],blocked=new Set<string>(),blockedFeatures=new Set<string>();const set=(field:string,value:unknown,quote:string)=>{if(blocked.has(field))return;if(field in fields){delete fields[field];blocked.add(field);warnings.push(`Mehrere Angaben für ${field}; manuell klären.`);return;}fields[field]=value;evidence.push({field,quote:quote.slice(0,300)});};
 for(const raw of note.split(/\r?\n|;/).slice(0,50)){const line=raw.trim();let match:RegExpExecArray|null;
  if((match=/^(?:Budget|Presupuesto)\s*:\s*(.+?)\s+(?:bis|to|a|–|-)\s+(.+?)\s*(?:EUR|€)\s*$/i.exec(line))){const from=parsePropertyEuroCents(match[1]),to=parsePropertyEuroCents(match[2]);if(from!==null&&to!==null&&to>0&&from<=to){set('budgetFromCents',from,line);set('budgetToCents',to,line);}else warnings.push('Budgetangabe ist nicht eindeutig.');}
  if((match=/^(?:Land|Country|Pais|País)\s*:\s*(AT|DE|ES|IE)\s*$/i.exec(line)))set('countryCode',match[1].toUpperCase(),line);
  if((match=/^(?:Ort|Region|City|Ciudad)\s*:\s*(.{1,300})$/i.exec(line)))set('location',match[1].trim(),line);
  if((match=/^(?:Objektart|Property type|Tipo)\s*:\s*(.+)$/i.exec(line))){const types:Record<string,string>={wohnung:'Wohnung',apartment:'Wohnung',piso:'Wohnung',haus:'Haus',house:'Haus',casa:'Haus',neubau:'Neubau',zinshaus:'Zinshaus',gewerbe:'Gewerbe',grundstuck:'Grundstück',portfolio:'Portfolio'};const type=types[fold(match[1])];if(type)set('propertyType',type,line);}
  if((match=/^(?:Kaufabschluss|Kaufzeitfenster|Purchase window|Ventana de compra)\s*:\s*(20\d{2}-\d{2}-\d{2})\s+(?:bis|to|a|–|-)\s+(20\d{2}-\d{2}-\d{2})\s*$/i.exec(line))){try{set('purchaseWindow',normalizeLeadPurchaseWindow({from:match[1],to:match[2]}),line);}catch{warnings.push('Zeitfenster ist nicht gültig.');}}
  if((match=/^(Muss|Must|Imprescindible|Ausschluss|Exclude|Excluir)\s*:\s*(.+)$/i.exec(line))){const rule=/^(Ausschluss|Exclude|Excluir)$/i.test(match[1])?'exclude':'must',aliases:Record<string,LeadObjectiveFeature>={balkon:'balcony',balcony:'balcony',balcon:'balcony',terrasse:'terrace',terrace:'terrace',terraza:'terrace',garten:'garden',garden:'garden',jardin:'garden',garage:'garage',garaje:'garage',keller:'cellar',cellar:'cellar',sotano:'cellar'},rules=(fields.featureRules??{}) as LeadFeatureRules;for(const name of match[2].split(',')){const feature=aliases[fold(name)];if(!feature){warnings.push(`Nicht unterstütztes Objektmerkmal: ${name.trim().slice(0,60)}.`);continue;}if(blockedFeatures.has(feature))continue;if(rules[feature]&&rules[feature]!==rule){delete rules[feature];blockedFeatures.add(feature);warnings.push(`Widerspruch bei ${leadObjectiveFeatureLabels[feature]}; manuell klären.`);}else rules[feature]=rule;}if(Object.keys(rules).length){fields.featureRules=rules;evidence.push({field:'featureRules',quote:line.slice(0,300)});}else delete fields.featureRules;}
 }
 return{fields,evidence,warnings};
}
